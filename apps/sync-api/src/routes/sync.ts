import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { appConfig } from "../config.js";
import { query, withTransaction } from "../db.js";
import { metricsRegistry } from "../metrics.js";
import type { ObjectStore } from "../object-store.js";

const vaultParamsSchema = z.object({
  vaultId: z.string().uuid()
});

const contentHashSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "contentHash must be sha256:<64 lowercase hex chars>");

const syncChangeSchema = z.object({
  op: z.enum(["create", "update", "delete", "rename", "move"]),
  fileId: z.string().uuid().optional(),
  path: z.string().min(1).max(4096),
  baseVersion: z.number().int().nonnegative().optional(),
  contentHash: contentHashSchema.optional()
});

const prepareBodySchema = z.object({
  baseCheckpoint: z.number().int().nonnegative(),
  changes: z.array(syncChangeSchema).max(500)
});

const commitBodySchema = z.object({
  prepareId: z.string().uuid(),
  idempotencyKey: z.string().uuid()
});

const pullQuerySchema = z.object({
  fromCheckpoint: z.coerce.number().int().nonnegative(),
  limit: z.coerce.number().int().positive().max(1000).optional()
});

const downloadUrlsSchema = z.object({
  contentHashes: z.array(contentHashSchema).max(500)
});

type SyncChangeInput = z.infer<typeof syncChangeSchema>;

interface VaultOwnershipRow {
  id: string;
}

interface CheckpointRow {
  latest_checkpoint: string;
}

interface FileEntryRow {
  id: string;
  current_path: string;
  head_version: number;
  deleted_at: Date | null;
}

interface ChangeEventRow {
  checkpoint: string;
  op: "create" | "update" | "delete" | "rename" | "move";
  file_id: string;
  path: string;
  version: number;
  content_hash: string;
}

interface SyncPrepareRow {
  id: string;
  device_id: string;
  changes_json: SyncChangeInput[];
  conflicts_json: ConflictItem[];
  status: "prepared" | "conflicted" | "committed" | "expired";
  expires_at: Date;
}

interface ConflictItem {
  index: number;
  code: string;
  fileId?: string;
  path: string;
  message: string;
  reason?: string;
  headVersion?: number;
  remotePath?: string;
  remoteDeleted?: boolean;
  existingFileId?: string;
}

interface UploadTarget {
  contentHash: string;
  uploadUrl: string;
}

