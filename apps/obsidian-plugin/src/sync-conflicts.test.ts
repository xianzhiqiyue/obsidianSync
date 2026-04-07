import assert from "node:assert/strict";
import test from "node:test";
import type { SyncChangeRequest, SyncConflict } from "./api-client";
import type { IndexedFileState } from "./state-store";
import {
  areAllConflictsLocalDeletes,
  collectLocalDeletionPaths,
  pruneMissingFileIndexEntries,
  shouldCreateConflictCopy
} from "./sync-conflicts";

test("shouldCreateConflictCopy only keeps real merge conflicts and avoids nested conflict copies", () => {
  const versionConflict: SyncConflict = {
    index: 0,
    code: "VERSION_CONFLICT",
    path: "notes/a.md",
    message: "version mismatch"
  };
  const fileMissingConflict: SyncConflict = {
    index: 0,
    code: "FILE_NOT_FOUND",
    path: "notes/a.md",
    message: "file missing"
  };

  assert.equal(shouldCreateConflictCopy("notes/a.md", versionConflict), true);
  assert.equal(shouldCreateConflictCopy("notes/a.md", fileMissingConflict), true);
  assert.equal(
    shouldCreateConflictCopy("notes/a.conflict-ubuntu-device-2026-04-03T02-31-57-960Z.md", versionConflict),
    false
  );
  assert.equal(
    shouldCreateConflictCopy(
      "notes/a.conflict-ubuntu-device-2026-04-03T02-31-57-960Z.md",
      fileMissingConflict
    ),
    false
  );
});

test("pruneMissingFileIndexEntries removes stale file ids reported by prepare conflicts", () => {
  const fileIndexByPath: Record<string, IndexedFileState> = {
    "notes/a.md": {
      fileId: "11111111-1111-1111-1111-111111111111",
      path: "notes/a.md",
      version: 2,
      contentHash: "sha256:a"
    },
    "notes/a.conflict-ubuntu-device-1.md": {
      fileId: "22222222-2222-2222-2222-222222222222",
      path: "notes/a.conflict-ubuntu-device-1.md",
      version: 1,
      contentHash: "sha256:conflict"
    },
    "notes/b.md": {
      fileId: "33333333-3333-3333-3333-333333333333",
      path: "notes/b.md",
      version: 4,
      contentHash: "sha256:b"
    }
  };
  const changes: SyncChangeRequest[] = [
    {
      op: "update",
      fileId: "11111111-1111-1111-1111-111111111111",
      path: "notes/a.md",
      baseVersion: 2,
      contentHash: "sha256:a-new"
    },
    {
      op: "update",
      fileId: "22222222-2222-2222-2222-222222222222",
      path: "notes/a.conflict-ubuntu-device-1.md",
      baseVersion: 1,
      contentHash: "sha256:conflict-new"
    }
  ];
  const conflicts: SyncConflict[] = [
    {
      index: 0,
      code: "FILE_NOT_FOUND",
      fileId: "11111111-1111-1111-1111-111111111111",
      path: "notes/a.md",
      message: "file not found or deleted"
    },
    {
      index: 1,
      code: "FILE_NOT_FOUND",
      fileId: "22222222-2222-2222-2222-222222222222",
      path: "notes/a.conflict-ubuntu-device-1.md",
      message: "file not found or deleted"
    }
  ];

  const nextIndex = pruneMissingFileIndexEntries(fileIndexByPath, changes, conflicts);

  assert.deepEqual(Object.keys(nextIndex), ["notes/b.md"]);
  assert.equal(nextIndex["notes/b.md"]?.fileId, "33333333-3333-3333-3333-333333333333");
});

test("collectLocalDeletionPaths keeps local delete intent for conflicted files", () => {
  const changes: SyncChangeRequest[] = [
    {
      op: "delete",
      fileId: "11111111-1111-1111-1111-111111111111",
      path: "notes/a.md",
      baseVersion: 2
    },
    {
      op: "update",
      fileId: "22222222-2222-2222-2222-222222222222",
      path: "notes/b.md",
      baseVersion: 1,
      contentHash: "sha256:new"
    },
    {
      op: "delete",
      fileId: "33333333-3333-3333-3333-333333333333",
      path: "notes/c.md",
      baseVersion: 4
    }
  ];
  const conflicts: SyncConflict[] = [
    {
      index: 0,
      code: "VERSION_CONFLICT",
      fileId: "11111111-1111-1111-1111-111111111111",
      path: "notes/a.md",
      message: "version conflict"
    },
    {
      index: 1,
      code: "VERSION_CONFLICT",
      fileId: "22222222-2222-2222-2222-222222222222",
      path: "notes/b.md",
      message: "version conflict"
    },
    {
      index: 2,
      code: "FILE_NOT_FOUND",
      fileId: "33333333-3333-3333-3333-333333333333",
      path: "notes/c.md",
      message: "file missing"
    }
  ];

  assert.deepEqual(collectLocalDeletionPaths(changes, conflicts), ["notes/a.md", "notes/c.md"]);
});

test("areAllConflictsLocalDeletes only returns true for pure delete conflicts", () => {
  const deleteOnlyChanges: SyncChangeRequest[] = [
    {
      op: "delete",
      fileId: "11111111-1111-1111-1111-111111111111",
      path: "notes/a.md",
      baseVersion: 2
    },
    {
      op: "delete",
      fileId: "22222222-2222-2222-2222-222222222222",
      path: "notes/b.md",
      baseVersion: 5
    }
  ];
  const deleteOnlyConflicts: SyncConflict[] = [
    {
      index: 0,
      code: "VERSION_CONFLICT",
      path: "notes/a.md",
      message: "version conflict"
    },
    {
      index: 1,
      code: "FILE_NOT_FOUND",
      path: "notes/b.md",
      message: "file missing"
    }
  ];
  const mixedChanges: SyncChangeRequest[] = [
    ...deleteOnlyChanges,
    {
      op: "update",
      fileId: "33333333-3333-3333-3333-333333333333",
      path: "notes/c.md",
      baseVersion: 1,
      contentHash: "sha256:new"
    }
  ];
  const mixedConflicts: SyncConflict[] = [
    ...deleteOnlyConflicts,
    {
      index: 2,
      code: "VERSION_CONFLICT",
      path: "notes/c.md",
      message: "version conflict"
    }
  ];

  assert.equal(areAllConflictsLocalDeletes(deleteOnlyChanges, deleteOnlyConflicts), true);
  assert.equal(areAllConflictsLocalDeletes(mixedChanges, mixedConflicts), false);
  assert.equal(areAllConflictsLocalDeletes(deleteOnlyChanges, []), false);
});
