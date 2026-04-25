import assert from "node:assert/strict";
import test from "node:test";
import type { SyncChangeRequest, SyncConflict } from "./api-client";
import {
  buildConflictResolutionCandidate,
  buildConflictResolutionId,
  buildRemoteSummary,
  createTextPreview,
  getConflictRecommendationReason,
  getRecommendedConflictAction
} from "./sync-conflict-candidates";

test("recommended action prefers local for file-not-found and remote for nested conflict copies", () => {
  const fileMissing: SyncConflict = {
    index: 0,
    code: "FILE_NOT_FOUND",
    path: "notes/a.md",
    message: "file missing"
  };
  const versionConflict: SyncConflict = {
    index: 0,
    code: "VERSION_CONFLICT",
    path: "notes/a.conflict-device-1.md",
    message: "version mismatch"
  };

  assert.equal(getRecommendedConflictAction(fileMissing, "notes/a.md"), "use_local");
  assert.equal(getRecommendedConflictAction(versionConflict, "notes/a.conflict-device-1.md"), "use_remote");
  assert.match(getConflictRecommendationReason("use_local", fileMissing, "notes/a.md"), /远端文件记录已不存在/);
});


test("recommended action treats official conflict copies as remote", () => {
  const conflict: SyncConflict = {
    index: 0,
    code: "VERSION_CONFLICT",
    path: "notes/a (Conflicted copy MacBook 202604141545).md",
    message: "version conflict"
  };

  assert.equal(getRecommendedConflictAction(conflict, conflict.path), "use_remote");
  assert.match(getConflictRecommendationReason("use_remote", conflict, conflict.path), /冲突副本/);
});

test("buildConflictResolutionCandidate includes preview and stable id", () => {
  const conflict: SyncConflict = {
    index: 0,
    code: "FILE_NOT_FOUND",
    fileId: "11111111-1111-1111-1111-111111111111",
    path: "notes/a.md",
    message: "file missing",
    reason: "deleted_on_server",
    remotePath: "notes/a.md",
    headVersion: 4,
    remoteDeleted: true
  };
  const localPlan: { changes: SyncChangeRequest[] } = {
    changes: [
      {
        op: "update",
        fileId: "11111111-1111-1111-1111-111111111111",
        path: "notes/a.md",
        baseVersion: 3,
        contentHash: "sha256:new"
      }
    ]
  };

  const candidate = buildConflictResolutionCandidate(conflict, localPlan, {
    exists: true,
    isConflictCopy: false,
    previewText: "hello world"
  });

  assert.equal(candidate.id, buildConflictResolutionId(conflict, "notes/a.md"));
  assert.equal(candidate.recommendedAction, "use_local");
  assert.equal(candidate.localPreview, "hello world");
  assert.match(candidate.remoteSummary ?? "", /远端头版本：4/);
  assert.match(candidate.recommendedReason, /重新建模/);
});

test("buildRemoteSummary renders available remote metadata", () => {
  const summary = buildRemoteSummary({
    index: 0,
    code: "PATH_CONFLICT",
    path: "notes/a.md",
    message: "path conflict",
    reason: "target_path_exists",
    remotePath: "notes/b.md",
    headVersion: 2,
    remoteDeleted: false,
    existingFileId: "22222222-2222-2222-2222-222222222222",
    remoteContentHash: "sha256:remote",
    remoteMtimeMs: 1776170000000
  });

  assert.match(summary ?? "", /原因标记：target_path_exists/);
  assert.match(summary ?? "", /远端路径：notes\/b\.md/);
  assert.match(summary ?? "", /占用文件 ID：22222222-2222-2222-2222-222222222222/);
  assert.match(summary ?? "", /远端内容哈希：sha256:remote/);
  assert.match(summary ?? "", /远端修改时间：/);
});

test("createTextPreview normalizes whitespace and truncates long text", () => {
  const bytes = new TextEncoder().encode("line1\n\nline2    line3");
  assert.equal(createTextPreview(bytes.buffer, 100), "line1 line2 line3");

  const longBytes = new TextEncoder().encode("a".repeat(20));
  assert.equal(createTextPreview(longBytes.buffer, 10), "aaaaaaaaaa...");
});
