import assert from "node:assert/strict";
import test from "node:test";
import {
  decidePendingDelete,
  decideRemoteFileChange,
  findPendingDeleteMarker,
  inferMissingMaterializedDelete
} from "./delete-reconciliation";

const marker = {
  fileId: "11111111-1111-1111-1111-111111111111",
  path: "notes/a.md",
  baseVersion: 3,
  ts: 200
};

test("findPendingDeleteMarker follows a renamed file by fileId", () => {
  assert.equal(
    findPendingDeleteMarker({ [marker.path]: marker }, { fileId: marker.fileId, path: "archive/a.md" }),
    marker
  );
});

test("decidePendingDelete applies operation-time LWW with remote winning ties", () => {
  assert.equal(decidePendingDelete(marker, 199), "keep_local_delete");
  assert.equal(decidePendingDelete(marker, 200), "accept_remote");
  assert.equal(decidePendingDelete(marker, 201), "accept_remote");
  assert.equal(decidePendingDelete(marker, undefined), "keep_local_delete");
});

test("inferMissingMaterializedDelete only infers deletion for a file that landed locally", () => {
  const indexed = {
    fileId: marker.fileId,
    path: marker.path,
    version: marker.baseVersion,
    contentHash: "sha256:base",
    materialized: true
  };
  assert.deepEqual(inferMissingMaterializedDelete(indexed, false, 300), { ...marker, ts: 300 });
  assert.equal(inferMissingMaterializedDelete({ ...indexed, materialized: false }, false, 300), undefined);
  assert.equal(inferMissingMaterializedDelete(indexed, true, 300), undefined);
});

test("decideRemoteFileChange preserves only a genuinely newer local content operation", () => {
  assert.equal(
    decideRemoteFileChange({
      localContentHash: "sha256:local",
      localMtimeMs: 300,
      indexedContentHash: "sha256:base",
      remoteContentHash: "sha256:remote",
      remoteOperationTimeMs: 200
    }),
    "keep_local"
  );
  assert.equal(
    decideRemoteFileChange({
      localContentHash: "sha256:local",
      localMtimeMs: 200,
      indexedContentHash: "sha256:base",
      remoteContentHash: "sha256:remote",
      remoteOperationTimeMs: 200
    }),
    "accept_remote"
  );
  assert.equal(
    decideRemoteFileChange({
      localContentHash: "sha256:base",
      localMtimeMs: 999,
      indexedContentHash: "sha256:base",
      remoteOperationTimeMs: 200
    }),
    "accept_remote"
  );
  assert.equal(
    decideRemoteFileChange({
      localContentHash: "sha256:remote",
      localMtimeMs: 999,
      indexedContentHash: "sha256:base",
      remoteContentHash: "sha256:remote",
      remoteOperationTimeMs: 200
    }),
    "accept_remote"
  );
});
