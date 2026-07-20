import type { SyncChangeRequest } from "./api-client";
import { isConflictCopyPath as isConflictCopyPathFromConflictCopy } from "./conflict-copy";
import type { IndexedFileState, LocalDeleteMarker, QueuedChange } from "./state-store";

export interface LocalFileSnapshot {
  path: string;
  contentHash: string;
  bytes: ArrayBuffer;
  mtimeMs?: number;
  ctimeMs?: number;
}

export interface LocalSyncPlan {
  source: "fresh" | "replay" | "mixed";
  changes: SyncChangeRequest[];
  queuePreview: QueuedChange[];
  hashToSnapshot: Record<string, LocalFileSnapshot>;
  droppedFailedItems: number;
}

interface PlannerOptions {
  now?: () => number;
  newId?: () => string;
  deleteMarkers?: Record<string, LocalDeleteMarker>;
  clockOffsetMs?: number;
}

interface PlannerRuntimeOptions {
  now: () => number;
  newId: () => string;
  deleteMarkers: Record<string, LocalDeleteMarker>;
  clockOffsetMs: number;
}

const DEFAULT_OPTIONS: PlannerRuntimeOptions = {
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
  deleteMarkers: {},
  clockOffsetMs: 0
};

export function isConflictCopyPath(path: string): boolean {
  return isConflictCopyPathFromConflictCopy(path);
}

export function buildLocalPlan(
  failedQueue: QueuedChange[],
  localSnapshots: Record<string, LocalFileSnapshot>,
  fileIndexByPath: Record<string, IndexedFileState>,
  options?: PlannerOptions
): LocalSyncPlan {
  const freshPlan = planLocalChanges(localSnapshots, fileIndexByPath, options);
  if (failedQueue.length === 0) return freshPlan;

  const replayPlan = planReplayChanges(failedQueue, localSnapshots, fileIndexByPath);
  if (replayPlan.changes.length === 0) {
    return { ...freshPlan, droppedFailedItems: replayPlan.droppedFailedItems };
  }

  const replayKeys = new Set(replayPlan.changes.map(changeIdentity));
  const freshIndexes = freshPlan.changes
    .map((change, index) => ({ change, index }))
    .filter(({ change }) => !replayKeys.has(changeIdentity(change)))
    .map(({ index }) => index);
  const freshChanges = freshIndexes.map((index) => freshPlan.changes[index]!).filter(Boolean);
  const freshQueue = freshIndexes.map((index) => freshPlan.queuePreview[index]!).filter(Boolean);

  return {
    source: freshChanges.length > 0 ? "mixed" : "replay",
    changes: [...replayPlan.changes, ...freshChanges],
    queuePreview: [...replayPlan.queuePreview, ...freshQueue],
    hashToSnapshot: { ...freshPlan.hashToSnapshot, ...replayPlan.hashToSnapshot },
    droppedFailedItems: replayPlan.droppedFailedItems
  };
}

export function planReplayChanges(
  failedQueue: QueuedChange[],
  localSnapshots: Record<string, LocalFileSnapshot>,
  fileIndexByPath: Record<string, IndexedFileState>
): LocalSyncPlan {
  const changes: SyncChangeRequest[] = [];
  const queuePreview: QueuedChange[] = [];
  const hashToSnapshot: Record<string, LocalFileSnapshot> = {};
  let droppedFailedItems = 0;
  const fileIndexByFileId = indexByFileId(fileIndexByPath);
  const seenIds = new Set<string>();

  for (const queued of failedQueue) {
    if (seenIds.has(queued.id)) {
      continue;
    }
    seenIds.add(queued.id);

    const request = toSyncChangeRequest(queued);
    if (!request) {
      droppedFailedItems += 1;
      continue;
    }

    if (!isReplayableChange(request, localSnapshots, fileIndexByFileId)) {
      droppedFailedItems += 1;
      continue;
    }

    if (request.contentHash) {
      const snapshot = localSnapshots[request.path];
      if (!snapshot || snapshot.contentHash !== request.contentHash) {
        droppedFailedItems += 1;
        continue;
      }
      hashToSnapshot[request.contentHash] = snapshot;
    }

    queuePreview.push({ ...queued });
    changes.push(request);
  }

  return {
    source: "replay",
    changes,
    queuePreview,
    hashToSnapshot,
    droppedFailedItems
  };
}