async function assertVaultOwnership(vaultId: string, userId: string): Promise<boolean> {
  const result = await query<VaultOwnershipRow>(
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
  const row = result.rows[0];
  return row ? Number(row.latest_checkpoint) : 0;
}

async function getFileEntry(vaultId: string, fileId: string): Promise<FileEntryRow | null> {
  const result = await query<FileEntryRow>(
    `SELECT id, current_path, head_version, deleted_at
     FROM file_entries
     WHERE vault_id = $1 AND id = $2
     LIMIT 1`,
    [vaultId, fileId]
  );
  return result.rows[0] ?? null;
}

async function getActiveFileEntryByPath(vaultId: string, path: string, ignoreFileId?: string): Promise<FileEntryRow | null> {
  if (ignoreFileId) {
    const result = await query<FileEntryRow>(
      `SELECT id, current_path, head_version, deleted_at
       FROM file_entries
       WHERE vault_id = $1
         AND current_path = $2
         AND deleted_at IS NULL
         AND id <> $3
       LIMIT 1`,
      [vaultId, path, ignoreFileId]
    );
    return result.rows[0] ?? null;
  }

  const result = await query<FileEntryRow>(
    `SELECT id, current_path, head_version, deleted_at
     FROM file_entries
     WHERE vault_id = $1
       AND current_path = $2
       AND deleted_at IS NULL
     LIMIT 1`,
    [vaultId, path]
  );
  return result.rows[0] ?? null;
}

async function pathOccupied(vaultId: string, path: string, ignoreFileId?: string): Promise<boolean> {
  if (ignoreFileId) {
    const result = await query<{ id: string }>(
      `SELECT id
       FROM file_entries
       WHERE vault_id = $1
         AND current_path = $2
         AND deleted_at IS NULL
         AND id <> $3
       LIMIT 1`,
      [vaultId, path, ignoreFileId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  const result = await query<{ id: string }>(
    `SELECT id
     FROM file_entries
     WHERE vault_id = $1
       AND current_path = $2
       AND deleted_at IS NULL
     LIMIT 1`,
    [vaultId, path]
  );
  return (result.rowCount ?? 0) > 0;
}

function validateChangeShape(change: SyncChangeInput, index: number): ConflictItem | null {
  if (change.op === "create") {
    if (!change.contentHash) {
      return {
        index,
        code: "INVALID_CHANGE",
        path: change.path,
        message: "create requires contentHash"
      };
    }
    return null;
  }

  if (!change.fileId) {
    return {
      index,
      code: "INVALID_CHANGE",
      path: change.path,
      message: `${change.op} requires fileId`
    };
  }

  if (change.baseVersion === undefined) {
    return {
      index,
      code: "INVALID_CHANGE",
      fileId: change.fileId,
      path: change.path,
      message: `${change.op} requires baseVersion`
    };
  }

  if (change.op === "update" && !change.contentHash) {
    return {
      index,
      code: "INVALID_CHANGE",
      fileId: change.fileId,
      path: change.path,
      message: "update requires contentHash"
    };
  }

  return null;
}

async function resolveUploadTargets(
  changes: SyncChangeInput[],
  objectStore: ObjectStore
): Promise<UploadTarget[]> {
  const hashes = new Set<string>();
  for (const change of changes) {
    if (change.contentHash && (change.op === "create" || change.op === "update")) {
      hashes.add(change.contentHash);
    }
  }

  const uploadTargets: UploadTarget[] = [];
  for (const hash of hashes) {
    const knownResult = await query<{ content_hash: string }>(
      "SELECT content_hash FROM object_blobs WHERE content_hash = $1 LIMIT 1",
      [hash]
    );
    if ((knownResult.rowCount ?? 0) > 0) {
      continue;
    }

    if (await objectStore.objectExists(hash)) {
      if (!(await objectStore.verifyObjectContentHash(hash))) {
        continue;
      }
      await query("INSERT INTO object_blobs (content_hash) VALUES ($1) ON CONFLICT (content_hash) DO NOTHING", [
        hash
      ]);
      continue;
    }

    uploadTargets.push({
      contentHash: hash,
      uploadUrl: await objectStore.createUploadUrl(hash)
    });
  }

  return uploadTargets;
}

function collectRequiredObjectHashes(changes: SyncChangeInput[]): string[] {
  const hashes = new Set<string>();
  for (const change of changes) {
    if ((change.op === "create" || change.op === "update") && change.contentHash) {
      hashes.add(change.contentHash);
    }
  }
  return Array.from(hashes);
}

async function ensureUploadedObjectsExist(contentHashes: string[], objectStore: ObjectStore): Promise<void> {
  if (contentHashes.length === 0) {
    return;
  }

  const knownResult = await query<{ content_hash: string }>(
    `SELECT content_hash
     FROM object_blobs
     WHERE content_hash = ANY($1::text[])`,
    [contentHashes]
  );
  const knownHashes = new Set(knownResult.rows.map((row) => row.content_hash));

  for (const hash of contentHashes) {
    if (knownHashes.has(hash)) {
      continue;
    }
    if (!(await objectStore.objectExists(hash))) {
      throw new Error(`missing uploaded object ${hash}`);
    }
    if (!(await objectStore.verifyObjectContentHash(hash))) {
      throw new Error(`uploaded object hash mismatch ${hash}`);
    }
  }
}

async function fetchLatestContentHash(client: { query: typeof query }, fileId: string): Promise<string> {
  const row = await client.query<{ content_hash: string }>(
    `SELECT content_hash
     FROM file_versions
     WHERE file_id = $1
     ORDER BY version DESC
     LIMIT 1`,
    [fileId]
  );
  const version = row.rows[0];
  if (!version) {
    throw new Error("missing latest content hash");
  }
  return version.content_hash;
}

async function isNoopUpdate(vaultId: string, change: SyncChangeInput): Promise<boolean> {
  if (change.op !== "update" || !change.fileId || !change.contentHash) {
    return false;
  }

  const fileEntry = await getFileEntry(vaultId, change.fileId);
  if (!fileEntry || fileEntry.deleted_at || fileEntry.current_path !== change.path) {
    return false;
  }

  const latestContentHash = await fetchLatestContentHash({ query }, change.fileId);
  return latestContentHash === change.contentHash;
}

function parseVaultParams(
  request: { params: unknown },
  reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }
): { vaultId: string } | null {
  const parsed = vaultParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    reply.code(400).send({
      code: "INVALID_PARAMS",
      message: parsed.error.flatten()
    });
    return null;
  }
  return parsed.data;
}

export default function syncRoutes(objectStore: ObjectStore) {
  return async function registerSyncRoutes(app: FastifyInstance): Promise<void> {
    app.get("/vaults/:vaultId/sync/state", async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;

      const params = parseVaultParams(request, reply);
      if (!params) return;
      const { vaultId } = params;
      if (!(await assertVaultOwnership(vaultId, auth.userId))) {
        return reply.code(404).send({ code: "VAULT_NOT_FOUND", message: "vault not found" });
      }

      const checkpoint = await ensureCheckpointRow(vaultId);
      return reply.send({
        checkpoint: `cp_${checkpoint}`,
        serverTime: new Date().toISOString()
      });
    });

    app.post("/vaults/:vaultId/sync/prepare", async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;

      const params = parseVaultParams(request, reply);
      if (!params) return;
      const { vaultId } = params;
      if (!(await assertVaultOwnership(vaultId, auth.userId))) {
        return reply.code(404).send({ code: "VAULT_NOT_FOUND", message: "vault not found" });
      }

      const parsed = prepareBodySchema.safeParse(request.body);
      if (!parsed.success) {
        metricsRegistry.incCounter("sync_api_sync_prepare_total", { result: "invalid_request" });
        return reply.code(400).send({ code: "INVALID_REQUEST", message: parsed.error.flatten() });
      }

      const latestCheckpoint = await ensureCheckpointRow(vaultId);
      if (parsed.data.baseCheckpoint > latestCheckpoint) {
        metricsRegistry.incCounter("sync_api_sync_prepare_total", { result: "checkpoint_mismatch" });
        return reply.code(409).send({
          code: "CHECKPOINT_MISMATCH",
          message: "base checkpoint is ahead of server checkpoint"
        });
      }

      const normalizedChanges: SyncChangeInput[] = [];
      const conflicts: ConflictItem[] = [];
      for (let index = 0; index < parsed.data.changes.length; index += 1) {
        const change = parsed.data.changes[index]!;
        const shapeConflict = validateChangeShape(change, index);
        if (shapeConflict) {
          conflicts.push(shapeConflict);
          continue;
        }

        if (change.op === "create") {
          const occupiedEntry = await getActiveFileEntryByPath(vaultId, change.path);
          if (occupiedEntry) {
            conflicts.push({
              index,
              code: "PATH_CONFLICT",
              path: change.path,
              message: "path already exists",
              reason: "path_exists",
              remotePath: occupiedEntry.current_path,
              headVersion: occupiedEntry.head_version,
              existingFileId: occupiedEntry.id,
              remoteDeleted: false
            });
            continue;
          }
          normalizedChanges.push(change);
          continue;
        }

        const fileEntry = await getFileEntry(vaultId, change.fileId!);
        if (!fileEntry || fileEntry.deleted_at) {
          conflicts.push({
            index,
            code: "FILE_NOT_FOUND",
            fileId: change.fileId,
            path: change.path,
            message: "file not found or deleted",
            reason: fileEntry?.deleted_at ? "deleted_on_server" : "unknown_file_id",
            remotePath: fileEntry?.current_path,
            headVersion: fileEntry?.head_version,
            remoteDeleted: Boolean(fileEntry?.deleted_at)
          });
          continue;
        }

        if (await isNoopUpdate(vaultId, change)) {
          continue;
        }

        if (fileEntry.head_version !== change.baseVersion) {
          conflicts.push({
            index,
            code: "VERSION_CONFLICT",
            fileId: change.fileId,
            path: change.path,
            message: `baseVersion ${change.baseVersion} does not match headVersion ${fileEntry.head_version}`,
            reason: "base_version_mismatch",
            headVersion: fileEntry.head_version,
            remotePath: fileEntry.current_path,
            remoteDeleted: false
          });
          continue;
        }

        const occupiedTarget =
          change.op === "rename" || change.op === "move"
            ? await getActiveFileEntryByPath(vaultId, change.path, fileEntry.id)
            : null;
        if (occupiedTarget) {
          conflicts.push({
            index,
            code: "PATH_CONFLICT",
            fileId: change.fileId,
            path: change.path,
            message: "target path already exists",
            reason: "target_path_exists",
            remotePath: occupiedTarget.current_path,
            headVersion: occupiedTarget.head_version,
            existingFileId: occupiedTarget.id,
            remoteDeleted: false
          });
          continue;
        }

        normalizedChanges.push(change);
      }

      const uploadTargets = await resolveUploadTargets(normalizedChanges, objectStore);
      const status = conflicts.length > 0 ? "conflicted" : "prepared";
      metricsRegistry.incCounter("sync_api_sync_prepare_total", { result: status });
      if (conflicts.length > 0) {
        metricsRegistry.incCounter("sync_api_sync_prepare_conflicts_total", {}, conflicts.length);
      }
      const expiresAt = new Date(Date.now() + appConfig.syncPrepareTtlSec * 1000);

      const prepareResult = await query<{ id: string }>(
        `INSERT INTO sync_prepares (vault_id, device_id, base_checkpoint, changes_json, conflicts_json, status, expires_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
         RETURNING id`,
        [
          vaultId,
          auth.deviceId,
          parsed.data.baseCheckpoint,
          JSON.stringify(normalizedChanges),
          JSON.stringify(conflicts),
          status,
          expiresAt
        ]
      );

      return reply.send({
        prepareId: prepareResult.rows[0]?.id,
        uploadTargets,
        conflicts
      });
    });

    app.post("/vaults/:vaultId/sync/commit", async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;

      const params = parseVaultParams(request, reply);
      if (!params) return;
      const { vaultId } = params;
      if (!(await assertVaultOwnership(vaultId, auth.userId))) {
        return reply.code(404).send({ code: "VAULT_NOT_FOUND", message: "vault not found" });
      }

      const parsed = commitBodySchema.safeParse(request.body);
      if (!parsed.success) {
        metricsRegistry.incCounter("sync_api_sync_commit_total", { result: "invalid_request" });
        return reply.code(400).send({ code: "INVALID_REQUEST", message: parsed.error.flatten() });
      }

      const existing = await query<{ response_json: { changesetId: string; newCheckpoint: string; appliedChanges: number } }>(
        `SELECT response_json
         FROM idempotency_keys
         WHERE vault_id = $1 AND idempotency_key = $2
         LIMIT 1`,
        [vaultId, parsed.data.idempotencyKey]
      );
      if ((existing.rowCount ?? 0) > 0) {
        metricsRegistry.incCounter("sync_api_sync_commit_total", { result: "idempotent" });
        return reply.send(existing.rows[0]?.response_json);
      }

      const prepareResult = await query<SyncPrepareRow>(
        `SELECT id, device_id, changes_json, conflicts_json, status, expires_at
         FROM sync_prepares
         WHERE id = $1
           AND vault_id = $2
         LIMIT 1`,
        [parsed.data.prepareId, vaultId]
      );
      const prepare = prepareResult.rows[0];
      if (!prepare) {
        metricsRegistry.incCounter("sync_api_sync_commit_total", { result: "prepare_not_found" });
        return reply.code(404).send({ code: "PREPARE_NOT_FOUND", message: "prepare session not found" });
      }
      if (prepare.device_id !== auth.deviceId) {
        metricsRegistry.incCounter("sync_api_sync_commit_total", { result: "forbidden" });
        return reply.code(403).send({ code: "FORBIDDEN", message: "prepare session does not belong to this device" });
      }
      if (prepare.status === "committed") {
        metricsRegistry.incCounter("sync_api_sync_commit_total", { result: "already_committed" });
        return reply.code(409).send({ code: "PREPARE_ALREADY_COMMITTED", message: "prepare already committed" });
      }
      if (prepare.status === "conflicted" || prepare.conflicts_json.length > 0) {
        metricsRegistry.incCounter("sync_api_sync_commit_total", { result: "conflicted" });
        return reply.code(409).send({ code: "VERSION_CONFLICT", message: "prepare has conflicts", conflicts: prepare.conflicts_json });
      }
      if (new Date(prepare.expires_at).getTime() < Date.now()) {
        await query("UPDATE sync_prepares SET status = 'expired' WHERE id = $1", [prepare.id]);
        metricsRegistry.incCounter("sync_api_sync_commit_total", { result: "expired" });
        return reply.code(409).send({ code: "PREPARE_EXPIRED", message: "prepare session expired" });
      }

      try {
        const changes = prepare.changes_json as SyncChangeInput[];
        if (changes.length === 0) {
          const currentCheckpoint = await ensureCheckpointRow(vaultId);
          await query("UPDATE sync_prepares SET status = 'committed' WHERE id = $1", [prepare.id]);
          const responseBody = {
            changesetId: prepare.id,
            newCheckpoint: `cp_${currentCheckpoint}`,
            appliedChanges: 0
          };
          await query(
            `INSERT INTO idempotency_keys (vault_id, idempotency_key, response_json)
             VALUES ($1, $2, $3::jsonb)`,
            [vaultId, parsed.data.idempotencyKey, JSON.stringify(responseBody)]
          );
          metricsRegistry.incCounter("sync_api_sync_commit_total", { result: "success" });
          return reply.send(responseBody);
        }
        const requiredObjectHashes = collectRequiredObjectHashes(changes);
        await ensureUploadedObjectsExist(requiredObjectHashes, objectStore);

        const commitResponse = await withTransaction(async (client) => {
          const registeredObjectHashes = new Set<string>();
          const ensureObjectBlobRow = async (contentHash: string): Promise<void> => {
            if (registeredObjectHashes.has(contentHash)) {
              return;
            }
            await client.query(
              "INSERT INTO object_blobs (content_hash) VALUES ($1) ON CONFLICT (content_hash) DO NOTHING",
              [contentHash]
            );
            registeredObjectHashes.add(contentHash);
          };

          const checkpointInit = await client.query(
            "INSERT INTO vault_sync_state (vault_id, latest_checkpoint) VALUES ($1, 0) ON CONFLICT (vault_id) DO NOTHING",
            [vaultId]
          );
          void checkpointInit;

          const checkpointRow = await client.query<CheckpointRow>(
            "SELECT latest_checkpoint FROM vault_sync_state WHERE vault_id = $1 FOR UPDATE",
            [vaultId]
          );
          const currentCheckpoint = Number(checkpointRow.rows[0]?.latest_checkpoint ?? 0);
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

          for (const change of changes) {
            if (change.op === "create") {
              if (!change.contentHash) {
                throw new Error("create missing contentHash");
              }
              const pathExists = await client.query<{ id: string }>(
                `SELECT id
                 FROM file_entries
                 WHERE vault_id = $1
                   AND current_path = $2
                   AND deleted_at IS NULL
                 LIMIT 1`,
                [vaultId, change.path]
              );
              if ((pathExists.rowCount ?? 0) > 0) {
                throw new Error("create path conflict");
              }

              await ensureObjectBlobRow(change.contentHash);

              const fileResult = await client.query<{ id: string }>(
                `INSERT INTO file_entries (vault_id, current_path, head_version, deleted_at)
                 VALUES ($1, $2, 1, NULL)
                 RETURNING id`,
                [vaultId, change.path]
              );
              const fileId = fileResult.rows[0]?.id;
              if (!fileId) {
                throw new Error("failed to create file entry");
              }

              await client.query(
                `INSERT INTO file_versions (file_id, version, content_hash, author_device_id)
                 VALUES ($1, 1, $2, $3)`,
                [fileId, change.contentHash, auth.deviceId]
              );
              await client.query(
                `INSERT INTO change_events (vault_id, changeset_id, checkpoint, op, file_id, path, version, content_hash)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [vaultId, changesetId, nextCheckpoint, "create", fileId, change.path, 1, change.contentHash]
              );
              continue;
            }

            if (!change.fileId || change.baseVersion === undefined) {
              throw new Error("invalid non-create change");
            }

            const fileRowResult = await client.query<FileEntryRow>(
              `SELECT id, current_path, head_version, deleted_at
               FROM file_entries
               WHERE id = $1
                 AND vault_id = $2
               FOR UPDATE`,
              [change.fileId, vaultId]
            );
            const file = fileRowResult.rows[0];
            if (!file || file.deleted_at) {
              throw new Error(`file missing ${change.fileId}`);
            }
            if (file.head_version !== change.baseVersion) {
              throw new Error(`version conflict for file ${change.fileId}`);
            }

            const nextVersion = file.head_version + 1;
            const currentHash = await fetchLatestContentHash(client, file.id);

            if (change.op === "update") {
              if (!change.contentHash) {
                throw new Error("update missing contentHash");
              }
              await ensureObjectBlobRow(change.contentHash);

              await client.query(
                `UPDATE file_entries
                 SET head_version = $1, current_path = $2, deleted_at = NULL
                 WHERE id = $3`,
                [nextVersion, change.path, file.id]
              );
              await client.query(
                `INSERT INTO file_versions (file_id, version, content_hash, author_device_id)
                 VALUES ($1, $2, $3, $4)`,
                [file.id, nextVersion, change.contentHash, auth.deviceId]
              );
              await client.query(
                `INSERT INTO change_events (vault_id, changeset_id, checkpoint, op, file_id, path, version, content_hash)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [vaultId, changesetId, nextCheckpoint, "update", file.id, change.path, nextVersion, change.contentHash]
              );
              continue;
            }

            if (change.op === "delete") {
              await client.query(
                `UPDATE file_entries
                 SET head_version = $1, deleted_at = NOW()
                 WHERE id = $2`,
                [nextVersion, file.id]
              );
              await client.query(
                `INSERT INTO file_versions (file_id, version, content_hash, author_device_id)
                 VALUES ($1, $2, $3, $4)`,
                [file.id, nextVersion, currentHash, auth.deviceId]
              );
              await client.query(
                `INSERT INTO tombstones (vault_id, file_id, deleted_at, expire_at)
                 VALUES ($1, $2, NOW(), NOW() + ($3 * INTERVAL '1 day'))`,
                [vaultId, file.id, appConfig.tombstoneRetentionDays]
              );
              await client.query(
                `INSERT INTO change_events (vault_id, changeset_id, checkpoint, op, file_id, path, version, content_hash)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [vaultId, changesetId, nextCheckpoint, "delete", file.id, file.current_path, nextVersion, currentHash]
              );
              continue;
            }

            if (change.op === "rename" || change.op === "move") {
              const collision = await client.query<{ id: string }>(
                `SELECT id
                 FROM file_entries
                 WHERE vault_id = $1
                   AND current_path = $2
                   AND deleted_at IS NULL
                   AND id <> $3
                 LIMIT 1`,
                [vaultId, change.path, file.id]
              );
              if ((collision.rowCount ?? 0) > 0) {
                throw new Error(`path conflict for ${change.path}`);
              }

              await client.query(
                `UPDATE file_entries
                 SET head_version = $1, current_path = $2
                 WHERE id = $3`,
                [nextVersion, change.path, file.id]
              );
              await client.query(
                `INSERT INTO file_versions (file_id, version, content_hash, author_device_id)
                 VALUES ($1, $2, $3, $4)`,
                [file.id, nextVersion, currentHash, auth.deviceId]
              );
              await client.query(
                `INSERT INTO change_events (vault_id, changeset_id, checkpoint, op, file_id, path, version, content_hash)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [vaultId, changesetId, nextCheckpoint, change.op, file.id, change.path, nextVersion, currentHash]
              );
              continue;
            }
          }

          await client.query(
            "UPDATE vault_sync_state SET latest_checkpoint = $1, updated_at = NOW() WHERE vault_id = $2",
            [nextCheckpoint, vaultId]
          );
          await client.query("UPDATE sync_prepares SET status = 'committed' WHERE id = $1", [prepare.id]);

          const responseBody = {
            changesetId,
            newCheckpoint: `cp_${nextCheckpoint}`,
            appliedChanges: changes.length
          };

          await client.query(
            `INSERT INTO idempotency_keys (vault_id, idempotency_key, response_json)
             VALUES ($1, $2, $3::jsonb)`,
            [vaultId, parsed.data.idempotencyKey, JSON.stringify(responseBody)]
          );

          return responseBody;
        });

        metricsRegistry.incCounter("sync_api_sync_commit_total", { result: "success" });
        metricsRegistry.incCounter("sync_api_sync_commit_applied_changes_total", {}, commitResponse.appliedChanges);
        return reply.send(commitResponse);
      } catch (error) {
        request.log.error({ err: error }, "sync commit failed");
        metricsRegistry.incCounter("sync_api_sync_commit_total", { result: "failed" });
        const message =
          appConfig.env === "development" && error instanceof Error
            ? error.message
            : "commit failed, please retry";
        return reply.code(409).send({
          code: "SYNC_COMMIT_FAILED",
          message
        });
      }
    });

    app.get("/vaults/:vaultId/sync/pull", async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;

      const params = parseVaultParams(request, reply);
      if (!params) return;
      const { vaultId } = params;
      if (!(await assertVaultOwnership(vaultId, auth.userId))) {
        return reply.code(404).send({ code: "VAULT_NOT_FOUND", message: "vault not found" });
      }

      const parsed = pullQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        metricsRegistry.incCounter("sync_api_sync_pull_total", { result: "invalid_request" });
        return reply.code(400).send({ code: "INVALID_REQUEST", message: parsed.error.flatten() });
      }

      const latestCheckpoint = await ensureCheckpointRow(vaultId);
      if (parsed.data.fromCheckpoint > latestCheckpoint) {
        metricsRegistry.incCounter("sync_api_sync_pull_total", { result: "checkpoint_mismatch" });
        return reply.code(409).send({
          code: "CHECKPOINT_MISMATCH",
          message: "fromCheckpoint is ahead of server checkpoint"
        });
      }

      const limit = parsed.data.limit ?? 200;
      const result = await query<ChangeEventRow>(
        `SELECT checkpoint, op, file_id, path, version, content_hash
         FROM change_events
         WHERE vault_id = $1
           AND checkpoint > $2
         ORDER BY checkpoint ASC, created_at ASC
         LIMIT $3`,
        [vaultId, parsed.data.fromCheckpoint, limit + 1]
      );

      const hasMore = result.rows.length > limit;
      const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
      const toCheckpoint =
        rows.length > 0 ? Number(rows[rows.length - 1]!.checkpoint) : parsed.data.fromCheckpoint;
      metricsRegistry.incCounter("sync_api_sync_pull_total", { result: "success" });
      metricsRegistry.incCounter("sync_api_sync_pull_changes_total", {}, rows.length);

      return reply.send({
        fromCheckpoint: `cp_${parsed.data.fromCheckpoint}`,
        toCheckpoint: `cp_${toCheckpoint}`,
        changes: rows.map((row) => ({
          op: row.op,
          fileId: row.file_id,
          path: row.path,
          version: row.version,
          contentHash: row.content_hash
        })),
        hasMore
      });
    });

    app.post("/vaults/:vaultId/objects/download-urls", async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;

      const params = parseVaultParams(request, reply);
      if (!params) return;
      const { vaultId } = params;
      if (!(await assertVaultOwnership(vaultId, auth.userId))) {
        return reply.code(404).send({ code: "VAULT_NOT_FOUND", message: "vault not found" });
      }

      const parsed = downloadUrlsSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: parsed.error.flatten() });
      }

      const items = [];
      for (const contentHash of parsed.data.contentHashes) {
        const known = await query<{ content_hash: string }>(
          "SELECT content_hash FROM object_blobs WHERE content_hash = $1 LIMIT 1",
          [contentHash]
        );
        if ((known.rowCount ?? 0) === 0) {
          continue;
        }
        items.push({
          contentHash,
          downloadUrl: await objectStore.createDownloadUrl(contentHash)
        });
      }

      return reply.send({ items });
    });
  };
}
