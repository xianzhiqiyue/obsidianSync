import type { SyncChangeRequest } from "./api-client";
import type { IndexedFileState, QueuedChange } from "./state-store";

export interface LocalFileSnapshot {
  path: string;
  contentHash: string;
  bytes: ArrayBuffer;
}

export interface LocalSyncPlan {
  source: "fresh" | "replay";
  changes: SyncChangeRequest[];
  queuePreview: QueuedChange[];
  hashToSnapshot: Record<string, LocalFileSnapshot>;
  droppedFailedItems: number;
}

interface PlannerOptions {
  now?: () => number;
  newId?: () => string;
}

interface PlannerRuntimeOptions {
  now: () => number;
  newId: () => string;
}

const DEFAULT_OPTIONS: PlannerRuntimeOptions = {
  now: () => Date.now(),
  newId: () => crypto.randomUUID()
};

export function buildLocalPlan(
  failedQueue: QueuedChange[],
  localSnapshots: Record<string, LocalFileSnapshot>,
  fileIndexByPath: Record<string, IndexedFileState>,
  options?: PlannerOptions
): LocalSyncPlan {
  if (failedQueue.length > 0) {
    const replayPlan = planReplayChanges(failedQueue, localSnapshots, fileIndexByPath);
    if (replayPlan.changes.length > 0) {
      return replayPlan;
    }
  }

  return planLocalChanges(localSnapshots, fileIndexByPath, options);
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
          baseVersion: matched.version
        };
        changes.push(change);
        queuePreview.push(toQueuedChange(change, runtimeOptions));
        removedPaths.delete(matched.path);
        continue;
      }

      const change: SyncChangeRequest = {
        op: "create",
        path: snapshot.path,
        contentHash: snapshot.contentHash
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
        contentHash: snapshot.contentHash
      };
      changes.push(change);
      queuePreview.push(toQueuedChange(change, runtimeOptions));
    }
  }

  for (const path of removedPaths) {
    const indexed = fileIndexByPath[path];
    if (!indexed) continue;
    const change: SyncChangeRequest = {
      op: "delete",
      fileId: indexed.fileId,
      path: indexed.path,
      baseVersion: indexed.version
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
        contentHash: change.contentHash
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
        contentHash: change.contentHash
      };
    case "delete":
      if (!change.fileId || !hasBaseVersion) {
        return null;
      }
      return {
        op: "delete",
        fileId: change.fileId,
        path: change.path,
        baseVersion: change.baseVersion
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
        baseVersion: change.baseVersion
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
    const ts = typeof raw.ts === "number" && Number.isFinite(raw.ts) ? raw.ts : runtimeOptions.now();

    result.push({
      id,
      op,
      path,
      fileId,
      baseVersion,
      contentHash,
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

function toQueuedChange(change: SyncChangeRequest, options: PlannerRuntimeOptions, attempts = 0): QueuedChange {
  return {
    id: options.newId(),
    op: change.op,
    path: change.path,
    fileId: change.fileId,
    baseVersion: change.baseVersion,
    contentHash: change.contentHash,
    attempts,
    ts: options.now()
  };
}

function resolveOptions(options?: PlannerOptions): PlannerRuntimeOptions {
  return {
    now: options?.now ?? DEFAULT_OPTIONS.now,
    newId: options?.newId ?? DEFAULT_OPTIONS.newId
  };
}
