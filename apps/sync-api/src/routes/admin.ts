import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { appConfig } from "../config.js";
import { query, withTransaction } from "../db.js";
import type { ObjectStore } from "../object-store.js";
import { publishSyncCheckpoint } from "../sync-events.js";

const uuidSchema = z.string().uuid();
const vaultParamsSchema = z.object({ vaultId: uuidSchema });
const fileParamsSchema = z.object({ vaultId: uuidSchema, fileId: uuidSchema });
const fileVersionParamsSchema = z.object({ vaultId: uuidSchema, fileId: uuidSchema, version: z.coerce.number().int().positive() });

const filesQuerySchema = z.object({
  query: z.string().max(4096).optional(),
  status: z.enum(["active", "deleted", "all"]).default("all"),
  limit: z.coerce.number().int().positive().max(200).default(50),
  cursor: z.coerce.number().int().nonnegative().default(0)
});

const operationsQuerySchema = z.object({
  fileId: uuidSchema.optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  cursor: z.coerce.number().int().nonnegative().default(0)
});

const previewBodySchema = z.object({
  action: z.enum(["restore", "set_current_version", "soft_delete"]),
  version: z.number().int().positive().optional(),
  targetPath: z.string().min(1).max(4096).optional()
});

const executeVersionBodySchema = z.object({
  version: z.number().int().positive(),
  targetPath: z.string().min(1).max(4096),
  reason: z.string().min(3).max(1000),
  confirmToken: z.string().min(1)
});

const executeDeleteBodySchema = z.object({
  reason: z.string().min(3).max(1000),
  confirmToken: z.string().min(1)
});

interface VaultRow {
  id: string;
  name: string;
  created_at: Date;
  file_count: string;
  deleted_file_count: string;
  latest_checkpoint: string | null;
  latest_event_at: Date | null;
}

interface FileListRow {
  id: string;
  current_path: string;
  head_version: number;
  deleted_at: Date | null;
  created_at: Date;
  latest_checkpoint: string | null;
  updated_at: Date | null;
  latest_content_hash: string | null;
  version_count: string;
}

interface FileEntryRow {
  id: string;
  vault_id: string;
  current_path: string;
  head_version: number;
  deleted_at: Date | null;
  created_at: Date;
}

interface FileVersionRow {
  id: string;
  version: number;
  content_hash: string;
  author_device_id: string | null;
  author_device_name: string | null;
  author_platform: string | null;
  created_at: Date;
  mtime_ms: string | null;
  ctime_ms: string | null;
}

interface ChangeEventRow {
  id: string;
  checkpoint: string;
  op: string;
  path: string;
  version: number;
  content_hash: string;
  source: string;
  reason: string | null;
  admin_operation_id: string | null;
  created_at: Date;
}

interface TombstoneRow {
  id: string;
  deleted_at: Date;
  expire_at: Date;
}

interface AdminOperationRow {
  id: string;
  operation: string;
  status: string;
  file_id: string | null;
  before_json: unknown;
  after_json: unknown | null;
  reason: string;
  changeset_id: string | null;
  created_at: Date;
}

interface CheckpointRow {
  latest_checkpoint: string;
}

