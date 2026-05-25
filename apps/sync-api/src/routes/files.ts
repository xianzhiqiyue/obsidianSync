import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { appConfig } from "../config.js";
import { query, withTransaction } from "../db.js";
import type { ObjectStore } from "../object-store.js";

const MAX_SERVER_FILE_BYTES = 5 * 1024 * 1024;

const contentHashSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "contentHash must be sha256:<64 lowercase hex chars>");

const vaultParamsSchema = z.object({
  vaultId: z.string().uuid()
});

const listQuerySchema = z.object({
  prefix: z.string().max(4096).optional(),
  limit: z.coerce.number().int().positive().max(1000).default(200),
  cursor: z.string().optional(),
  includeDeleted: z.coerce.boolean().default(false)
});

const readQuerySchema = z.object({
  includeDownloadUrl: z.coerce.boolean().default(false)
});

const writeBodySchema = z.object({
  contentBase64: z.string().min(1),
  baseVersion: z.number().int().nonnegative().optional(),
  idempotencyKey: z.string().uuid(),
  conflictStrategy: z.literal("fail").default("fail")
});

const deleteBodySchema = z.object({
  baseVersion: z.number().int().nonnegative().optional(),
  idempotencyKey: z.string().uuid()
});

interface VaultOwnershipRow {
  id: string;
}

interface CheckpointRow {
  latest_checkpoint: string;
}

interface FileMetadataRow {
  id: string;
  current_path: string;
  head_version: number;
  deleted_at: Date | null;
  created_at: Date;
  content_hash: string;
  version_created_at: Date;
}

interface IdempotencyRow {
  response_json: FileWriteResponse;
}

interface FileWriteResponse {
  fileId: string;
  path: string;
  version: number;
  contentHash: string;
  checkpoint: string;
  changesetId: string;
  op: "create" | "update" | "delete";
}

function sendZodError(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }, code: string, error: z.ZodError) {
  return reply.code(400).send({ code, message: error.flatten() });
}

