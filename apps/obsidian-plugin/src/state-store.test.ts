import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LOCAL_SYNC_STATE,
  LocalStateStore,
  type LocalSyncState,
  type PendingConflictSummary,
  type QueuedChange
} from "./state-store";

function createStore(initial?: Partial<LocalSyncState>) {
  const state: LocalSyncState = {
    checkpoint: initial?.checkpoint ?? DEFAULT_LOCAL_SYNC_STATE.checkpoint,
    queue: initial?.queue ?? [],
    fileIndexByPath: initial?.fileIndexByPath ?? {},
    localDeleteMarkers: initial?.localDeleteMarkers ?? {},
    failure: initial?.failure ?? { ...DEFAULT_LOCAL_SYNC_STATE.failure },
    pendingConflicts: initial?.pendingConflicts ?? { ...DEFAULT_LOCAL_SYNC_STATE.pendingConflicts }
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

test("pending conflict state can be stored and cleared", async () => {
  const store = createStore();
  const conflicts: PendingConflictSummary[] = [
    {
      id: "c1",
      code: "FILE_NOT_FOUND",
      path: "notes/a.md",
      fileId: "11111111-1111-1111-1111-111111111111",
      message: "file not found or deleted",
      localPreview: "local text",
      localContentBase64: "bG9jYWwgdGV4dA==",
      remoteSummary: "remote deleted",
      recommendedAction: "use_local",
      recommendedReason: "keep local",
      remoteDeleted: true
    }
  ];

  await store.setPendingConflicts(conflicts, 123);
  const pending = store.getPendingConflicts();
  assert.equal(pending.items.length, 1);
  assert.equal(pending.items[0]?.id, "c1");
  assert.equal(pending.items[0]?.localPreview, "local text");
  assert.equal(pending.deferredAt, 123);

  await store.clearPendingConflicts();
  const cleared = store.getPendingConflicts();
  assert.equal(cleared.items.length, 0);
  assert.equal(cleared.deferredAt, null);
});

test("state store constructor keeps backward compatibility when pending conflicts are missing", () => {
  const legacyStore = new LocalStateStore(
    {
      checkpoint: null,
      queue: [],
      fileIndexByPath: {},
      localDeleteMarkers: {},
      failure: { ...DEFAULT_LOCAL_SYNC_STATE.failure }
    },
    async () => {}
  );

  const pending = legacyStore.getPendingConflicts();
  assert.equal(pending.items.length, 0);
  assert.equal(pending.deferredAt, null);
});

test("local delete markers can be stored and cleared", async () => {
  const store = createStore();
  await store.markLocalDelete({
    fileId: "11111111-1111-1111-1111-111111111111",
    path: "notes/a.md",
    baseVersion: 3,
    ts: 123
  });

  const markers = store.getLocalDeleteMarkers();
  assert.deepEqual(markers["notes/a.md"], {
    fileId: "11111111-1111-1111-1111-111111111111",
    path: "notes/a.md",
    baseVersion: 3,
    ts: 123
  });

  await store.clearLocalDeleteMarkers();
  assert.deepEqual(store.getLocalDeleteMarkers(), {});
});

test("confirmed delete only clears the exact marker sent by this sync", async () => {
  const store = createStore();
  await store.markLocalDelete({
    fileId: "11111111-1111-1111-1111-111111111111",
    path: "notes/a.md",
    baseVersion: 3,
    ts: 100
  });
  await store.markLocalDelete({
    fileId: "11111111-1111-1111-1111-111111111111",
    path: "notes/a.md",
    baseVersion: 3,
    ts: 200
  });

  await store.clearConfirmedDeleteMarkers([
    {
      fileId: "11111111-1111-1111-1111-111111111111",
      path: "notes/a.md",
      baseVersion: 3,
      operationTimeMs: 100
    }
  ]);

  assert.equal(store.getLocalDeleteMarkers()["notes/a.md"]?.ts, 200);
});

test("rebasing a delete marker preserves its operation time", async () => {
  const store = createStore();
  const original = {
    fileId: "11111111-1111-1111-1111-111111111111",
    path: "notes/a.md",
    baseVersion: 3,
    ts: 123
  };
  await store.markLocalDelete(original);
  await store.rebaseLocalDeleteMarker(
    original,
    "archive/a.md",
    "11111111-1111-1111-1111-111111111111",
    4
  );

  assert.equal(store.getLocalDeleteMarkers()["notes/a.md"], undefined);
  assert.deepEqual(store.getLocalDeleteMarkers()["archive/a.md"], {
    ...original,
    path: "archive/a.md",
    baseVersion: 4
  });
});