interface PreviewTokenPayload {
  type: "admin-preview";
  sub: string;
  deviceId: string;
  vaultId: string;
  fileId: string;
  action: "restore" | "set_current_version" | "soft_delete";
  version?: number;
  targetPath?: string;
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

async function assertVaultOwnership(vaultId: string, userId: string): Promise<boolean> {
  const result = await query<{ id: string }>(
    "SELECT id FROM vaults WHERE id = $1 AND owner_user_id = $2 LIMIT 1",
    [vaultId, userId]
  );
  return (result.rowCount ?? 0) > 0;
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

async function getFile(vaultId: string, fileId: string): Promise<FileEntryRow | null> {
  const result = await query<FileEntryRow>(
    `SELECT id, vault_id, current_path, head_version, deleted_at, created_at
     FROM file_entries
     WHERE vault_id = $1 AND id = $2
     LIMIT 1`,
    [vaultId, fileId]
  );
  return result.rows[0] ?? null;
}

async function getVersion(fileId: string, version: number): Promise<FileVersionRow | null> {
  const result = await query<FileVersionRow>(
    `SELECT fv.id, fv.version, fv.content_hash, fv.author_device_id, d.device_name AS author_device_name,
            d.platform AS author_platform, fv.created_at, fv.mtime_ms, fv.ctime_ms
     FROM file_versions fv
     LEFT JOIN devices d ON d.id = fv.author_device_id
     WHERE fv.file_id = $1 AND fv.version = $2
     LIMIT 1`,
    [fileId, version]
  );
  return result.rows[0] ?? null;
}

async function findPathConflict(vaultId: string, path: string, fileId: string): Promise<string | null> {
  const result = await query<{ id: string }>(
    `SELECT id
     FROM file_entries
     WHERE vault_id = $1
       AND current_path = $2
       AND deleted_at IS NULL
       AND id <> $3
     LIMIT 1`,
    [vaultId, path, fileId]
  );
  return result.rows[0]?.id ?? null;
}

function serializeFile(file: FileEntryRow): Record<string, unknown> {
  return {
    fileId: file.id,
    vaultId: file.vault_id,
    path: file.current_path,
    headVersion: file.head_version,
    deleted: file.deleted_at !== null,
    deletedAt: toIso(file.deleted_at),
    createdAt: file.created_at.toISOString()
  };
}

function makePreviewResponse(args: {
  app: FastifyInstance;
  userId: string;
  deviceId: string;
  vaultId: string;
  file: FileEntryRow;
  action: "restore" | "set_current_version" | "soft_delete";
  version?: FileVersionRow;
  targetPath?: string;
  pathConflictFileId?: string | null;
  latestCheckpoint: number;
}) {
  const confirmToken = args.app.jwt.sign(
    {
      type: "admin-preview",
      sub: args.userId,
      deviceId: args.deviceId,
      vaultId: args.vaultId,
      fileId: args.file.id,
      action: args.action,
      version: args.version?.version,
      targetPath: args.targetPath
    } satisfies PreviewTokenPayload,
    { expiresIn: 600 }
  );

  return {
    previewId: `preview_${randomUUID()}`,
    confirmToken,
    action: args.action,
    fileId: args.file.id,
    current: serializeFile(args.file),
    target: args.version
      ? {
          version: args.version.version,
          contentHash: args.version.content_hash,
          createdAt: args.version.created_at.toISOString(),
          mtimeMs: toNumber(args.version.mtime_ms),
          ctimeMs: toNumber(args.version.ctime_ms),
          path: args.targetPath ?? args.file.current_path
        }
      : null,
    pathConflict: args.pathConflictFileId !== null && args.pathConflictFileId !== undefined,
    pathConflictFileId: args.pathConflictFileId ?? null,
    willCreateVersion: args.action === "soft_delete" ? args.file.head_version + 1 : args.file.head_version + 1,
    willCreateCheckpoint: `cp_${args.latestCheckpoint + 1}`,
    retention: {
      historyRetentionDays: appConfig.tombstoneRetentionDays,
      policy: "历史版本与删除墓碑默认保留三个月"
    }
  };
}

async function verifyPreviewToken(
  app: FastifyInstance,
  token: string,
  expected: Omit<PreviewTokenPayload, "type" | "sub" | "deviceId">
): Promise<PreviewTokenPayload | null> {
  try {
    const payload = app.jwt.verify<PreviewTokenPayload>(token);
    if (
      payload.type !== "admin-preview" ||
      payload.vaultId !== expected.vaultId ||
      payload.fileId !== expected.fileId ||
      payload.action !== expected.action ||
      payload.version !== expected.version ||
      payload.targetPath !== expected.targetPath
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export default function adminRoutes(objectStore: ObjectStore) {
  return async function routes(app: FastifyInstance): Promise<void> {
    app.get("/admin/vaults", async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;

      const result = await query<VaultRow>(
        `SELECT v.id, v.name, v.created_at,
                COUNT(fe.id)::text AS file_count,
                COUNT(fe.id) FILTER (WHERE fe.deleted_at IS NOT NULL)::text AS deleted_file_count,
                vss.latest_checkpoint::text AS latest_checkpoint,
                MAX(ce.created_at) AS latest_event_at
         FROM vaults v
         LEFT JOIN file_entries fe ON fe.vault_id = v.id
         LEFT JOIN vault_sync_state vss ON vss.vault_id = v.id
         LEFT JOIN change_events ce ON ce.vault_id = v.id
         WHERE v.owner_user_id = $1
         GROUP BY v.id, v.name, v.created_at, vss.latest_checkpoint
         ORDER BY v.created_at DESC`,
        [auth.userId]
      );

      return reply.send({
        items: result.rows.map((vault) => ({
          vaultId: vault.id,
          name: vault.name,
          createdAt: vault.created_at.toISOString(),
          fileCount: Number(vault.file_count),
          deletedFileCount: Number(vault.deleted_file_count),
          latestCheckpoint: `cp_${Number(vault.latest_checkpoint ?? 0)}`,
          latestEventAt: toIso(vault.latest_event_at)
        }))
      });
    });

    app.get("/admin/vaults/:vaultId/files", async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;
      const params = vaultParamsSchema.safeParse(request.params);
      const parsedQuery = filesQuerySchema.safeParse(request.query);
      if (!params.success || !parsedQuery.success) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: !params.success ? params.error.flatten() : !parsedQuery.success ? parsedQuery.error.flatten() : "invalid request" });
      }
      const { vaultId } = params.data;
      if (!(await assertVaultOwnership(vaultId, auth.userId))) {
        return reply.code(404).send({ code: "VAULT_NOT_FOUND", message: "vault not found" });
      }

      const filters: string[] = ["fe.vault_id = $1"];
      const values: unknown[] = [vaultId];
      if (parsedQuery.data.status === "active") filters.push("fe.deleted_at IS NULL");
      if (parsedQuery.data.status === "deleted") filters.push("fe.deleted_at IS NOT NULL");
      if (parsedQuery.data.query) {
        values.push(`%${parsedQuery.data.query}%`);
        filters.push(`fe.current_path ILIKE $${values.length}`);
      }
      values.push(parsedQuery.data.limit + 1, parsedQuery.data.cursor);
      const limitIndex = values.length - 1;
      const cursorIndex = values.length;

      const result = await query<FileListRow>(
        `SELECT fe.id, fe.current_path, fe.head_version, fe.deleted_at, fe.created_at,
                MAX(ce.checkpoint)::text AS latest_checkpoint,
                MAX(ce.created_at) AS updated_at,
                fv.content_hash AS latest_content_hash,
                COUNT(fv_all.id)::text AS version_count
         FROM file_entries fe
         LEFT JOIN change_events ce ON ce.file_id = fe.id
         LEFT JOIN file_versions fv ON fv.file_id = fe.id AND fv.version = fe.head_version
         LEFT JOIN file_versions fv_all ON fv_all.file_id = fe.id
         WHERE ${filters.join(" AND ")}
         GROUP BY fe.id, fe.current_path, fe.head_version, fe.deleted_at, fe.created_at, fv.content_hash
         ORDER BY COALESCE(MAX(ce.created_at), fe.created_at) DESC, fe.current_path ASC
         LIMIT $${limitIndex} OFFSET $${cursorIndex}`,
        values
      );
      const rows = result.rows.slice(0, parsedQuery.data.limit);
      return reply.send({
        items: rows.map((file) => ({
          fileId: file.id,
          path: file.current_path,
          headVersion: file.head_version,
          deleted: file.deleted_at !== null,
          deletedAt: toIso(file.deleted_at),
          createdAt: file.created_at.toISOString(),
          updatedAt: toIso(file.updated_at),
          latestCheckpoint: `cp_${Number(file.latest_checkpoint ?? 0)}`,
          latestContentHash: file.latest_content_hash,
          versionCount: Number(file.version_count)
        })),
        nextCursor: result.rows.length > parsedQuery.data.limit ? parsedQuery.data.cursor + parsedQuery.data.limit : null
      });
    });

    app.get("/admin/vaults/:vaultId/files/:fileId", async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;
      const params = fileParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ code: "INVALID_REQUEST", message: params.error.flatten() });
      const { vaultId, fileId } = params.data;
      if (!(await assertVaultOwnership(vaultId, auth.userId))) {
        return reply.code(404).send({ code: "VAULT_NOT_FOUND", message: "vault not found" });
      }
      const file = await getFile(vaultId, fileId);
      if (!file) return reply.code(404).send({ code: "FILE_NOT_FOUND", message: "file not found" });

