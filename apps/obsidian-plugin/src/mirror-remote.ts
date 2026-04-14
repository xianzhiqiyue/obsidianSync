import type { IndexedFileState } from "./state-store";
import type { SyncPathDecision } from "./sync-settings";

export type MirrorRemoteAction =
  | { op: "delete"; path: string; reason: "local_only" }
  | { op: "restore"; path: string; contentHash: string; reason: "local_modified" };

export interface LocalMirrorFileState {
  path: string;
  contentHash: string;
}

export function planMirrorRemoteActions(
  localFiles: LocalMirrorFileState[],
  remoteIndexByPath: Record<string, IndexedFileState>,
  shouldSyncPath: (path: string) => SyncPathDecision
): MirrorRemoteAction[] {
  const actions: MirrorRemoteAction[] = [];

  for (const file of localFiles) {
    const decision = shouldSyncPath(file.path);
    if (!decision.sync) {
      continue;
    }

    const remote = remoteIndexByPath[file.path];
    if (!remote) {
      actions.push({ op: "delete", path: file.path, reason: "local_only" });
      continue;
    }

    if (remote.contentHash !== file.contentHash) {
      actions.push({
        op: "restore",
        path: file.path,
        contentHash: remote.contentHash,
        reason: "local_modified"
      });
    }
  }

  return actions;
}
