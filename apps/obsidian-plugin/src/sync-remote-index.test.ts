import assert from "node:assert/strict";
import test from "node:test";
import type { SyncPullChange } from "./api-client";
import { applyRemoteChangesToIndex } from "./sync-remote-index";
import type { IndexedFileState } from "./state-store";

test("applyRemoteChangesToIndex rebuilds latest index across create update rename and delete", () => {
  const initialIndex: Record<string, IndexedFileState> = {};
  const changes: SyncPullChange[] = [
    {
      op: "create",
      fileId: "file-a",
      path: "notes/a.md",
      version: 1,
      contentHash: "sha256:a1",
      operationTimeMs: 1
    },
    {
      op: "update",
      fileId: "file-a",
      path: "notes/a.md",
      version: 2,
      contentHash: "sha256:a2",
      mtimeMs: undefined,
      operationTimeMs: 2
    },
    {
      op: "rename",
      fileId: "file-a",
      path: "docs/a.md",
      version: 3,
      contentHash: "sha256:a2",
      operationTimeMs: 3
    },
    {
      op: "create",
      fileId: "file-b",
      path: "notes/b.md",
      version: 1,
      contentHash: "sha256:b1",
      mtimeMs: undefined,
      operationTimeMs: 4
    },
    {
      op: "delete",
      fileId: "file-b",
      path: "notes/b.md",
      version: 2,
      contentHash: "sha256:b1",
      operationTimeMs: 5
    }
  ];

  const rebuilt = applyRemoteChangesToIndex(initialIndex, changes);

  assert.deepEqual(rebuilt, {
    "docs/a.md": {
      fileId: "file-a",
      path: "docs/a.md",
      version: 3,
      contentHash: "sha256:a2",
      operationTimeMs: 3,
      materialized: false
    }
  });
});

test("applyRemoteChangesToIndex removes stale entries by fileId when delete path is outdated", () => {
  const initialIndex: Record<string, IndexedFileState> = {
    "docs/a.md": {
      fileId: "file-a",
      path: "docs/a.md",
      version: 3,
      contentHash: "sha256:a2"
    },
    "notes/b.md": {
      fileId: "file-b",
      path: "notes/b.md",
      version: 1,
      contentHash: "sha256:b1"
    }
  };
  const changes: SyncPullChange[] = [
    {
      op: "delete",
      fileId: "file-a",
      path: "notes/a.md",
      version: 4,
      contentHash: "sha256:a2",
      operationTimeMs: 4
    },
    {
      op: "move",
      fileId: "file-b",
      path: "archive/b.md",
      version: 2,
      contentHash: "sha256:b1",
      operationTimeMs: 2
    }
  ];

  const rebuilt = applyRemoteChangesToIndex(initialIndex, changes);

  assert.deepEqual(rebuilt, {
    "archive/b.md": {
      fileId: "file-b",
      path: "archive/b.md",
      version: 2,
      contentHash: "sha256:b1",
      operationTimeMs: 2,
      materialized: false
    }
  });
});