export function planLocalChanges(
  localSnapshots: Record<string, LocalFileSnapshot>,
  fileIndexByPath: Record<string, IndexedFileState>,
  options?: PlannerOptions
): LocalSyncPlan {
  const runtimeOptions = resolveOptions(options);
  const planningTimeMs = runtimeOptions.now();
  const changes: SyncChangeRequest[] = [];
  const queuePreview: QueuedChange[] = [];
  const hashToSnapshot: Record<string, LocalFileSnapshot> = {};
  const indexedPaths = new Set(Object.keys(fileIndexByPath));
  const localPaths = new Set(Object.keys(localSnapshots));
  const addedPaths = new Set(Array.from(localPaths).filter((path) => !indexedPaths.has(path)));
  const removedPaths = new Set(Array.from(indexedPaths).filter((path) => !localPaths.has(path)));

  const removedByHash: Record<string, IndexedFileState[]> = {};
  for (const path of removedPaths) {
    const indexed = fileIndexByPath[path];
    if (!indexed) continue;
    const list = removedByHash[indexed.contentHash] ?? [];
    // 同哈希的新旧路径仍可识别为 rename/move；materialized 只约束“缺失即删除”。
    list.push(indexed);
    removedByHash[indexed.contentHash] = list;
  }

  for (const snapshot of Object.values(localSnapshots)) {
    hashToSnapshot[snapshot.contentHash] = snapshot;
    if (addedPaths.has(snapshot.path)) {
      const candidates = removedByHash[snapshot.contentHash] ?? [];
      const matched = candidates.pop();
      if (matched) {
        const op: SyncChangeRequest["op"] =
          parentPath(matched.path) === parentPath(snapshot.path) ? "rename" : "move";
        const change: SyncChangeRequest = {
          op,
          fileId: matched.fileId,
          path: snapshot.path,
          baseVersion: matched.version,
          operationTimeMs: toServerOperationTime(planningTimeMs, runtimeOptions),
          mtimeMs: snapshot.mtimeMs,
          ...(snapshot.ctimeMs === undefined ? {} : { ctimeMs: snapshot.ctimeMs })
        };
        changes.push(change);
        queuePreview.push(toQueuedChange(change, runtimeOptions));
        removedPaths.delete(matched.path);
        continue;
      }

      const change: SyncChangeRequest = {
        op: "create",
        path: snapshot.path,
        contentHash: snapshot.contentHash,
        operationTimeMs: toServerOperationTime(snapshot.mtimeMs, runtimeOptions),
        mtimeMs: snapshot.mtimeMs,
        ...(snapshot.ctimeMs === undefined ? {} : { ctimeMs: snapshot.ctimeMs })
      };
      changes.push(change);
      queuePreview.push(toQueuedChange(change, runtimeOptions));
      continue;
    }

    const indexed = fileIndexByPath[snapshot.path];
    if (!indexed) {
      continue;
    }

    if (indexed.contentHash !== snapshot.contentHash) {
      const change: SyncChangeRequest = {
        op: "update",
        fileId: indexed.fileId,
        path: snapshot.path,
        baseVersion: indexed.version,
        contentHash: snapshot.contentHash,
        operationTimeMs: toServerOperationTime(snapshot.mtimeMs, runtimeOptions),
        mtimeMs: snapshot.mtimeMs,
        ...(snapshot.ctimeMs === undefined ? {} : { ctimeMs: snapshot.ctimeMs })
      };
      changes.push(change);
      queuePreview.push(toQueuedChange(change, runtimeOptions));
    }
  }

  for (const path of removedPaths) {
    const indexed = fileIndexByPath[path];
    if (!indexed) continue;
    const deleteMarker = runtimeOptions.deleteMarkers[path];
    const markerMatchesCurrentVersion = Boolean(
      deleteMarker &&
      deleteMarker.fileId === indexed.fileId &&
      deleteMarker.baseVersion === indexed.version
    );
    const markerWinsNewerRemoteVersion = Boolean(
      deleteMarker &&
      deleteMarker.fileId === indexed.fileId &&
      deleteMarker.baseVersion !== indexed.version &&
      isLocalDeleteNewerThanIndexedFile(deleteMarker, indexed, runtimeOptions)
    );
    const hasMatchingMarker = markerMatchesCurrentVersion || markerWinsNewerRemoteVersion;
    if (!hasMatchingMarker && indexed.materialized !== true) {
      continue;
    }
    const change: SyncChangeRequest = {
      op: "delete",
      fileId: indexed.fileId,
      path: indexed.path,
      baseVersion: indexed.version,
      operationTimeMs: toServerOperationTime(
        hasMatchingMarker ? deleteMarker!.ts : planningTimeMs,
        runtimeOptions
      )
    };
    changes.push(change);
    queuePreview.push(toQueuedChange(change, runtimeOptions));
  }

  return {
    source: "fresh",
    changes,
    queuePreview,
    hashToSnapshot,
    droppedFailedItems: 0
  };
}

