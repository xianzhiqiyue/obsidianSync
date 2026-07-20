import assert from "node:assert/strict";
import test from "node:test";
import { buildLocalPlan, isConflictCopyPath, normalizeQueuedChanges, planLocalChanges } from "./sync-planner";
import type { IndexedFileState, QueuedChange } from "./state-store";

function makeSnapshot(path: string, contentHash: string, mtimeMs = 1000) {
  return {
    path,
    contentHash,
    bytes: new ArrayBuffer(0),
    mtimeMs
  };
}

test("buildLocalPlan replays valid failed changes and drops stale entries", () => {
  const fileIndexByPath: Record<string, IndexedFileState> = {
    "notes/a.md": {
      fileId: "11111111-1111-1111-1111-111111111111",
      path: "notes/a.md",
      version: 1,
      contentHash: "sha256:old"
    }
  };
  const localSnapshots = {
    "notes/a.md": makeSnapshot("notes/a.md", "sha256:new")
  };
  const failedQueue: QueuedChange[] = [
    {
      id: "q-valid",
      op: "update",
      path: "notes/a.md",
      fileId: "11111111-1111-1111-1111-111111111111",
      baseVersion: 1,
      contentHash: "sha256:new",
      attempts: 1,
      ts: 1
    },
    {
      id: "q-stale",
      op: "delete",
      path: "notes/a.md",
      fileId: "11111111-1111-1111-1111-111111111111",
      baseVersion: 0,
      attempts: 2,
      ts: 2
    }
  ];

  const plan = buildLocalPlan(failedQueue, localSnapshots, fileIndexByPath);

  assert.equal(plan.source, "replay");
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0]?.op, "update");
  assert.equal(plan.queuePreview.length, 1);
  assert.equal(plan.queuePreview[0]?.id, "q-valid");
  assert.equal(plan.droppedFailedItems, 1);
  assert.ok(plan.hashToSnapshot["sha256:new"]);
});

test("buildLocalPlan falls back to fresh scan when failed queue cannot replay", () => {
  const fileIndexByPath: Record<string, IndexedFileState> = {};
  const localSnapshots = {
    "notes/new.md": makeSnapshot("notes/new.md", "sha256:new-file")
  };
  const failedQueue: QueuedChange[] = [
    {
      id: "q-invalid",
      op: "update",
      path: "notes/new.md",
      fileId: "22222222-2222-2222-2222-222222222222",
      baseVersion: 1,
      contentHash: "sha256:stale",
      attempts: 1,
      ts: 1
    }
  ];

  const plan = buildLocalPlan(failedQueue, localSnapshots, fileIndexByPath, {
    newId: () => "generated-id",
    now: () => 99
  });

  assert.equal(plan.source, "fresh");
  assert.equal(plan.changes.length, 1);
  assert.deepEqual(plan.changes[0], {
    op: "create",
    path: "notes/new.md",
    contentHash: "sha256:new-file",
    operationTimeMs: 1000,
    mtimeMs: 1000
  });
  assert.equal(plan.queuePreview.length, 1);
  assert.equal(plan.queuePreview[0]?.id, "generated-id");
  assert.equal(plan.queuePreview[0]?.attempts, 0);
  assert.equal(plan.droppedFailedItems, 1);
});

test("planLocalChanges detects move and rename from matching content hash", () => {
  const fileIndexByPath: Record<string, IndexedFileState> = {
    "docs/a.md": {
      fileId: "33333333-3333-3333-3333-333333333333",
      path: "docs/a.md",
      version: 3,
      contentHash: "sha256:same-a"
    },
    "notes/old.md": {
      fileId: "44444444-4444-4444-4444-444444444444",
      path: "notes/old.md",
      version: 7,
      contentHash: "sha256:same-b"
    }
  };
  const localSnapshots = {
    "notes/a.md": makeSnapshot("notes/a.md", "sha256:same-a"),
    "notes/new.md": makeSnapshot("notes/new.md", "sha256:same-b")
  };

  let seq = 0;
  const plan = planLocalChanges(localSnapshots, fileIndexByPath, {
    newId: () => `id-${++seq}`,
    now: () => 123
  });

  assert.equal(plan.source, "fresh");
  assert.equal(plan.changes.length, 2);
  assert.deepEqual(plan.changes[0], {
    op: "move",
    fileId: "33333333-3333-3333-3333-333333333333",
    path: "notes/a.md",
    baseVersion: 3,
    operationTimeMs: 123,
    mtimeMs: 1000
  });
  assert.deepEqual(plan.changes[1], {
    op: "rename",
    fileId: "44444444-4444-4444-4444-444444444444",
    path: "notes/new.md",
    baseVersion: 7,
    operationTimeMs: 123,
    mtimeMs: 1000
  });
  assert.equal(plan.queuePreview.length, 2);
  assert.equal(plan.queuePreview[0]?.id, "id-1");
  assert.equal(plan.queuePreview[1]?.id, "id-2");
});

test("planLocalChanges does not delete remote files just because a local folder is incomplete", () => {
  const fileIndexByPath: Record<string, IndexedFileState> = {
    "notes/server-only.md": {
      fileId: "55555555-5555-5555-5555-555555555555",
      path: "notes/server-only.md",
      version: 4,
      contentHash: "sha256:server"
    }
  };

  const plan = planLocalChanges({}, fileIndexByPath);

  assert.equal(plan.changes.length, 0);
  assert.equal(plan.queuePreview.length, 0);
});