async function assertVaultOwnership(vaultId: string, userId: string): Promise<boolean> {
  const result = await query<VaultOwnershipRow>(
    "SELECT id FROM vaults WHERE id = $1 AND owner_user_id = $2 LIMIT 1",
    [vaultId, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

function parseVaultParams(
  request: { params: unknown },
  reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }
): { vaultId: string } | null {
  const parsed = vaultParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    sendZodError(reply, "INVALID_PARAMS", parsed.error);
    return null;
  }
  return parsed.data;
}

function parsePathParam(params: unknown): string | null {
  const raw = (params as { "*"?: unknown })["*"];
  if (typeof raw !== "string") {
    return null;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function validateVaultPath(path: string): string | null {
  if (path.length === 0) return "path must not be empty";
  if (path.length > 4096) return "path is too long";
  if (path.startsWith("/")) return "path must be relative";
  if (path.includes("\\")) return "path must use forward slashes";
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "path contains invalid segments";
  }
  return null;
}

function parseOffsetCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number(cursor);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function toCheckpoint(value: number | string): string {
  return `cp_${Number(value)}`;
}

function formatFile(row: FileMetadataRow) {
  return {
    fileId: row.id,
    path: row.current_path,
    version: row.head_version,
    contentHash: row.content_hash,
    deleted: row.deleted_at !== null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.version_created_at.toISOString()
  };
}

async function ensureCheckpointRow(vaultId: string): Promise<number> {
  await query(
    "INSERT INTO vault_sync_state (vault_id, latest_checkpoint) VALUES ($1, 0) ON CONFLICT (vault_id) DO NOTHING",
    [vaultId]
  );
  const result = await query<CheckpointRow>(
    "SELECT latest_checkpoint FROM vault_sync_state WHERE vault_id = $1",
    [vaultId]
  );
  return Number(result.rows[0]?.latest_checkpoint ?? 0);
}

async function getActiveFileByPath(vaultId: string, path: string): Promise<FileMetadataRow | null> {
  const result = await query<FileMetadataRow>(
    `SELECT fe.id, fe.current_path, fe.head_version, fe.deleted_at, fe.created_at,
            fv.content_hash, fv.created_at AS version_created_at
     FROM file_entries fe
     JOIN LATERAL (
       SELECT content_hash, created_at
       FROM file_versions
       WHERE file_id = fe.id
       ORDER BY version DESC
       LIMIT 1
     ) fv ON TRUE
     WHERE fe.vault_id = $1
       AND fe.current_path = $2
       AND fe.deleted_at IS NULL
     LIMIT 1`,
    [vaultId, path]
  );
  return result.rows[0] ?? null;
}

async function getExistingIdempotency(vaultId: string, idempotencyKey: string): Promise<FileWriteResponse | null> {
  const result = await query<IdempotencyRow>(
    `SELECT response_json
     FROM idempotency_keys
     WHERE vault_id = $1 AND idempotency_key = $2
     LIMIT 1`,
    [vaultId, idempotencyKey]
  );
  return result.rows[0]?.response_json ?? null;
}

function decodeBase64Bytes(value: string): Buffer | null {
  try {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length === 0 || bytes.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
      return null;
    }
    return bytes;
  } catch {
    return null;
  }
}

function hashBytes(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function ensureObjectStored(objectStore: ObjectStore, contentHash: string, bytes: Buffer): Promise<void> {
  if (await objectStore.objectExists(contentHash)) {
    return;
  }
  await objectStore.putObjectBytes(contentHash, bytes);
}

export default function fileRoutes(objectStore: ObjectStore) {
  return async function registerFileRoutes(app: FastifyInstance): Promise<void> {
    app.get("/vaults/:vaultId/files", async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;

      const params = parseVaultParams(request, reply);
      if (!params) return;
      if (!(await assertVaultOwnership(params.vaultId, auth.userId))) {
        return reply.code(404).send({ code: "VAULT_NOT_FOUND", message: "vault not found" });
      }

      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendZodError(reply, "INVALID_REQUEST", parsed.error);
      }
      const { prefix, limit, includeDeleted } = parsed.data;
      const offset = parseOffsetCursor(parsed.data.cursor);
      const checkpoint = await ensureCheckpointRow(params.vaultId);

      const values: unknown[] = [params.vaultId];
      const where = ["fe.vault_id = $1"];
      if (!includeDeleted) {
        where.push("fe.deleted_at IS NULL");
      }
      if (prefix) {
        values.push(`${prefix}%`);
        where.push(`fe.current_path LIKE $${values.length}`);
      }
      values.push(limit + 1, offset);
      const limitParam = values.length - 1;
      const offsetParam = values.length;

      const result = await query<FileMetadataRow>(
        `SELECT fe.id, fe.current_path, fe.head_version, fe.deleted_at, fe.created_at,
                fv.content_hash, fv.created_at AS version_created_at
         FROM file_entries fe
         JOIN LATERAL (
           SELECT content_hash, created_at
           FROM file_versions
           WHERE file_id = fe.id
           ORDER BY version DESC
           LIMIT 1
         ) fv ON TRUE
         WHERE ${where.join(" AND ")}
         ORDER BY fe.current_path ASC, fe.id ASC
         LIMIT $${limitParam} OFFSET $${offsetParam}`,
        values
      );

      const hasMore = result.rows.length > limit;
      const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
      return reply.send({
        checkpoint: toCheckpoint(checkpoint),
        items: rows.map(formatFile),
        nextCursor: hasMore ? String(offset + limit) : null
      });
    });

    app.get("/vaults/:vaultId/files/by-path/*", async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;

      const params = parseVaultParams(request, reply);
      if (!params) return;
      if (!(await assertVaultOwnership(params.vaultId, auth.userId))) {
        return reply.code(404).send({ code: "VAULT_NOT_FOUND", message: "vault not found" });
      }

      const path = parsePathParam(request.params);
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path is required" });
      }
      const pathError = validateVaultPath(path);
      if (pathError) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: pathError });
      }
      const parsed = readQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendZodError(reply, "INVALID_REQUEST", parsed.error);
      }

      const file = await getActiveFileByPath(params.vaultId, path);
      if (!file) {
        return reply.code(404).send({ code: "FILE_NOT_FOUND", message: "file not found" });
      }
      const payload: { file: ReturnType<typeof formatFile>; downloadUrl?: string } = {
        file: formatFile(file)
      };
      if (parsed.data.includeDownloadUrl) {
        payload.downloadUrl = await objectStore.createDownloadUrl(file.content_hash);
      }
      return reply.send(payload);
    });

    app.put("/vaults/:vaultId/files/by-path/*", async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;

      const params = parseVaultParams(request, reply);
      if (!params) return;
      const { vaultId } = params;
      if (!(await assertVaultOwnership(vaultId, auth.userId))) {
        return reply.code(404).send({ code: "VAULT_NOT_FOUND", message: "vault not found" });
      }

      const path = parsePathParam(request.params);
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path is required" });
      }
      const pathError = validateVaultPath(path);
      if (pathError) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: pathError });
      }

      const parsed = writeBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendZodError(reply, "INVALID_REQUEST", parsed.error);
      }

      const existing = await getExistingIdempotency(vaultId, parsed.data.idempotencyKey);
      if (existing) {
        return reply.send(existing);
      }

      const bytes = decodeBase64Bytes(parsed.data.contentBase64);
      if (!bytes) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "contentBase64 is invalid" });
      }
      if (bytes.length > MAX_SERVER_FILE_BYTES) {
        return reply.code(413).send({ code: "FILE_TOO_LARGE", message: "file exceeds server-side write limit" });
      }
      const contentHash = hashBytes(bytes);
      if (!contentHashSchema.safeParse(contentHash).success) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "invalid content hash" });
      }
      await ensureObjectStored(objectStore, contentHash, bytes);

      try {
        const response = await withTransaction(async (client) => {
          await client.query(
            "INSERT INTO vault_sync_state (vault_id, latest_checkpoint) VALUES ($1, 0) ON CONFLICT (vault_id) DO NOTHING",
            [vaultId]
          );
          const checkpointResult = await client.query<CheckpointRow>(
            "SELECT latest_checkpoint FROM vault_sync_state WHERE vault_id = $1 FOR UPDATE",
            [vaultId]
          );
          const currentCheckpoint = Number(checkpointResult.rows[0]?.latest_checkpoint ?? 0);

          const fileResult = await client.query<FileMetadataRow>(
            `SELECT fe.id, fe.current_path, fe.head_version, fe.deleted_at, fe.created_at,
                    fv.content_hash, fv.created_at AS version_created_at
             FROM file_entries fe
             LEFT JOIN LATERAL (
               SELECT content_hash, created_at
               FROM file_versions
               WHERE file_id = fe.id
               ORDER BY version DESC
               LIMIT 1
             ) fv ON TRUE
             WHERE fe.vault_id = $1
               AND fe.current_path = $2
               AND fe.deleted_at IS NULL
             FOR UPDATE OF fe
             LIMIT 1`,
            [vaultId, path]
          );
          const file = fileResult.rows[0] ?? null;

          if (file && parsed.data.baseVersion !== undefined && file.head_version !== parsed.data.baseVersion) {
            throw Object.assign(new Error("version conflict"), {
              statusCode: 409,
              response: {
                code: "VERSION_CONFLICT",
                message: `baseVersion ${parsed.data.baseVersion} does not match headVersion ${file.head_version}`,
                headVersion: file.head_version,
                fileId: file.id,
                path
              }
            });
          }

          if (file && file.content_hash === contentHash) {
            const responseBody: FileWriteResponse = {
              fileId: file.id,
              path,
              version: file.head_version,
              contentHash,
              checkpoint: toCheckpoint(currentCheckpoint),
              changesetId: "",
              op: "update"
            };
            await client.query(
              `INSERT INTO idempotency_keys (vault_id, idempotency_key, response_json)
               VALUES ($1, $2, $3::jsonb)`,
              [vaultId, parsed.data.idempotencyKey, JSON.stringify(responseBody)]
            );
            return responseBody;
          }

          await client.query(
            "INSERT INTO object_blobs (content_hash, size_bytes) VALUES ($1, $2) ON CONFLICT (content_hash) DO NOTHING",
            [contentHash, bytes.length]
          );

          const nextCheckpoint = currentCheckpoint + 1;
          const changesetResult = await client.query<{ id: string }>(
            `INSERT INTO changesets (vault_id, device_id, checkpoint, status)
             VALUES ($1, $2, $3, 'committed')
             RETURNING id`,
            [vaultId, auth.deviceId, nextCheckpoint]
          );
          const changesetId = changesetResult.rows[0]?.id;
          if (!changesetId) {
            throw new Error("failed to create changeset");
          }

          let fileId: string;
          let version: number;
          let op: "create" | "update";
          if (!file) {
            const created = await client.query<{ id: string }>(
              `INSERT INTO file_entries (vault_id, current_path, head_version, deleted_at)
               VALUES ($1, $2, 1, NULL)
               RETURNING id`,
              [vaultId, path]
            );
            fileId = created.rows[0]!.id;
            version = 1;
            op = "create";
          } else {
            fileId = file.id;
            version = file.head_version + 1;
            op = "update";
            await client.query(
              `UPDATE file_entries
               SET head_version = $1, current_path = $2, deleted_at = NULL
               WHERE id = $3`,
              [version, path, fileId]
            );
          }

          await client.query(
            `INSERT INTO file_versions (file_id, version, content_hash, author_device_id)
             VALUES ($1, $2, $3, $4)`,
            [fileId, version, contentHash, auth.deviceId]
          );
          await client.query(
            `INSERT INTO change_events (vault_id, changeset_id, checkpoint, op, file_id, path, version, content_hash)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [vaultId, changesetId, nextCheckpoint, op, fileId, path, version, contentHash]
          );
          await client.query(
            "UPDATE vault_sync_state SET latest_checkpoint = $1, updated_at = NOW() WHERE vault_id = $2",
            [nextCheckpoint, vaultId]
          );

          const responseBody: FileWriteResponse = {
            fileId,
            path,
            version,
            contentHash,
            checkpoint: toCheckpoint(nextCheckpoint),
            changesetId,
            op
          };
          await client.query(
            `INSERT INTO idempotency_keys (vault_id, idempotency_key, response_json)
             VALUES ($1, $2, $3::jsonb)`,
            [vaultId, parsed.data.idempotencyKey, JSON.stringify(responseBody)]
          );
          return responseBody;
        });
        return reply.send(response);
      } catch (error) {
        const maybe = error as { statusCode?: number; response?: unknown };
        if (maybe.statusCode && maybe.response) {
          return reply.code(maybe.statusCode).send(maybe.response);
        }
        request.log.error({ err: error }, "server-side file write failed");
        const message = appConfig.env === "development" && error instanceof Error ? error.message : "file write failed";
        return reply.code(409).send({ code: "FILE_WRITE_FAILED", message });
      }
    });

    app.delete("/vaults/:vaultId/files/by-path/*", async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;

      const params = parseVaultParams(request, reply);
      if (!params) return;
      const { vaultId } = params;
      if (!(await assertVaultOwnership(vaultId, auth.userId))) {
        return reply.code(404).send({ code: "VAULT_NOT_FOUND", message: "vault not found" });
      }

      const path = parsePathParam(request.params);
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path is required" });
      }
      const pathError = validateVaultPath(path);
      if (pathError) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: pathError });
      }

      const parsed = deleteBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendZodError(reply, "INVALID_REQUEST", parsed.error);
      }

      const existing = await getExistingIdempotency(vaultId, parsed.data.idempotencyKey);
      if (existing) {
        return reply.send(existing);
      }

      try {
        const response = await withTransaction(async (client) => {
          await client.query(
            "INSERT INTO vault_sync_state (vault_id, latest_checkpoint) VALUES ($1, 0) ON CONFLICT (vault_id) DO NOTHING",
            [vaultId]
          );
          const checkpointResult = await client.query<CheckpointRow>(
            "SELECT latest_checkpoint FROM vault_sync_state WHERE vault_id = $1 FOR UPDATE",
            [vaultId]
          );
          const currentCheckpoint = Number(checkpointResult.rows[0]?.latest_checkpoint ?? 0);
          const fileResult = await client.query<FileMetadataRow>(
            `SELECT fe.id, fe.current_path, fe.head_version, fe.deleted_at, fe.created_at,
                    fv.content_hash, fv.created_at AS version_created_at
             FROM file_entries fe
             JOIN LATERAL (
               SELECT content_hash, created_at
               FROM file_versions
               WHERE file_id = fe.id
               ORDER BY version DESC
               LIMIT 1
             ) fv ON TRUE
             WHERE fe.vault_id = $1
               AND fe.current_path = $2
               AND fe.deleted_at IS NULL
             FOR UPDATE OF fe
             LIMIT 1`,
            [vaultId, path]
          );
          const file = fileResult.rows[0] ?? null;
          if (!file) {
            throw Object.assign(new Error("file not found"), {
              statusCode: 404,
              response: { code: "FILE_NOT_FOUND", message: "file not found" }
            });
          }
          if (parsed.data.baseVersion !== undefined && file.head_version !== parsed.data.baseVersion) {
            throw Object.assign(new Error("version conflict"), {
              statusCode: 409,
              response: {
                code: "VERSION_CONFLICT",
                message: `baseVersion ${parsed.data.baseVersion} does not match headVersion ${file.head_version}`,
                headVersion: file.head_version,
                fileId: file.id,
                path
              }
            });
          }

          const nextCheckpoint = currentCheckpoint + 1;
          const changesetResult = await client.query<{ id: string }>(
            `INSERT INTO changesets (vault_id, device_id, checkpoint, status)
             VALUES ($1, $2, $3, 'committed')
             RETURNING id`,
            [vaultId, auth.deviceId, nextCheckpoint]
          );
          const changesetId = changesetResult.rows[0]?.id;
          if (!changesetId) {
            throw new Error("failed to create changeset");
          }

          const nextVersion = file.head_version + 1;
          await client.query("UPDATE file_entries SET head_version = $1, deleted_at = NOW() WHERE id = $2", [
            nextVersion,
            file.id
          ]);
          await client.query(
            `INSERT INTO file_versions (file_id, version, content_hash, author_device_id)
             VALUES ($1, $2, $3, $4)`,
            [file.id, nextVersion, file.content_hash, auth.deviceId]
          );
          await client.query(
            `INSERT INTO tombstones (vault_id, file_id, deleted_at, expire_at)
             VALUES ($1, $2, NOW(), NOW() + ($3 * INTERVAL '1 day'))`,
            [vaultId, file.id, appConfig.tombstoneRetentionDays]
          );
          await client.query(
            `INSERT INTO change_events (vault_id, changeset_id, checkpoint, op, file_id, path, version, content_hash)
             VALUES ($1, $2, $3, 'delete', $4, $5, $6, $7)`,
            [vaultId, changesetId, nextCheckpoint, file.id, path, nextVersion, file.content_hash]
          );
          await client.query("UPDATE vault_sync_state SET latest_checkpoint = $1, updated_at = NOW() WHERE vault_id = $2", [
            nextCheckpoint,
            vaultId
          ]);

          const responseBody: FileWriteResponse = {
            fileId: file.id,
            path,
            version: nextVersion,
            contentHash: file.content_hash,
            checkpoint: toCheckpoint(nextCheckpoint),
            changesetId,
            op: "delete"
          };
          await client.query(
            `INSERT INTO idempotency_keys (vault_id, idempotency_key, response_json)
             VALUES ($1, $2, $3::jsonb)`,
            [vaultId, parsed.data.idempotencyKey, JSON.stringify(responseBody)]
          );
          return responseBody;
        });
        return reply.send(response);
      } catch (error) {
        const maybe = error as { statusCode?: number; response?: unknown };
        if (maybe.statusCode && maybe.response) {
          return reply.code(maybe.statusCode).send(maybe.response);
        }
        request.log.error({ err: error }, "server-side file delete failed");
        const message = appConfig.env === "development" && error instanceof Error ? error.message : "file delete failed";
        return reply.code(409).send({ code: "FILE_DELETE_FAILED", message });
      }
    });
  };
}