export function toSyncChangeRequest(change: QueuedChange): SyncChangeRequest | null {
  const hasBaseVersion = typeof change.baseVersion === "number" && Number.isFinite(change.baseVersion);
  switch (change.op) {
    case "create":
      if (!change.contentHash) {
        return null;
      }
      return {
        op: "create",
        path: change.path,
        contentHash: change.contentHash,
        operationTimeMs: queuedOperationTime(change),
        mtimeMs: change.mtimeMs,
        ...(change.ctimeMs === undefined ? {} : { ctimeMs: change.ctimeMs })
      };
    case "update":
      if (!change.fileId || !hasBaseVersion || !change.contentHash) {
        return null;
      }
      return {
        op: "update",
        fileId: change.fileId,
        path: change.path,
        baseVersion: change.baseVersion,
        contentHash: change.contentHash,
        operationTimeMs: queuedOperationTime(change),
        mtimeMs: change.mtimeMs,
        ...(change.ctimeMs === undefined ? {} : { ctimeMs: change.ctimeMs })
      };
    case "delete":
      if (!change.fileId || !hasBaseVersion) {
        return null;
      }
      return {
        op: "delete",
        fileId: change.fileId,
        path: change.path,
        baseVersion: change.baseVersion,
        operationTimeMs: queuedOperationTime(change),
        mtimeMs: change.mtimeMs,
        ...(change.ctimeMs === undefined ? {} : { ctimeMs: change.ctimeMs })
      };
    case "rename":
    case "move":
      if (!change.fileId || !hasBaseVersion) {
        return null;
      }
      return {
        op: change.op,
        fileId: change.fileId,
        path: change.path,
        baseVersion: change.baseVersion,
        operationTimeMs: queuedOperationTime(change),
        mtimeMs: change.mtimeMs,
        ...(change.ctimeMs === undefined ? {} : { ctimeMs: change.ctimeMs })
      };
    default:
      return null;
  }
}

export function isReplayableChange(
  change: SyncChangeRequest,
  localSnapshots: Record<string, LocalFileSnapshot>,
  fileIndexByFileId: Record<string, IndexedFileState>
): boolean {
  if (change.op === "create") {
    if (!change.contentHash) {
      return false;
    }
    const local = localSnapshots[change.path];
    return Boolean(local && local.contentHash === change.contentHash);
  }

  if (!change.fileId || typeof change.baseVersion !== "number") {
    return false;
  }
  const indexed = fileIndexByFileId[change.fileId];
  if (!indexed || indexed.version !== change.baseVersion) {
    return false;
  }

  if (change.op === "update") {
    if (!change.contentHash || indexed.path !== change.path) {
      return false;
    }
    const local = localSnapshots[change.path];
    return Boolean(local && local.contentHash === change.contentHash);
  }

  if (change.op === "delete") {
    return !localSnapshots[indexed.path];
  }

  if (change.op === "rename" || change.op === "move") {
    if (indexed.path === change.path) {
      return false;
    }
    if (localSnapshots[indexed.path]) {
      return false;
    }
    return Boolean(localSnapshots[change.path]);
  }

  return false;
}

export function indexByFileId(fileIndexByPath: Record<string, IndexedFileState>): Record<string, IndexedFileState> {
  const result: Record<string, IndexedFileState> = {};
  for (const indexed of Object.values(fileIndexByPath)) {
    result[indexed.fileId] = indexed;
  }
  return result;
}

