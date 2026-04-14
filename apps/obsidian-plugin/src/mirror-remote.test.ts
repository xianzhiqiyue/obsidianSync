import assert from "node:assert/strict";
import test from "node:test";
import { planMirrorRemoteActions } from "./mirror-remote";
import type { IndexedFileState } from "./state-store";

const remoteIndex: Record<string, IndexedFileState> = {
  "notes/a.md": { fileId: "a", path: "notes/a.md", version: 1, contentHash: "sha256:remote-a" },
  "notes/b.md": { fileId: "b", path: "notes/b.md", version: 1, contentHash: "sha256:same" }
};

test("planMirrorRemoteActions deletes local-only files and restores modified indexed files", () => {
  const actions = planMirrorRemoteActions(
    [
      { path: "notes/a.md", contentHash: "sha256:local-a" },
      { path: "notes/b.md", contentHash: "sha256:same" },
      { path: "notes/local-only.md", contentHash: "sha256:local-only" }
    ],
    remoteIndex,
    () => ({ sync: true })
  );

  assert.deepEqual(actions, [
    { op: "restore", path: "notes/a.md", contentHash: "sha256:remote-a", reason: "local_modified" },
    { op: "delete", path: "notes/local-only.md", reason: "local_only" }
  ]);
});

test("planMirrorRemoteActions ignores excluded local files", () => {
  const actions = planMirrorRemoteActions(
    [{ path: "private/local.md", contentHash: "sha256:local" }],
    remoteIndex,
    () => ({ sync: false, reason: "excluded folder: private" })
  );

  assert.deepEqual(actions, []);
});