test("planLocalChanges only emits delete when there is a matching local delete marker", () => {
  const fileIndexByPath: Record<string, IndexedFileState> = {
    "notes/deleted.md": {
      fileId: "66666666-6666-6666-6666-666666666666",
      path: "notes/deleted.md",
      version: 2,
      contentHash: "sha256:old"
    },
    "notes/stale-marker.md": {
      fileId: "77777777-7777-7777-7777-777777777777",
      path: "notes/stale-marker.md",
      version: 5,
      contentHash: "sha256:stale"
    }
  };

  const plan = planLocalChanges({}, fileIndexByPath, {
    newId: () => "delete-id",
    now: () => 456,
    deleteMarkers: {
      "notes/deleted.md": {
        fileId: "66666666-6666-6666-6666-666666666666",
        path: "notes/deleted.md",
        baseVersion: 2,
        ts: 123
      },
      "notes/stale-marker.md": {
        fileId: "77777777-7777-7777-7777-777777777777",
        path: "notes/stale-marker.md",
        baseVersion: 4,
        ts: 123
      }
    }
  });

  assert.deepEqual(plan.changes, [
    {
      op: "delete",
      fileId: "66666666-6666-6666-6666-666666666666",
      path: "notes/deleted.md",
      baseVersion: 2,
      operationTimeMs: 123
    }
  ]);
  assert.equal(plan.queuePreview.length, 1);
  assert.equal(plan.queuePreview[0]?.id, "delete-id");
});

test("planLocalChanges infers an offline delete only for a materialized entry", () => {
  const plan = planLocalChanges(
    {},
    {
      "notes/local-before-restart.md": {
        fileId: "88888888-8888-8888-8888-888888888888",
        path: "notes/local-before-restart.md",
        version: 3,
        contentHash: "sha256:materialized",
        operationTimeMs: 100,
        materialized: true
      },
      "notes/remote-only.md": {
        fileId: "99999999-9999-9999-9999-999999999999",
        path: "notes/remote-only.md",
        version: 1,
        contentHash: "sha256:remote-only",
        operationTimeMs: 100,
        materialized: false
      }
    },
    { now: () => 500, newId: () => "offline-delete" }
  );

  assert.deepEqual(plan.changes, [
    {
      op: "delete",
      fileId: "88888888-8888-8888-8888-888888888888",
      path: "notes/local-before-restart.md",
      baseVersion: 3,
      operationTimeMs: 500
    }
  ]);
});

test("buildLocalPlan keeps fresh delete intent while replaying a failed update", () => {
  const index: Record<string, IndexedFileState> = {
    "notes/update.md": {
      fileId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      path: "notes/update.md",
      version: 1,
      contentHash: "sha256:old",
      materialized: true
    },
    "notes/delete.md": {
      fileId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      path: "notes/delete.md",
      version: 2,
      contentHash: "sha256:delete",
      materialized: true
    }
  };
  const plan = buildLocalPlan(
    [
      {
        id: "failed-update",
        op: "update",
        path: "notes/update.md",
        fileId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        baseVersion: 1,
        contentHash: "sha256:new",
        operationTimeMs: 200,
        attempts: 1,
        ts: 200
      }
    ],
    { "notes/update.md": makeSnapshot("notes/update.md", "sha256:new", 200) },
    index,
    {
      now: () => 300,
      newId: () => "fresh-delete",
      deleteMarkers: {
        "notes/delete.md": {
          fileId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          path: "notes/delete.md",
          baseVersion: 2,
          ts: 250
        }
      }
    }
  );

  assert.equal(plan.source, "mixed");
  assert.deepEqual(plan.changes.map((change) => change.op), ["update", "delete"]);
  assert.equal(plan.changes[1]?.operationTimeMs, 250);
});

test("normalizeQueuedChanges keeps backward compatibility with old queue format", () => {
  const normalized = normalizeQueuedChanges(
    [
      { id: "legacy-delete", op: "delete", path: "notes/x.md", ts: 10 },
      { op: "bad-op", path: "notes/invalid.md" },
      { op: "create", path: "notes/y.md", contentHash: "sha256:y" }
    ],
    {
      newId: () => "generated-id",
      now: () => 77
    }
  );

  assert.equal(normalized.length, 2);
  assert.deepEqual(normalized[0], {
    id: "legacy-delete",
    op: "delete",
    path: "notes/x.md",
    fileId: undefined,
    baseVersion: undefined,
    contentHash: undefined,
    operationTimeMs: 10,
    attempts: 0,
    ts: 10
  });
  assert.deepEqual(normalized[1], {
    id: "generated-id",
    op: "create",
    path: "notes/y.md",
    fileId: undefined,
    baseVersion: undefined,
    contentHash: "sha256:y",
    operationTimeMs: 77,
    attempts: 0,
    ts: 77
  });
});

test("planLocalChanges applies server clock offset to operation times", () => {
  const plan = planLocalChanges(
    { "notes/offset.md": makeSnapshot("notes/offset.md", "sha256:offset", 1000) },
    {},
    { clockOffsetMs: 250 }
  );

  assert.equal(plan.changes[0]?.operationTimeMs, 1250);
  assert.equal(plan.changes[0]?.mtimeMs, 1000);
});

test("isConflictCopyPath detects generated conflict files", () => {
  assert.equal(isConflictCopyPath("notes/a.conflict-macbook-2026-04-07T10-00-00-000Z.md"), true);
  assert.equal(isConflictCopyPath("notes/a.md"), false);
});
