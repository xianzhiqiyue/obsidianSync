import type { SyncPullChange } from "./api-client";
import type { IndexedFileState, LocalDeleteMarker } from "./state-store";

export type PendingDeleteDecision = "keep_local_delete" | "accept_remote";

export function findPendingDeleteMarker(
  markers: Record<string, LocalDeleteMarker>,
  change: Pick<SyncPullChange, "fileId" | "path">
): LocalDeleteMarker | undefined {
  const byPath = markers[change.path];
  if (byPath) return byPath;
  return Object.values(markers).find((marker) => marker.fileId === change.fileId);
}

export function decidePendingDelete(
  marker: LocalDeleteMarker,
  remoteOperationTimeMs: number | undefined
): PendingDeleteDecision {
  if (typeof remoteOperationTimeMs !== "number" || !Number.isFinite(remoteOperationTimeMs)) {
    return "keep_local_delete";
  }
  return marker.ts > remoteOperationTimeMs ? "keep_local_delete" : "accept_remote";
}

export function inferMissingMaterializedDelete(
  indexed: IndexedFileState | undefined,
  localFileExists: boolean,
  operationTimeMs: number
): LocalDeleteMarker | undefined {
  if (!indexed || indexed.materialized !== true || localFileExists) {
    return undefined;
  }
  return {
    fileId: indexed.fileId,
    path: indexed.path,
    baseVersion: indexed.version,
    ts: operationTimeMs
  };
}

export type RemoteFileDecision = "keep_local" | "accept_remote";

export function decideRemoteFileChange(input: {
  localContentHash: string;
  localMtimeMs: number;
  indexedContentHash?: string;
  remoteContentHash?: string;
  remoteOperationTimeMs?: number;
}): RemoteFileDecision {
  if (input.remoteContentHash && input.localContentHash === input.remoteContentHash) {
    return "accept_remote";
  }
  if (input.indexedContentHash && input.localContentHash === input.indexedContentHash) {
    return "accept_remote";
  }
  if (
    typeof input.remoteOperationTimeMs !== "number" ||
    !Number.isFinite(input.remoteOperationTimeMs)
  ) {
    return "keep_local";
  }
  return input.localMtimeMs > input.remoteOperationTimeMs ? "keep_local" : "accept_remote";
}
