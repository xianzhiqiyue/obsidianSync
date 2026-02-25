import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LOCAL_SYNC_STATE,
  LocalStateStore,
  type LocalSyncState,
  type QueuedChange
} from "./state-store";

function createStore(initial?: Partial<LocalSyncState>) {
  const state: LocalSyncState = {
    checkpoint: initial?.checkpoint ?? DEFAULT_LOCAL_SYNC_STATE.checkpoint,
    queue: initial?.queue ?? [],
    fileIndexByPath: initial?.fileIndexByPath ?? {},
    failure: initial?.failure ?? { ...DEFAULT_LOCAL_SYNC_STATE.failure }
  };
  return new LocalStateStore(state, async () => {});
}

test("manual clear recovery unblocks sync state after non-retryable failure", async () => {
  const queue: QueuedChange[] = [
    {
      id: "q1",
      op: "update",
      path: "notes/a.md",
      fileId: "11111111-1111-1111-1111-111111111111",
      baseVersion: 1,
      contentHash: "sha256:new",
      attempts: 0,
      ts: 1
    }
  ];
  const store = createStore({ queue });

  await store.recordFailure("FORBIDDEN", false);
  const blocked = store.getFailureState();
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.lastError, "FORBIDDEN");
  assert.equal(blocked.failedQueue.length, 1);
  assert.equal(blocked.failedQueue[0]?.attempts, 1);

  await store.clearFailureState();
  const recovered = store.getFailureState();
  assert.equal(recovered.blocked, false);
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.failedQueue.length, 0);
  assert.equal(recovered.consecutiveFailures, 0);
});
