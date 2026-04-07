import assert from "node:assert/strict";
import test from "node:test";
import { buildLocalPlan, isConflictCopyPath, normalizeQueuedChanges, planLocalChanges } from "./sync-planner";
import type { IndexedFileState, QueuedChange } from "./state-store";

function makeSnapshot(path: string, contentHash: string) {
  return {
    path,
    contentHash,
    bytes: new ArrayBuffer(0)
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
    contentHash: "sha256:new-file"
  });
  assert.equal(plan.queuePreview.length, 1);
  assert.equal(plan.queuePreview[0]?.id, "generated-id");
  assert.equal(plan.queuePreview[0]?.attempts, 0);
  assert.equal(plan.droppedFailedItems, 0);
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
    baseVersion: 3
  });
  assert.deepEqual(plan.changes[1], {
    op: "rename",
    fileId: "44444444-4444-4444-4444-444444444444",
    path: "notes/new.md",
    baseVersion: 7
  });
  assert.equal(plan.queuePreview.length, 2);
  assert.equal(plan.queuePreview[0]?.id, "id-1");
  assert.equal(plan.queuePreview[1]?.id, "id-2");
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
    attempts: 0,
    ts: 77
  });
});

test("isConflictCopyPath detects generated conflict files", () => {
  assert.equal(isConflictCopyPath("notes/a.conflict-macbook-2026-04-07T10-00-00-000Z.md"), true);
  assert.equal(isConflictCopyPath("notes/a.md"), false);
});
