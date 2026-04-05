import type { SyncChangeRequest, SyncConflict } from "./api-client";
import type { IndexedFileState } from "./state-store";

const CONFLICT_COPY_MARKER = ".conflict-";

export function shouldCreateConflictCopy(changePath: string, conflict: SyncConflict): boolean {
  if (conflict.code !== "VERSION_CONFLICT" && conflict.code !== "PATH_CONFLICT") {
    return false;
  }

  return !changePath.includes(CONFLICT_COPY_MARKER);
}

export function pruneMissingFileIndexEntries(
  fileIndexByPath: Record<string, IndexedFileState>,
  changes: SyncChangeRequest[],
  conflicts: SyncConflict[]
): Record<string, IndexedFileState> {
  const staleFileIds = new Set<string>();
  const stalePaths = new Set<string>();

  for (const conflict of conflicts) {
    if (conflict.code !== "FILE_NOT_FOUND") {
      continue;
    }

    if (conflict.fileId) {
      staleFileIds.add(conflict.fileId);
    }
    stalePaths.add(conflict.path);

    const change = changes[conflict.index];
    if (!change) {
      continue;
    }

    if (change.fileId) {
      staleFileIds.add(change.fileId);
    }
    stalePaths.add(change.path);
  }

  if (staleFileIds.size === 0 && stalePaths.size === 0) {
    return fileIndexByPath;
  }

  const nextIndex: Record<string, IndexedFileState> = {};
  for (const [path, entry] of Object.entries(fileIndexByPath)) {
    if (stalePaths.has(path) || staleFileIds.has(entry.fileId)) {
      continue;
    }
    nextIndex[path] = entry;
  }

  return nextIndex;
}
