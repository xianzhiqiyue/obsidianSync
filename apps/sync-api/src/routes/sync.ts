import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { appConfig } from "../config.js";
import { query, withTransaction } from "../db.js";
import { metricsRegistry } from "../metrics.js";
import type { ObjectStore } from "../object-store.js";
import { publishSyncCheckpoint, subscribeToSyncEvents } from "../sync-events.js";

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
  contentHash: contentHashSchema.optional(),
  mtimeMs: z.number().int().nonnegative().optional(),
  ctimeMs: z.number().int().nonnegative().optional(),
  operationTimeMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
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

const fileVersionDownloadParamsSchema = z.object({
  vaultId: z.string().uuid(),
  fileId: z.string().uuid(),
  version: z.coerce.number().int().positive()
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
  mtime_ms: string | null;
  ctime_ms: string | null;
  operation_time_ms: string;
  event_index: number;
  source?: string;
  reason?: string | null;
  admin_operation_id?: string | null;
}

interface TombstoneRow {
  path: string;
  operation_time_ms: string;
}

interface SnapshotFileRow {
  file_id: string;
  path: string;
  version: number;
  content_hash: string;
  mtime_ms: string | null;
  ctime_ms: string | null;
  operation_time_ms: string;
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
  remoteContentHash?: string;
  remoteMtimeMs?: number;
  remoteCtimeMs?: number;
  remoteOperationTimeMs?: number;
}

interface UploadTarget {
  contentHash: string;
  uploadUrl: string;
}

class SyncCommitConflict extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
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

async function getActiveTombstoneByPath(vaultId: string, path: string): Promise<TombstoneRow | null> {
  const result = await query<TombstoneRow>(
    `SELECT path, operation_time_ms
     FROM tombstones
     WHERE vault_id = $1
       AND path = $2
       AND expire_at > NOW()
     ORDER BY operation_time_ms DESC, deleted_at DESC, id DESC
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

async function fetchLatestVersionMetadata(
  client: { query: typeof query },
  fileId: string
): Promise<{ contentHash: string; mtimeMs?: number; ctimeMs?: number; operationTimeMs: number }> {
  const row = await client.query<{
    content_hash: string;
    mtime_ms: string | null;
    ctime_ms: string | null;
    operation_time_ms: string;
  }>(
    `SELECT content_hash, mtime_ms, ctime_ms, operation_time_ms
     FROM file_versions
     WHERE file_id = $1
     ORDER BY version DESC
     LIMIT 1`,
    [fileId]
  );
  const version = row.rows[0];
  if (!version) {
    throw new Error("missing latest version metadata");
  }
  return {
    contentHash: version.content_hash,
    mtimeMs: version.mtime_ms === null ? undefined : Number(version.mtime_ms),
    ctimeMs: version.ctime_ms === null ? undefined : Number(version.ctime_ms),
    operationTimeMs: Number(version.operation_time_ms)
  };
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
    app.get("/vaults/:vaultId/sync/stream", async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;

      const params = parseVaultParams(request, reply);
      if (!params) return;
      const { vaultId } = params;
      if (!(await assertVaultOwnership(vaultId, auth.userId))) {
        return reply.code(404).send({ code: "VAULT_NOT_FOUND", message: "vault not found" });
      }

      const checkpoint = await ensureCheckpointRow(vaultId);
      subscribeToSyncEvents(reply, vaultId, auth.deviceId, `cp_${checkpoint}`);
    });

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

    app.get("/vaults/:vaultId/sync/snapshot", async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;

      const params = parseVaultParams(request, reply);
      if (!params) return;
      const { vaultId } = params;
      if (!(await assertVaultOwnership(vaultId, auth.userId))) {
        return reply.code(404).send({ code: "VAULT_NOT_FOUND", message: "vault not found" });
      }

      await ensureCheckpointRow(vaultId);
      const snapshot = await withTransaction(async (client) => {
        // 与 commit 共用 checkpoint 行锁，保证 manifest 与返回的 checkpoint 属于同一状态。
        const checkpointResult = await client.query<CheckpointRow>(
          `SELECT latest_checkpoint
           FROM vault_sync_state
           WHERE vault_id = $1
           FOR SHARE`,
          [vaultId]
        );
        const filesResult = await client.query<SnapshotFileRow>(
          `SELECT file_entry.id AS file_id,
                  file_entry.current_path AS path,
                  file_entry.head_version AS version,
                  file_version.content_hash,
                  file_version.mtime_ms,
                  file_version.ctime_ms,
                  file_version.operation_time_ms
           FROM file_entries AS file_entry
           JOIN file_versions AS file_version
             ON file_version.file_id = file_entry.id
            AND file_version.version = file_entry.head_version
           WHERE file_entry.vault_id = $1
             AND file_entry.deleted_at IS NULL
           ORDER BY file_entry.current_path ASC, file_entry.id ASC`,
          [vaultId]
        );
        const deletedFilesResult = await client.query<SnapshotFileRow>(
          `SELECT file_entry.id AS file_id,
                  file_entry.current_path AS path,
                  file_entry.head_version AS version,
                  file_version.content_hash,
                  file_version.mtime_ms,
                  file_version.ctime_ms,
                  file_version.operation_time_ms
           FROM file_entries AS file_entry
           JOIN file_versions AS file_version
             ON file_version.file_id = file_entry.id
            AND file_version.version = file_entry.head_version
           WHERE file_entry.vault_id = $1
             AND file_entry.deleted_at IS NOT NULL
           ORDER BY file_entry.current_path ASC, file_entry.id ASC`,
          [vaultId]
        );
        return {
          checkpoint: Number(checkpointResult.rows[0]?.latest_checkpoint ?? 0),
          files: filesResult.rows,
          deletedFiles: deletedFilesResult.rows
        };
      });

      return reply.send({
        checkpoint: `cp_${snapshot.checkpoint}`,
        files: snapshot.files.map(toSnapshotFile),
        deletedFiles: snapshot.deletedFiles.map(toSnapshotFile)
      });

      function toSnapshotFile(file: SnapshotFileRow) {
        return {
          fileId: file.file_id,
          path: file.path,
          version: file.version,
          contentHash: file.content_hash,
          mtimeMs: file.mtime_ms === null ? undefined : Number(file.mtime_ms),
          ctimeMs: file.ctime_ms === null ? undefined : Number(file.ctime_ms),
          operationTimeMs: Number(file.operation_time_ms)
        };
      }
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
        const normalizedChange: SyncChangeInput = {
          ...change,
          operationTimeMs: change.operationTimeMs ?? Date.now()
        };

        if (change.op === "create") {
          const occupiedEntry = await getActiveFileEntryByPath(vaultId, change.path);
          if (occupiedEntry) {
            const remoteMetadata = await fetchLatestVersionMetadata({ query }, occupiedEntry.id);
            conflicts.push({
              index,
              code: "PATH_CONFLICT",
              path: change.path,
              message: "path already exists",
              reason: "path_exists",
              remotePath: occupiedEntry.current_path,
              headVersion: occupiedEntry.head_version,
              existingFileId: occupiedEntry.id,
              remoteDeleted: false,
              remoteContentHash: remoteMetadata.contentHash,
              remoteMtimeMs: remoteMetadata.mtimeMs,
              remoteCtimeMs: remoteMetadata.ctimeMs,
              remoteOperationTimeMs: remoteMetadata.operationTimeMs
            });
            continue;
          }
          const tombstone = await getActiveTombstoneByPath(vaultId, change.path);
          const tombstoneOperationTimeMs = tombstone ? Number(tombstone.operation_time_ms) : undefined;
          if (
            tombstoneOperationTimeMs !== undefined &&
            (change.operationTimeMs === undefined || change.operationTimeMs <= tombstoneOperationTimeMs)
          ) {
            conflicts.push({
              index,
              code: "PATH_TOMBSTONE_CONFLICT",
              path: change.path,
              message: "create operation is not newer than the path tombstone",
              reason: change.operationTimeMs === undefined ? "missing_operation_time" : "stale_operation_time",
              remotePath: change.path,
              remoteDeleted: true,
              remoteOperationTimeMs: tombstoneOperationTimeMs
            });
            continue;
          }
          normalizedChanges.push(normalizedChange);
          continue;
        }

        const fileEntry = await getFileEntry(vaultId, change.fileId!);
        if (!fileEntry || fileEntry.deleted_at) {
          const remoteMetadata = fileEntry ? await fetchLatestVersionMetadata({ query }, fileEntry.id) : null;
          conflicts.push({
            index,
            code: "FILE_NOT_FOUND",
            fileId: change.fileId,
            path: change.path,
            message: "file not found or deleted",
            reason: fileEntry?.deleted_at ? "deleted_on_server" : "unknown_file_id",
            remotePath: fileEntry?.current_path,
            headVersion: fileEntry?.head_version,
            remoteDeleted: Boolean(fileEntry?.deleted_at),
            remoteContentHash: remoteMetadata?.contentHash,
            remoteMtimeMs: remoteMetadata?.mtimeMs,
            remoteCtimeMs: remoteMetadata?.ctimeMs,
            remoteOperationTimeMs: remoteMetadata?.operationTimeMs
          });
          continue;
        }

        if (await isNoopUpdate(vaultId, change)) {
          continue;
        }

        const remoteMetadata = await fetchLatestVersionMetadata({ query }, fileEntry.id);
        if (fileEntry.head_version !== change.baseVersion) {
          if (normalizedChange.operationTimeMs! > remoteMetadata.operationTimeMs) {
            normalizedChanges.push({
              ...normalizedChange,
              path: change.op === "update" || change.op === "delete" ? fileEntry.current_path : change.path,
              baseVersion: fileEntry.head_version
            });
            continue;
          }
          conflicts.push({
            index,
            code: "VERSION_CONFLICT",
            fileId: change.fileId,
            path: change.path,
            message: `baseVersion ${change.baseVersion} does not match headVersion ${fileEntry.head_version}`,
            reason: "base_version_mismatch",
            headVersion: fileEntry.head_version,
            remotePath: fileEntry.current_path,
            remoteDeleted: false,
            remoteContentHash: remoteMetadata.contentHash,
            remoteMtimeMs: remoteMetadata.mtimeMs,
            remoteCtimeMs: remoteMetadata.ctimeMs,
            remoteOperationTimeMs: remoteMetadata.operationTimeMs
          });
          continue;
        }

        if (normalizedChange.operationTimeMs! <= remoteMetadata.operationTimeMs) {
          conflicts.push({
            index,
            code: "VERSION_CONFLICT",
            fileId: change.fileId,
            path: change.path,
            message: "operation is not newer than the remote head",
            reason: "stale_operation_time",
            headVersion: fileEntry.head_version,
            remotePath: fileEntry.current_path,
            remoteDeleted: false,
            remoteContentHash: remoteMetadata.contentHash,
            remoteMtimeMs: remoteMetadata.mtimeMs,
            remoteCtimeMs: remoteMetadata.ctimeMs,
            remoteOperationTimeMs: remoteMetadata.operationTimeMs
          });
          continue;
        }

        if ((change.op === "update" || change.op === "delete") && change.path !== fileEntry.current_path) {
          conflicts.push({
            index,
            code: "VERSION_CONFLICT",
            fileId: change.fileId,
            path: change.path,
            message: "path does not match the remote head",
            reason: "remote_path_mismatch",
            headVersion: fileEntry.head_version,
            remotePath: fileEntry.current_path,
            remoteDeleted: false,
            remoteContentHash: remoteMetadata.contentHash,
            remoteMtimeMs: remoteMetadata.mtimeMs,
            remoteCtimeMs: remoteMetadata.ctimeMs,
            remoteOperationTimeMs: remoteMetadata.operationTimeMs
          });
          continue;
        }

        const occupiedTarget =
          change.op === "rename" || change.op === "move"
            ? await getActiveFileEntryByPath(vaultId, change.path, fileEntry.id)
            : null;
        if (occupiedTarget) {
          const remoteMetadata = await fetchLatestVersionMetadata({ query }, occupiedTarget.id);
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
            remoteDeleted: false,
            remoteContentHash: remoteMetadata.contentHash,
            remoteMtimeMs: remoteMetadata.mtimeMs,
            remoteCtimeMs: remoteMetadata.ctimeMs,
            remoteOperationTimeMs: remoteMetadata.operationTimeMs
          });
          continue;
        }

        normalizedChanges.push(normalizedChange);
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
        const tombstoneConflict = prepare.conflicts_json.find(
          (conflict) => conflict.code === "PATH_TOMBSTONE_CONFLICT"
        );
        return reply.code(409).send({
          code: tombstoneConflict?.code ?? "VERSION_CONFLICT",
          message: "prepare has conflicts",
          conflicts: prepare.conflicts_json
        });
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

          for (const [eventIndex, change] of changes.entries()) {
            const operationTimeMs = change.operationTimeMs ?? Date.now();
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
                throw new SyncCommitConflict("PATH_CONFLICT", "create path already exists", {
                  path: change.path
                });
              }
              const tombstoneResult = await client.query<TombstoneRow>(
                `SELECT path, operation_time_ms
                 FROM tombstones
                 WHERE vault_id = $1
                   AND path = $2
                   AND expire_at > NOW()
                 ORDER BY operation_time_ms DESC, deleted_at DESC, id DESC
                 LIMIT 1`,
                [vaultId, change.path]
              );
              const tombstone = tombstoneResult.rows[0];
              const tombstoneOperationTimeMs = tombstone ? Number(tombstone.operation_time_ms) : undefined;
              if (
                tombstoneOperationTimeMs !== undefined &&
                (change.operationTimeMs === undefined || change.operationTimeMs <= tombstoneOperationTimeMs)
              ) {
                throw new SyncCommitConflict(
                  "PATH_TOMBSTONE_CONFLICT",
                  "create operation is not newer than the path tombstone",
                  {
                    path: change.path,
                    remoteOperationTimeMs: tombstoneOperationTimeMs
                  }
                );
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
                `INSERT INTO file_versions
                   (file_id, version, content_hash, author_device_id, mtime_ms, ctime_ms, operation_time_ms)
                 VALUES ($1, 1, $2, $3, $4, $5, $6)`,
                [fileId, change.contentHash, auth.deviceId, change.mtimeMs, change.ctimeMs, operationTimeMs]
              );
              await client.query(
                `INSERT INTO change_events
                   (vault_id, changeset_id, checkpoint, event_index, op, file_id, path, version,
                    content_hash, mtime_ms, ctime_ms, operation_time_ms)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                [
                  vaultId,
                  changesetId,
                  nextCheckpoint,
                  eventIndex,
                  "create",
                  fileId,
                  change.path,
                  1,
                  change.contentHash,
                  change.mtimeMs,
                  change.ctimeMs,
                  operationTimeMs
                ]
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
              const remoteMetadata = file ? await fetchLatestVersionMetadata(client, file.id) : null;
              throw new SyncCommitConflict("FILE_NOT_FOUND", `file missing ${change.fileId}`, {
                fileId: change.fileId,
                path: change.path,
                remoteDeleted: Boolean(file?.deleted_at),
                ...(file ? { headVersion: file.head_version, remotePath: file.current_path } : {}),
                ...(remoteMetadata
                  ? {
                      remoteContentHash: remoteMetadata.contentHash,
                      remoteMtimeMs: remoteMetadata.mtimeMs,
                      remoteCtimeMs: remoteMetadata.ctimeMs,
                      remoteOperationTimeMs: remoteMetadata.operationTimeMs
                    }
                  : {})
              });
            }
            if (file.head_version !== change.baseVersion) {
              const remoteMetadata = await fetchLatestVersionMetadata(client, file.id);
              throw new SyncCommitConflict("VERSION_CONFLICT", `version conflict for file ${change.fileId}`, {
                fileId: change.fileId,
                path: change.path,
                headVersion: file.head_version,
                remotePath: file.current_path,
                remoteDeleted: false,
                remoteContentHash: remoteMetadata.contentHash,
                remoteMtimeMs: remoteMetadata.mtimeMs,
                remoteCtimeMs: remoteMetadata.ctimeMs,
                remoteOperationTimeMs: remoteMetadata.operationTimeMs
              });
            }

            if ((change.op === "update" || change.op === "delete") && change.path !== file.current_path) {
              const remoteMetadata = await fetchLatestVersionMetadata(client, file.id);
              throw new SyncCommitConflict("VERSION_CONFLICT", "path does not match the remote head", {
                fileId: change.fileId,
                path: change.path,
                headVersion: file.head_version,
                remotePath: file.current_path,
                remoteDeleted: false,
                remoteContentHash: remoteMetadata.contentHash,
                remoteMtimeMs: remoteMetadata.mtimeMs,
                remoteCtimeMs: remoteMetadata.ctimeMs,
                remoteOperationTimeMs: remoteMetadata.operationTimeMs
              });
            }

            const nextVersion = file.head_version + 1;
            const currentMetadata = await fetchLatestVersionMetadata(client, file.id);
            if (operationTimeMs <= currentMetadata.operationTimeMs) {
              throw new SyncCommitConflict("VERSION_CONFLICT", "operation is not newer than the remote head", {
                fileId: change.fileId,
                path: change.path,
                headVersion: file.head_version,
                remotePath: file.current_path,
                remoteDeleted: false,
                remoteContentHash: currentMetadata.contentHash,
                remoteMtimeMs: currentMetadata.mtimeMs,
                remoteCtimeMs: currentMetadata.ctimeMs,
                remoteOperationTimeMs: currentMetadata.operationTimeMs
              });
            }
            const currentHash = currentMetadata.contentHash;

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
                `INSERT INTO file_versions
                   (file_id, version, content_hash, author_device_id, mtime_ms, ctime_ms, operation_time_ms)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                  file.id,
                  nextVersion,
                  change.contentHash,
                  auth.deviceId,
                  change.mtimeMs,
                  change.ctimeMs,
                  operationTimeMs
                ]
              );
              await client.query(
                `INSERT INTO change_events
                   (vault_id, changeset_id, checkpoint, event_index, op, file_id, path, version,
                    content_hash, mtime_ms, ctime_ms, operation_time_ms)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                [
                  vaultId,
                  changesetId,
                  nextCheckpoint,
                  eventIndex,
                  "update",
                  file.id,
                  change.path,
                  nextVersion,
                  change.contentHash,
                  change.mtimeMs,
                  change.ctimeMs,
                  operationTimeMs
                ]
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
                `INSERT INTO file_versions
                   (file_id, version, content_hash, author_device_id, mtime_ms, ctime_ms, operation_time_ms)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [file.id, nextVersion, currentHash, auth.deviceId, change.mtimeMs, change.ctimeMs, operationTimeMs]
              );
              await client.query(
                `INSERT INTO tombstones (vault_id, file_id, path, operation_time_ms, deleted_at, expire_at)
                 VALUES ($1, $2, $3, $4, NOW(), NOW() + ($5 * INTERVAL '1 day'))`,
                [vaultId, file.id, file.current_path, operationTimeMs, appConfig.tombstoneRetentionDays]
              );
              await client.query(
                `INSERT INTO change_events
                   (vault_id, changeset_id, checkpoint, event_index, op, file_id, path, version,
                    content_hash, mtime_ms, ctime_ms, operation_time_ms)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                [
                  vaultId,
                  changesetId,
                  nextCheckpoint,
                  eventIndex,
                  "delete",
                  file.id,
                  file.current_path,
                  nextVersion,
                  currentHash,
                  change.mtimeMs,
                  change.ctimeMs,
                  operationTimeMs
                ]
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
                throw new SyncCommitConflict("PATH_CONFLICT", `path conflict for ${change.path}`, {
                  fileId: change.fileId,
                  path: change.path
                });
              }

              await client.query(
                `UPDATE file_entries
                 SET head_version = $1, current_path = $2
                 WHERE id = $3`,
                [nextVersion, change.path, file.id]
              );
              await client.query(
                `INSERT INTO file_versions
                   (file_id, version, content_hash, author_device_id, mtime_ms, ctime_ms, operation_time_ms)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [file.id, nextVersion, currentHash, auth.deviceId, change.mtimeMs, change.ctimeMs, operationTimeMs]
              );
              await client.query(
                `INSERT INTO change_events
                   (vault_id, changeset_id, checkpoint, event_index, op, file_id, path, version,
                    content_hash, mtime_ms, ctime_ms, operation_time_ms)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                [
                  vaultId,
                  changesetId,
                  nextCheckpoint,
                  eventIndex,
                  change.op,
                  file.id,
                  change.path,
                  nextVersion,
                  currentHash,
                  change.mtimeMs,
                  change.ctimeMs,
                  operationTimeMs
                ]
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
        if (commitResponse.appliedChanges > 0) {
          publishSyncCheckpoint({
            vaultId,
            checkpoint: commitResponse.newCheckpoint,
            changesetId: commitResponse.changesetId,
            authorDeviceId: auth.deviceId,
            ts: new Date().toISOString()
          });
        }
        return reply.send(commitResponse);
      } catch (error) {
        request.log.error({ err: error }, "sync commit failed");
        metricsRegistry.incCounter("sync_api_sync_commit_total", { result: "failed" });
        if (error instanceof SyncCommitConflict) {
          return reply.code(409).send({
            code: error.code,
            message: error.message,
            ...error.details
          });
        }
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
      // checkpoint 是不可拆分的提交单元；limit 只用于选择最后一个完整 checkpoint。
      const boundaryResult = await query<{ checkpoint: string }>(
        `SELECT checkpoint
         FROM change_events
         WHERE vault_id = $1
           AND checkpoint > $2
           AND checkpoint <= $3
         ORDER BY checkpoint ASC, event_index ASC
         OFFSET $4
         LIMIT 1`,
        [vaultId, parsed.data.fromCheckpoint, latestCheckpoint, limit - 1]
      );
      const boundaryCheckpoint = boundaryResult.rows[0]
        ? Number(boundaryResult.rows[0].checkpoint)
        : latestCheckpoint;
      const result = await query<ChangeEventRow>(
        `SELECT checkpoint, event_index, op, file_id, path, version, content_hash,
                mtime_ms, ctime_ms, operation_time_ms, source, reason, admin_operation_id
         FROM change_events
         WHERE vault_id = $1
           AND checkpoint > $2
           AND checkpoint <= $3
         ORDER BY checkpoint ASC, event_index ASC`,
        [vaultId, parsed.data.fromCheckpoint, boundaryCheckpoint]
      );

      const moreResult = await query<{ has_more: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM change_events
           WHERE vault_id = $1
             AND checkpoint > $2
             AND checkpoint <= $3
         ) AS has_more`,
        [vaultId, boundaryCheckpoint, latestCheckpoint]
      );
      const hasMore = moreResult.rows[0]?.has_more ?? false;
      const toCheckpoint = hasMore ? boundaryCheckpoint : latestCheckpoint;
      metricsRegistry.incCounter("sync_api_sync_pull_total", { result: "success" });
      metricsRegistry.incCounter("sync_api_sync_pull_changes_total", {}, result.rows.length);

      return reply.send({
        fromCheckpoint: `cp_${parsed.data.fromCheckpoint}`,
        toCheckpoint: `cp_${toCheckpoint}`,
        changes: result.rows.map((row) => ({
          op: row.op,
          fileId: row.file_id,
          path: row.path,
          version: row.version,
          contentHash: row.content_hash,
          mtimeMs: row.mtime_ms === null ? undefined : Number(row.mtime_ms),
          ctimeMs: row.ctime_ms === null ? undefined : Number(row.ctime_ms),
          operationTimeMs: Number(row.operation_time_ms),
          source: row.source ?? "device",
          reason: row.reason ?? undefined,
          adminOperationId: row.admin_operation_id ?? undefined
        })),
        hasMore
      });
    });


    app.post("/vaults/:vaultId/files/:fileId/versions/:version/download-url", async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;

      const parsedParams = fileVersionDownloadParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ code: "INVALID_PARAMS", message: parsedParams.error.flatten() });
      }
      const { vaultId, fileId, version } = parsedParams.data;
      if (!(await assertVaultOwnership(vaultId, auth.userId))) {
        return reply.code(404).send({ code: "VAULT_NOT_FOUND", message: "vault not found" });
      }

      const result = await query<{ content_hash: string }>(
        `SELECT fv.content_hash
         FROM file_versions fv
         JOIN file_entries fe ON fe.id = fv.file_id
         WHERE fe.vault_id = $1
           AND fv.file_id = $2
           AND fv.version = $3
         LIMIT 1`,
        [vaultId, fileId, version]
      );
      const row = result.rows[0];
      if (!row) {
        return reply.code(404).send({ code: "FILE_VERSION_NOT_FOUND", message: "file version not found" });
      }

      return reply.send({
        fileId,
        version,
        contentHash: row.content_hash,
        downloadUrl: await objectStore.createDownloadUrl(row.content_hash)
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