export function normalizeQueuedChanges(rawQueue: unknown, options?: PlannerOptions): QueuedChange[] {
  if (!Array.isArray(rawQueue)) {
    return [];
  }

  const runtimeOptions = resolveOptions(options);
  const result: QueuedChange[] = [];
  for (const item of rawQueue) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const raw = item as Record<string, unknown>;
    const op = raw.op;
    const path = raw.path;
    if (!isQueuedOp(op) || typeof path !== "string" || path.length === 0) {
      continue;
    }

    const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : runtimeOptions.newId();
    const fileId = typeof raw.fileId === "string" && raw.fileId.length > 0 ? raw.fileId : undefined;
    const baseVersion =
      typeof raw.baseVersion === "number" && Number.isFinite(raw.baseVersion) ? raw.baseVersion : undefined;
    const contentHash = typeof raw.contentHash === "string" && raw.contentHash.length > 0 ? raw.contentHash : undefined;
    const attempts =
      typeof raw.attempts === "number" && Number.isFinite(raw.attempts) && raw.attempts >= 0 ? raw.attempts : 0;
    const rawMtimeMs = raw.mtimeMs;
    const mtimeMs = typeof rawMtimeMs === "number" && Number.isFinite(rawMtimeMs) ? rawMtimeMs : undefined;
    const rawCtimeMs = raw.ctimeMs;
    const ctimeMs = typeof rawCtimeMs === "number" && Number.isFinite(rawCtimeMs) ? rawCtimeMs : undefined;
    const ts = typeof raw.ts === "number" && Number.isFinite(raw.ts) ? raw.ts : runtimeOptions.now();
    const rawOperationTimeMs = raw.operationTimeMs;
    const operationTimeMs =
      typeof rawOperationTimeMs === "number" && Number.isFinite(rawOperationTimeMs)
        ? rawOperationTimeMs
        : mtimeMs ?? ts;

    result.push({
      id,
      op,
      path,
      fileId,
      baseVersion,
      contentHash,
      operationTimeMs,
      ...(mtimeMs === undefined ? {} : { mtimeMs }),
      ...(ctimeMs === undefined ? {} : { ctimeMs }),
      attempts,
      ts
    });
  }

  return result;
}

function isQueuedOp(value: unknown): value is QueuedChange["op"] {
  return value === "create" || value === "update" || value === "delete" || value === "rename" || value === "move";
}

function parentPath(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx < 0) {
    return "";
  }
  return path.slice(0, idx);
}

function isLocalDeleteNewerThanIndexedFile(
  deleteMarker: LocalDeleteMarker,
  indexed: IndexedFileState,
  options: PlannerRuntimeOptions
): boolean {
  const remoteOperationTimeMs = indexed.operationTimeMs ?? indexed.mtimeMs;
  return typeof remoteOperationTimeMs === "number" && toServerOperationTime(deleteMarker.ts, options) > remoteOperationTimeMs;
}

function toServerOperationTime(localTimeMs: number | undefined, options: PlannerRuntimeOptions): number {
  return (localTimeMs ?? options.now()) + options.clockOffsetMs;
}

function toQueuedChange(change: SyncChangeRequest, options: PlannerRuntimeOptions, attempts = 0): QueuedChange {
  return {
    id: options.newId(),
    op: change.op,
    path: change.path,
    fileId: change.fileId,
    baseVersion: change.baseVersion,
    contentHash: change.contentHash,
    operationTimeMs: change.operationTimeMs,
    ...(change.mtimeMs === undefined ? {} : { mtimeMs: change.mtimeMs }),
    ...(change.ctimeMs === undefined ? {} : { ctimeMs: change.ctimeMs }),
    attempts,
    ts: options.now()
  };
}

function changeIdentity(change: SyncChangeRequest): string {
  return [
    change.op,
    change.fileId ?? "-",
    change.path,
    change.baseVersion ?? "-",
    change.contentHash ?? "-"
  ].join(":");
}

function queuedOperationTime(change: QueuedChange): number {
  return change.operationTimeMs ?? change.mtimeMs ?? change.ts;
}

export function markLocalSnapshotsMaterialized(
  fileIndexByPath: Record<string, IndexedFileState>,
  localSnapshots: Record<string, LocalFileSnapshot>
): Record<string, IndexedFileState> {
  let changed = false;
  const result = { ...fileIndexByPath };
  for (const path of Object.keys(localSnapshots)) {
    const indexed = result[path];
    if (indexed && indexed.materialized !== true) {
      result[path] = { ...indexed, materialized: true };
      changed = true;
    }
  }
  return changed ? result : fileIndexByPath;
}

function resolveOptions(options?: PlannerOptions): PlannerRuntimeOptions {
  return {
    now: options?.now ?? DEFAULT_OPTIONS.now,
    newId: options?.newId ?? DEFAULT_OPTIONS.newId,
    deleteMarkers: options?.deleteMarkers ?? DEFAULT_OPTIONS.deleteMarkers,
    clockOffsetMs: options?.clockOffsetMs ?? DEFAULT_OPTIONS.clockOffsetMs
  };
}