      const [versions, events, tombstones, operations] = await Promise.all([
        query<FileVersionRow>(
          `SELECT fv.id, fv.version, fv.content_hash, fv.author_device_id, d.device_name AS author_device_name,
                  d.platform AS author_platform, fv.created_at, fv.mtime_ms, fv.ctime_ms
           FROM file_versions fv
           LEFT JOIN devices d ON d.id = fv.author_device_id
           WHERE fv.file_id = $1
           ORDER BY fv.version DESC`,
          [fileId]
        ),
        query<ChangeEventRow>(
          `SELECT id, checkpoint::text, op, path, version, content_hash, source, reason, admin_operation_id, created_at
           FROM change_events
           WHERE vault_id = $1 AND file_id = $2
           ORDER BY checkpoint DESC, created_at DESC
           LIMIT 200`,
          [vaultId, fileId]
        ),
        query<TombstoneRow>(
          `SELECT id, deleted_at, expire_at
           FROM tombstones
           WHERE vault_id = $1 AND file_id = $2
           ORDER BY deleted_at DESC`,
          [vaultId, fileId]
        ),
        query<AdminOperationRow>(
          `SELECT id, operation, status, file_id, before_json, after_json, reason, changeset_id, created_at
           FROM admin_operations
           WHERE vault_id = $1 AND file_id = $2
           ORDER BY created_at DESC
           LIMIT 100`,
          [vaultId, fileId]
        )
      ]);

