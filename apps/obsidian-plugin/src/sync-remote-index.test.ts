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
      contentHash: "sha256:a1"
    },
    {
      op: "update",
      fileId: "file-a",
      path: "notes/a.md",
      version: 2,
      contentHash: "sha256:a2",
      mtimeMs: undefined
    },
    {
      op: "rename",
      fileId: "file-a",
      path: "docs/a.md",
      version: 3,
      contentHash: "sha256:a2"
    },
    {
      op: "create",
      fileId: "file-b",
      path: "notes/b.md",
      version: 1,
      contentHash: "sha256:b1",
      mtimeMs: undefined
    },
    {
      op: "delete",
      fileId: "file-b",
      path: "notes/b.md",
      version: 2,
      contentHash: "sha256:b1"
    }
  ];

  const rebuilt = applyRemoteChangesToIndex(initialIndex, changes);

  assert.deepEqual(rebuilt, {
    "docs/a.md": {
      fileId: "file-a",
      path: "docs/a.md",
      version: 3,
      contentHash: "sha256:a2"
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
      contentHash: "sha256:a2"
    },
    {
      op: "move",
      fileId: "file-b",
      path: "archive/b.md",
      version: 2,
      contentHash: "sha256:b1"
    }
  ];

  const rebuilt = applyRemoteChangesToIndex(initialIndex, changes);

  assert.deepEqual(rebuilt, {
    "archive/b.md": {
      fileId: "file-b",
      path: "archive/b.md",
      version: 2,
      contentHash: "sha256:b1"
    }
  });
});
