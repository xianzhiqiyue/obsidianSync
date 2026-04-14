import type { SyncPullChange } from "./api-client";
import type { IndexedFileState } from "./state-store";

export function applyRemoteChangesToIndex(
  currentIndex: Record<string, IndexedFileState>,
  remoteChanges: SyncPullChange[]
): Record<string, IndexedFileState> {
  const nextIndex = { ...currentIndex };
  const pathByFileId: Record<string, string> = {};

  for (const [path, entry] of Object.entries(nextIndex)) {
    pathByFileId[entry.fileId] = path;
  }

  for (const change of remoteChanges) {
    const previousPath = pathByFileId[change.fileId];

    if (change.op === "delete") {
      if (previousPath && nextIndex[previousPath]?.fileId === change.fileId) {
        delete nextIndex[previousPath];
      }

      if (nextIndex[change.path]?.fileId === change.fileId) {
        delete nextIndex[change.path];
      }

      if (!previousPath) {
        for (const [path, entry] of Object.entries(nextIndex)) {
          if (entry.fileId === change.fileId) {
            delete nextIndex[path];
          }
        }
      }

      delete pathByFileId[change.fileId];
      continue;
    }

    if (previousPath && previousPath !== change.path && nextIndex[previousPath]?.fileId === change.fileId) {
      delete nextIndex[previousPath];
    }

    const targetEntry = nextIndex[change.path];
    if (targetEntry && targetEntry.fileId !== change.fileId) {
      delete pathByFileId[targetEntry.fileId];
    }

    nextIndex[change.path] = {
      fileId: change.fileId,
      path: change.path,
      version: change.version,
      contentHash: change.contentHash,
      ...(change.mtimeMs === undefined ? {} : { mtimeMs: change.mtimeMs }),
      ...(change.ctimeMs === undefined ? {} : { ctimeMs: change.ctimeMs })
    };
    pathByFileId[change.fileId] = change.path;
  }

  return nextIndex;
}