      return reply.send({
        file: serializeFile(file),
        versions: versions.rows.map((version) => ({
          version: version.version,
          contentHash: version.content_hash,
          authorDeviceId: version.author_device_id,
          authorDeviceName: version.author_device_name,
          authorPlatform: version.author_platform,
          createdAt: version.created_at.toISOString(),
          mtimeMs: toNumber(version.mtime_ms),
          ctimeMs: toNumber(version.ctime_ms),
          current: version.version === file.head_version
        })),
        tombstones: tombstones.rows.map((row) => ({
          tombstoneId: row.id,
          deletedAt: row.deleted_at.toISOString(),
          expireAt: row.expire_at.toISOString()
        })),
        events: events.rows.map((event) => ({
          eventId: event.id,
          checkpoint: `cp_${Number(event.checkpoint)}`,
          op: event.op,
          path: event.path,
          version: event.version,
          contentHash: event.content_hash,
          source: event.source,
          reason: event.reason,
          adminOperationId: event.admin_operation_id,
          createdAt: event.created_at.toISOString()
        })),
        operations: operations.rows.map((operation) => ({
          operationId: operation.id,
          operation: operation.operation,
          status: operation.status,
          reason: operation.reason,
          changesetId: operation.changeset_id,
          before: operation.before_json,
          after: operation.after_json,
          createdAt: operation.created_at.toISOString()
        }))
      });
    });

    app.get("/admin/vaults/:vaultId/files/:fileId/versions/:version/download-url", async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;
      const params = fileVersionParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ code: "INVALID_REQUEST", message: params.error.flatten() });
      const { vaultId, fileId, version } = params.data;
      if (!(await assertVaultOwnership(vaultId, auth.userId))) {
        return reply.code(404).send({ code: "VAULT_NOT_FOUND", message: "vault not found" });
      }
      const file = await getFile(vaultId, fileId);
      const fileVersion = file ? await getVersion(fileId, version) : null;
      if (!file || !fileVersion) {
        return reply.code(404).send({ code: "FILE_VERSION_NOT_FOUND", message: "file version not found" });
      }
      return reply.send({
        contentHash: fileVersion.content_hash,
        downloadUrl: await objectStore.createDownloadUrl(fileVersion.content_hash)
      });
    });

    app.post("/admin/vaults/:vaultId/files/:fileId/actions/preview", async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;
      const params = fileParamsSchema.safeParse(request.params);
      const body = previewBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: !params.success ? params.error.flatten() : !body.success ? body.error.flatten() : "invalid request" });
      }
      const { vaultId, fileId } = params.data;
      if (!(await assertVaultOwnership(vaultId, auth.userId))) {
        return reply.code(404).send({ code: "VAULT_NOT_FOUND", message: "vault not found" });
      }
      const file = await getFile(vaultId, fileId);
      if (!file) return reply.code(404).send({ code: "FILE_NOT_FOUND", message: "file not found" });

      let version: FileVersionRow | undefined;
      let targetPath: string | undefined;
      let pathConflictFileId: string | null = null;
      if (body.data.action !== "soft_delete") {
        if (!body.data.version) return reply.code(400).send({ code: "INVALID_REQUEST", message: "version is required" });
        version = (await getVersion(fileId, body.data.version)) ?? undefined;
        if (!version) return reply.code(404).send({ code: "FILE_VERSION_NOT_FOUND", message: "file version not found" });
        if (!(await objectStore.objectExists(version.content_hash))) {
          return reply.code(404).send({ code: "FILE_VERSION_NOT_FOUND", message: "file object is unavailable" });
        }
        targetPath = body.data.targetPath ?? file.current_path;
        pathConflictFileId = await findPathConflict(vaultId, targetPath, fileId);
      }
      const latestCheckpoint = await ensureCheckpointRow(vaultId);
      return reply.send(
        makePreviewResponse({
          app,
          userId: auth.userId,
          deviceId: auth.deviceId,
          vaultId,
          file,
          action: body.data.action,
          version,
          targetPath,
          pathConflictFileId,
          latestCheckpoint
        })
      );
    });

    async function executeVersionAction(args: {
      action: "restore" | "set_current_version";
      auth: { userId: string; deviceId: string };
      vaultId: string;
      fileId: string;
      version: number;
      targetPath: string;
      reason: string;
      confirmToken: string;
      reply: FastifyReply;
    }) {
      const token = await verifyPreviewToken(app, args.confirmToken, {
        vaultId: args.vaultId,
        fileId: args.fileId,
        action: args.action,
        version: args.version,
        targetPath: args.targetPath
      });
      if (!token) return args.reply.code(409).send({ code: "ADMIN_CONFIRM_REQUIRED", message: "valid preview confirmation is required" });
      if (!(await assertVaultOwnership(args.vaultId, args.auth.userId))) {
        return args.reply.code(404).send({ code: "VAULT_NOT_FOUND", message: "vault not found" });
      }
      const version = await getVersion(args.fileId, args.version);
      if (!version || !(await objectStore.objectExists(version.content_hash))) {
        return args.reply.code(404).send({ code: "FILE_VERSION_NOT_FOUND", message: "file version not found or object unavailable" });
      }
      const conflict = await findPathConflict(args.vaultId, args.targetPath, args.fileId);
      if (conflict) return args.reply.code(409).send({ code: "ADMIN_PATH_CONFLICT", message: "target path is occupied", conflictFileId: conflict });

      const result = await withTransaction(async (client) => {
        await client.query(
          "INSERT INTO vault_sync_state (vault_id, latest_checkpoint) VALUES ($1, 0) ON CONFLICT (vault_id) DO NOTHING",
          [args.vaultId]
        );
        const checkpointRow = await client.query<CheckpointRow>(
          "SELECT latest_checkpoint FROM vault_sync_state WHERE vault_id = $1 FOR UPDATE",
          [args.vaultId]
        );
        const currentCheckpoint = Number(checkpointRow.rows[0]?.latest_checkpoint ?? 0);
        const nextCheckpoint = currentCheckpoint + 1;

        const fileResult = await client.query<FileEntryRow>(
          `SELECT id, vault_id, current_path, head_version, deleted_at, created_at
           FROM file_entries
           WHERE vault_id = $1 AND id = $2
           FOR UPDATE`,
          [args.vaultId, args.fileId]
        );
        const file = fileResult.rows[0];
        if (!file) throw new Error("file not found");
        const before = serializeFile(file);
        const nextVersion = file.head_version + 1;

        const operationResult = await client.query<{ id: string }>(
          `INSERT INTO admin_operations (vault_id, actor_user_id, operation, status, file_id, before_json, reason)
           VALUES ($1, $2, $3, 'committed', $4, $5::jsonb, $6)
           RETURNING id`,
          [args.vaultId, args.auth.userId, args.action, args.fileId, JSON.stringify(before), args.reason]
        );
        const operationId = operationResult.rows[0]!.id;

        const changesetResult = await client.query<{ id: string }>(
          `INSERT INTO changesets (vault_id, device_id, checkpoint, status, source, actor_user_id)
           VALUES ($1, $2, $3, 'committed', 'admin', $4)
           RETURNING id`,
          [args.vaultId, args.auth.deviceId, nextCheckpoint, args.auth.userId]
        );
        const changesetId = changesetResult.rows[0]!.id;

        await client.query("INSERT INTO object_blobs (content_hash) VALUES ($1) ON CONFLICT (content_hash) DO NOTHING", [
          version.content_hash
        ]);
        await client.query(
          `UPDATE file_entries
           SET head_version = $1, current_path = $2, deleted_at = NULL
           WHERE id = $3`,
          [nextVersion, args.targetPath, args.fileId]
        );
        await client.query(
          `INSERT INTO file_versions (file_id, version, content_hash, author_device_id, mtime_ms, ctime_ms)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [args.fileId, nextVersion, version.content_hash, args.auth.deviceId, version.mtime_ms, version.ctime_ms]
        );
        await client.query(
          `INSERT INTO change_events (vault_id, changeset_id, checkpoint, op, file_id, path, version, content_hash, mtime_ms, ctime_ms, source, admin_operation_id, reason)
           VALUES ($1, $2, $3, 'update', $4, $5, $6, $7, $8, $9, 'admin', $10, $11)`,
          [
            args.vaultId,
            changesetId,
            nextCheckpoint,
            args.fileId,
            args.targetPath,
            nextVersion,
            version.content_hash,
            version.mtime_ms,
            version.ctime_ms,
            operationId,
            args.reason
          ]
        );
        await client.query("UPDATE vault_sync_state SET latest_checkpoint = $1, updated_at = NOW() WHERE vault_id = $2", [
          nextCheckpoint,
          args.vaultId
        ]);
        const after = {
          fileId: args.fileId,
          path: args.targetPath,
          headVersion: nextVersion,
          deleted: false,
          contentHash: version.content_hash
        };
        await client.query(
          "UPDATE admin_operations SET after_json = $1::jsonb, changeset_id = $2 WHERE id = $3",
          [JSON.stringify(after), changesetId, operationId]
        );
        return { operationId, changesetId, newVersion: nextVersion, newCheckpoint: `cp_${nextCheckpoint}` };
      });

      publishSyncCheckpoint({
        vaultId: args.vaultId,
        checkpoint: result.newCheckpoint,
        changesetId: result.changesetId,
        authorDeviceId: args.auth.deviceId,
        ts: new Date().toISOString()
      });
      return args.reply.send(result);
    }

    app.post("/admin/vaults/:vaultId/files/:fileId/restore", async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;
      const params = fileParamsSchema.safeParse(request.params);
      const body = executeVersionBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: !params.success ? params.error.flatten() : !body.success ? body.error.flatten() : "invalid request" });
      }
      return executeVersionAction({ action: "restore", auth, vaultId: params.data.vaultId, fileId: params.data.fileId, ...body.data, reply });
    });

    app.post("/admin/vaults/:vaultId/files/:fileId/set-current-version", async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;
      const params = fileParamsSchema.safeParse(request.params);
      const body = executeVersionBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: !params.success ? params.error.flatten() : !body.success ? body.error.flatten() : "invalid request" });
      }
      return executeVersionAction({ action: "set_current_version", auth, vaultId: params.data.vaultId, fileId: params.data.fileId, ...body.data, reply });
    });

    app.post("/admin/vaults/:vaultId/files/:fileId/soft-delete", async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;
      const params = fileParamsSchema.safeParse(request.params);
      const body = executeDeleteBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: !params.success ? params.error.flatten() : !body.success ? body.error.flatten() : "invalid request" });
      }
      const { vaultId, fileId } = params.data;
      const token = await verifyPreviewToken(app, body.data.confirmToken, { vaultId, fileId, action: "soft_delete" });
      if (!token) return reply.code(409).send({ code: "ADMIN_CONFIRM_REQUIRED", message: "valid preview confirmation is required" });
      if (!(await assertVaultOwnership(vaultId, auth.userId))) {
        return reply.code(404).send({ code: "VAULT_NOT_FOUND", message: "vault not found" });
      }

      const result = await withTransaction(async (client) => {
        await client.query("INSERT INTO vault_sync_state (vault_id, latest_checkpoint) VALUES ($1, 0) ON CONFLICT (vault_id) DO NOTHING", [vaultId]);
        const checkpointRow = await client.query<CheckpointRow>("SELECT latest_checkpoint FROM vault_sync_state WHERE vault_id = $1 FOR UPDATE", [vaultId]);
        const nextCheckpoint = Number(checkpointRow.rows[0]?.latest_checkpoint ?? 0) + 1;
        const fileResult = await client.query<FileEntryRow>(
          `SELECT id, vault_id, current_path, head_version, deleted_at, created_at
           FROM file_entries
           WHERE vault_id = $1 AND id = $2
           FOR UPDATE`,
          [vaultId, fileId]
        );
        const file = fileResult.rows[0];
        if (!file) throw new Error("file not found");
        if (file.deleted_at) throw new Error("file already deleted");
        const currentVersion = await client.query<{ content_hash: string; mtime_ms: string | null; ctime_ms: string | null }>(
          "SELECT content_hash, mtime_ms, ctime_ms FROM file_versions WHERE file_id = $1 AND version = $2 LIMIT 1",
          [fileId, file.head_version]
        );
        const current = currentVersion.rows[0];
        if (!current) throw new Error("current version missing");
        const nextVersion = file.head_version + 1;
        const before = serializeFile(file);
        const operationResult = await client.query<{ id: string }>(
          `INSERT INTO admin_operations (vault_id, actor_user_id, operation, status, file_id, before_json, reason)
           VALUES ($1, $2, 'soft_delete', 'committed', $3, $4::jsonb, $5)
           RETURNING id`,
          [vaultId, auth.userId, fileId, JSON.stringify(before), body.data.reason]
        );
        const operationId = operationResult.rows[0]!.id;
        const changesetResult = await client.query<{ id: string }>(
          `INSERT INTO changesets (vault_id, device_id, checkpoint, status, source, actor_user_id)
           VALUES ($1, $2, $3, 'committed', 'admin', $4)
           RETURNING id`,
          [vaultId, auth.deviceId, nextCheckpoint, auth.userId]
        );
        const changesetId = changesetResult.rows[0]!.id;
        await client.query("UPDATE file_entries SET head_version = $1, deleted_at = NOW() WHERE id = $2", [nextVersion, fileId]);
        await client.query(
          "INSERT INTO file_versions (file_id, version, content_hash, author_device_id, mtime_ms, ctime_ms) VALUES ($1, $2, $3, $4, $5, $6)",
          [fileId, nextVersion, current.content_hash, auth.deviceId, current.mtime_ms, current.ctime_ms]
        );
        await client.query(
          "INSERT INTO tombstones (vault_id, file_id, deleted_at, expire_at) VALUES ($1, $2, NOW(), NOW() + ($3 * INTERVAL '1 day'))",
          [vaultId, fileId, appConfig.tombstoneRetentionDays]
        );
        await client.query(
          `INSERT INTO change_events (vault_id, changeset_id, checkpoint, op, file_id, path, version, content_hash, mtime_ms, ctime_ms, source, admin_operation_id, reason)
           VALUES ($1, $2, $3, 'delete', $4, $5, $6, $7, $8, $9, 'admin', $10, $11)`,
          [vaultId, changesetId, nextCheckpoint, fileId, file.current_path, nextVersion, current.content_hash, current.mtime_ms, current.ctime_ms, operationId, body.data.reason]
        );
        await client.query("UPDATE vault_sync_state SET latest_checkpoint = $1, updated_at = NOW() WHERE vault_id = $2", [nextCheckpoint, vaultId]);
        const after = { fileId, path: file.current_path, headVersion: nextVersion, deleted: true, contentHash: current.content_hash };
        await client.query("UPDATE admin_operations SET after_json = $1::jsonb, changeset_id = $2 WHERE id = $3", [JSON.stringify(after), changesetId, operationId]);
        return { operationId, changesetId, newVersion: nextVersion, newCheckpoint: `cp_${nextCheckpoint}` };
      });
      publishSyncCheckpoint({ vaultId, checkpoint: result.newCheckpoint, changesetId: result.changesetId, authorDeviceId: auth.deviceId, ts: new Date().toISOString() });
      return reply.send(result);
    });

    app.get("/admin/vaults/:vaultId/operations", async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;
      const params = vaultParamsSchema.safeParse(request.params);
      const parsedQuery = operationsQuerySchema.safeParse(request.query);
      if (!params.success || !parsedQuery.success) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: !params.success ? params.error.flatten() : !parsedQuery.success ? parsedQuery.error.flatten() : "invalid request" });
      }
      const { vaultId } = params.data;
      if (!(await assertVaultOwnership(vaultId, auth.userId))) {
        return reply.code(404).send({ code: "VAULT_NOT_FOUND", message: "vault not found" });
      }
      const values: unknown[] = [vaultId];
      const filters = ["vault_id = $1"];
      if (parsedQuery.data.fileId) {
        values.push(parsedQuery.data.fileId);
        filters.push(`file_id = $${values.length}`);
      }
      values.push(parsedQuery.data.limit + 1, parsedQuery.data.cursor);
      const limitIndex = values.length - 1;
      const cursorIndex = values.length;
      const result = await query<AdminOperationRow>(
        `SELECT id, operation, status, file_id, before_json, after_json, reason, changeset_id, created_at
         FROM admin_operations
         WHERE ${filters.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT $${limitIndex} OFFSET $${cursorIndex}`,
        values
      );
      const rows = result.rows.slice(0, parsedQuery.data.limit);
      return reply.send({
        items: rows.map((operation) => ({
          operationId: operation.id,
          operation: operation.operation,
          status: operation.status,
          fileId: operation.file_id,
          reason: operation.reason,
          changesetId: operation.changeset_id,
          before: operation.before_json,
          after: operation.after_json,
          createdAt: operation.created_at.toISOString()
        })),
        nextCursor: result.rows.length > parsedQuery.data.limit ? parsedQuery.data.cursor + parsedQuery.data.limit : null
      });
    });
  };
}
