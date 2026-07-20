import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after } from "node:test";
import jwt from "@fastify/jwt";
import Fastify, { type FastifyInstance } from "fastify";
import { appConfig } from "../config.js";
import { pool, query } from "../db.js";
import { ObjectStore } from "../object-store.js";
import syncRoutes from "./sync.js";

interface CommitResponse {
  changesetId: string;
  newCheckpoint: string;
  appliedChanges: number;
}

interface PrepareResponse {
  prepareId: string;
  uploadTargets: Array<{ contentHash: string; uploadUrl: string }>;
  conflicts: Array<{
    code: string;
    reason?: string;
    headVersion?: number;
    remotePath?: string;
    remoteDeleted?: boolean;
    existingFileId?: string;
    remoteContentHash?: string;
    remoteOperationTimeMs?: number;
  }>;
}

interface SyncErrorResponse {
  code: string;
  message: string;
}

function testContentHash(label: string = randomUUID()): string {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

interface TestContext {
  app: FastifyInstance;
  userId: string;
  deviceId: string;
  vaultId: string;
  accessToken: string;
  refreshToken: string;
}

class FakeObjectStore extends ObjectStore {
  constructor(private readonly existingHashes: Set<string>) {
    super(appConfig);
  }

  override async ensureBucket(): Promise<void> {}

  override async objectExists(contentHash: string): Promise<boolean> {
    return this.existingHashes.has(contentHash);
  }

  override async createUploadUrl(contentHash: string): Promise<string> {
    return `https://upload.example.local/${encodeURIComponent(contentHash)}`;
  }

  override async createDownloadUrl(contentHash: string): Promise<string> {
    return `https://download.example.local/${encodeURIComponent(contentHash)}`;
  }

  override async verifyObjectContentHash(contentHash: string): Promise<boolean> {
    return this.existingHashes.has(contentHash);
  }
}

async function createTestContext(existingHashes: Set<string>): Promise<TestContext> {
  const app = Fastify();
  await app.register(jwt, { secret: appConfig.jwtSecret });
  await app.register(syncRoutes(new FakeObjectStore(existingHashes)), { prefix: "/api/v1" });
  await app.ready();

  const userId = randomUUID();
  const deviceId = randomUUID();
  const vaultId = randomUUID();
  await query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)", [
    userId,
    `sync-test-${userId}@example.com`,
    "test-password-hash"
  ]);
  await query(
    `INSERT INTO devices (id, user_id, device_name, platform, plugin_version, status, revoked_at)
     VALUES ($1, $2, $3, $4, $5, 'active', NULL)`,
    [deviceId, userId, `test-device-${deviceId}`, "macos", "test"]
  );
  await query("INSERT INTO vaults (id, owner_user_id, name) VALUES ($1, $2, $3)", [
    vaultId,
    userId,
    `vault-${vaultId}`
  ]);

  const accessToken = app.jwt.sign({
    sub: userId,
    deviceId,
    type: "access"
  });
  const refreshToken = app.jwt.sign({
    sub: userId,
    deviceId,
    type: "refresh"
  });

  return {
    app,
    userId,
    deviceId,
    vaultId,
    accessToken,
    refreshToken
  };
}

async function destroyTestContext(context: TestContext): Promise<void> {
  await context.app.close();
  await query("DELETE FROM vaults WHERE owner_user_id = $1", [context.userId]);
  await query("DELETE FROM refresh_tokens WHERE user_id = $1", [context.userId]);
  await query("DELETE FROM devices WHERE user_id = $1", [context.userId]);
  await query("DELETE FROM users WHERE id = $1", [context.userId]);
}

async function cleanupObjectHashes(contentHashes: string[]): Promise<void> {
  if (contentHashes.length === 0) {
    return;
  }
  await query("DELETE FROM object_blobs WHERE content_hash = ANY($1::text[])", [contentHashes]);
}

async function prepareChanges(
  context: TestContext,
  baseCheckpoint: number,
  changes: Array<Record<string, unknown>>
): Promise<PrepareResponse> {
  const response = await context.app.inject({
    method: "POST",
    url: `/api/v1/vaults/${context.vaultId}/sync/prepare`,
    headers: { authorization: `Bearer ${context.accessToken}` },
    payload: { baseCheckpoint, changes }
  });
  assert.equal(response.statusCode, 200);
  return response.json() as PrepareResponse;
}

async function commitPrepare(context: TestContext, prepareId: string): Promise<CommitResponse> {
  const response = await context.app.inject({
    method: "POST",
    url: `/api/v1/vaults/${context.vaultId}/sync/commit`,
    headers: { authorization: `Bearer ${context.accessToken}` },
    payload: { prepareId, idempotencyKey: randomUUID() }
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as CommitResponse;
}

test("sync commit should be idempotent for same idempotency key", async () => {
  const contentHash = testContentHash("idempotent");
  const existingHashes = new Set([contentHash]);
  const context = await createTestContext(existingHashes);
  try {
    const path = `notes/idempotent-${randomUUID()}.md`;
    const prepareRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/prepare`,
      headers: {
        authorization: `Bearer ${context.accessToken}`
      },
      payload: {
        baseCheckpoint: 0,
        changes: [
          {
            op: "create",
            path,
            contentHash,
            mtimeMs: 1111,
            ctimeMs: 2222
          }
        ]
      }
    });
    assert.equal(prepareRes.statusCode, 200);
    const prepareBody = prepareRes.json() as PrepareResponse;
    assert.equal(prepareBody.uploadTargets.length, 0);
    assert.equal(prepareBody.conflicts.length, 0);

    const idempotencyKey = randomUUID();
    const commitFirstRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/commit`,
      headers: {
        authorization: `Bearer ${context.accessToken}`
      },
      payload: {
        prepareId: prepareBody.prepareId,
        idempotencyKey
      }
    });
    assert.equal(commitFirstRes.statusCode, 200);
    const firstBody = commitFirstRes.json() as CommitResponse;
    assert.equal(firstBody.appliedChanges, 1);
    assert.equal(firstBody.newCheckpoint, "cp_1");
    assert.match(firstBody.changesetId, /^[0-9a-f-]{36}$/i);

    const pullRes = await context.app.inject({
      method: "GET",
      url: `/api/v1/vaults/${context.vaultId}/sync/pull?fromCheckpoint=0`,
      headers: {
        authorization: `Bearer ${context.accessToken}`
      }
    });
    assert.equal(pullRes.statusCode, 200);
    assert.equal(pullRes.json().changes[0]?.mtimeMs, 1111);
    assert.equal(pullRes.json().changes[0]?.ctimeMs, 2222);
    assert.equal(pullRes.json().changes[0]?.operationTimeMs, 1111);

    const commitSecondRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/commit`,
      headers: {
        authorization: `Bearer ${context.accessToken}`
      },
      payload: {
        prepareId: prepareBody.prepareId,
        idempotencyKey
      }
    });
    assert.equal(commitSecondRes.statusCode, 200);
    const secondBody = commitSecondRes.json() as CommitResponse;
    assert.deepEqual(secondBody, firstBody);
  } finally {
    await destroyTestContext(context);
    await cleanupObjectHashes([contentHash]);
  }
});

test("sync routes should reject refresh tokens and revoked devices", async () => {
  const context = await createTestContext(new Set());
  try {
    const refreshTokenRes = await context.app.inject({
      method: "GET",
      url: `/api/v1/vaults/${context.vaultId}/sync/state`,
      headers: {
        authorization: `Bearer ${context.refreshToken}`
      }
    });
    assert.equal(refreshTokenRes.statusCode, 401);
    assert.equal((refreshTokenRes.json() as SyncErrorResponse).code, "UNAUTHORIZED");

    await query("UPDATE devices SET status = 'revoked', revoked_at = NOW() WHERE id = $1", [
      context.deviceId
    ]);
    const revokedDeviceRes = await context.app.inject({
      method: "GET",
      url: `/api/v1/vaults/${context.vaultId}/sync/state`,
      headers: {
        authorization: `Bearer ${context.accessToken}`
      }
    });
    assert.equal(revokedDeviceRes.statusCode, 403);
    assert.equal((revokedDeviceRes.json() as SyncErrorResponse).code, "DEVICE_REVOKED");
  } finally {
    await destroyTestContext(context);
  }
});

test("sync commit should reject conflicted prepare", async () => {
  const contentHashCreate = testContentHash("conflict-create");
  const contentHashUpdate = testContentHash("conflict-update");
  const existingHashes = new Set([contentHashCreate, contentHashUpdate]);
  const context = await createTestContext(existingHashes);
  try {
    const path = `notes/conflict-${randomUUID()}.md`;
    const prepareCreateRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/prepare`,
      headers: {
        authorization: `Bearer ${context.accessToken}`
      },
      payload: {
        baseCheckpoint: 0,
        changes: [
          {
            op: "create",
            path,
            contentHash: contentHashCreate
          }
        ]
      }
    });
    assert.equal(prepareCreateRes.statusCode, 200);
    const prepareCreateBody = prepareCreateRes.json() as PrepareResponse;
    assert.equal(prepareCreateBody.conflicts.length, 0);

    const commitCreateRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/commit`,
      headers: {
        authorization: `Bearer ${context.accessToken}`
      },
      payload: {
        prepareId: prepareCreateBody.prepareId,
        idempotencyKey: randomUUID()
      }
    });
    assert.equal(commitCreateRes.statusCode, 200);

    const fileResult = await query<{ id: string }>(
      `SELECT id
       FROM file_entries
       WHERE vault_id = $1
         AND current_path = $2
       LIMIT 1`,
      [context.vaultId, path]
    );
    const fileId = fileResult.rows[0]?.id;
    assert.ok(fileId, "missing created file id");

    const prepareConflictRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/prepare`,
      headers: {
        authorization: `Bearer ${context.accessToken}`
      },
      payload: {
        baseCheckpoint: 0,
        changes: [
          {
            op: "update",
            fileId,
            path,
            baseVersion: 0,
            contentHash: contentHashUpdate
          }
        ]
      }
    });
    assert.equal(prepareConflictRes.statusCode, 200);
    const prepareConflictBody = prepareConflictRes.json() as PrepareResponse;
    assert.ok(prepareConflictBody.conflicts.length > 0);

    const commitConflictRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/commit`,
      headers: {
        authorization: `Bearer ${context.accessToken}`
      },
      payload: {
        prepareId: prepareConflictBody.prepareId,
        idempotencyKey: randomUUID()
      }
    });
    assert.equal(commitConflictRes.statusCode, 409);
    const conflictBody = commitConflictRes.json() as SyncErrorResponse;
    assert.equal(conflictBody.code, "VERSION_CONFLICT");
  } finally {
    await destroyTestContext(context);
    await cleanupObjectHashes([contentHashCreate, contentHashUpdate]);
  }
});

test("sync prepare should return rich metadata for deleted and version conflicts", async () => {
  const contentHashCreate = testContentHash("rich-create");
  const contentHashUpdate = testContentHash("rich-update");
  const existingHashes = new Set([contentHashCreate, contentHashUpdate]);
  const context = await createTestContext(existingHashes);
  try {
    const path = `notes/rich-${randomUUID()}.md`;
    const prepareCreateRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/prepare`,
      headers: {
        authorization: `Bearer ${context.accessToken}`
      },
      payload: {
        baseCheckpoint: 0,
        changes: [{ op: "create", path, contentHash: contentHashCreate }]
      }
    });
    const createBody = prepareCreateRes.json() as PrepareResponse;

    const commitCreateRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/commit`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: { prepareId: createBody.prepareId, idempotencyKey: randomUUID() }
    });
    assert.equal(commitCreateRes.statusCode, 200);

    const fileResult = await query<{ id: string }>(
      `SELECT id
       FROM file_entries
       WHERE vault_id = $1 AND current_path = $2
       LIMIT 1`,
      [context.vaultId, path]
    );
    const fileId = fileResult.rows[0]?.id;
    assert.ok(fileId);

    await query(
      `UPDATE file_entries
       SET head_version = 2, deleted_at = NOW()
       WHERE id = $1`,
      [fileId]
    );

    const deletedPrepareRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/prepare`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: {
        baseCheckpoint: 1,
        changes: [{ op: "update", fileId, path, baseVersion: 1, contentHash: contentHashUpdate }]
      }
    });
    assert.equal(deletedPrepareRes.statusCode, 200);
    const deletedPrepare = deletedPrepareRes.json() as PrepareResponse;
    assert.equal(deletedPrepare.conflicts[0]?.code, "FILE_NOT_FOUND");
    assert.equal(deletedPrepare.conflicts[0]?.reason, "deleted_on_server");
    assert.equal(deletedPrepare.conflicts[0]?.remotePath, path);
    assert.equal(deletedPrepare.conflicts[0]?.headVersion, 2);
    assert.equal(deletedPrepare.conflicts[0]?.remoteDeleted, true);
  } finally {
    await destroyTestContext(context);
    await cleanupObjectHashes([contentHashCreate, contentHashUpdate]);
  }
});

test("sync prepare should accept stale delete when local delete time is newer than remote update", async () => {
  const contentHashCreate = testContentHash("delete-lww-create");
  const contentHashUpdate = testContentHash("delete-lww-update");
  const existingHashes = new Set([contentHashCreate, contentHashUpdate]);
  const context = await createTestContext(existingHashes);
  try {
    const path = `notes/delete-lww-${randomUUID()}.md`;
    const prepareCreateRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/prepare`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: {
        baseCheckpoint: 0,
        changes: [{ op: "create", path, contentHash: contentHashCreate, mtimeMs: 1000 }]
      }
    });
    const createBody = prepareCreateRes.json() as PrepareResponse;
    const commitCreateRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/commit`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: { prepareId: createBody.prepareId, idempotencyKey: randomUUID() }
    });
    assert.equal(commitCreateRes.statusCode, 200);

    const fileResult = await query<{ id: string }>(
      `SELECT id
       FROM file_entries
       WHERE vault_id = $1 AND current_path = $2
       LIMIT 1`,
      [context.vaultId, path]
    );
    const fileId = fileResult.rows[0]?.id;
    assert.ok(fileId);

    const prepareUpdateRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/prepare`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: {
        baseCheckpoint: 1,
        changes: [{ op: "update", fileId, path, baseVersion: 1, contentHash: contentHashUpdate, mtimeMs: 2000 }]
      }
    });
    const updateBody = prepareUpdateRes.json() as PrepareResponse;
    const commitUpdateRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/commit`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: { prepareId: updateBody.prepareId, idempotencyKey: randomUUID() }
    });
    assert.equal(commitUpdateRes.statusCode, 200);

    const prepareDeleteRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/prepare`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: {
        baseCheckpoint: 1,
        changes: [{ op: "delete", fileId, path, baseVersion: 1, mtimeMs: 3000 }]
      }
    });
    assert.equal(prepareDeleteRes.statusCode, 200);
    const deleteBody = prepareDeleteRes.json() as PrepareResponse;
    assert.equal(deleteBody.conflicts.length, 0);

    const commitDeleteRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/commit`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: { prepareId: deleteBody.prepareId, idempotencyKey: randomUUID() }
    });
    assert.equal(commitDeleteRes.statusCode, 200);
    const deleteCommitBody = commitDeleteRes.json() as CommitResponse;
    assert.equal(deleteCommitBody.newCheckpoint, "cp_3");

    const deletedResult = await query<{ head_version: number; deleted_at: Date | null }>(
      `SELECT head_version, deleted_at
       FROM file_entries
       WHERE id = $1`,
      [fileId]
    );
    assert.equal(deletedResult.rows[0]?.head_version, 3);
    assert.ok(deletedResult.rows[0]?.deleted_at);
  } finally {
    await destroyTestContext(context);
    await cleanupObjectHashes([contentHashCreate, contentHashUpdate]);
  }
});

test("sync prepare should accept stale update when local operation time is newer than remote update", async () => {
  const contentHashCreate = testContentHash("update-lww-create");
  const contentHashRemote = testContentHash("update-lww-remote");
  const contentHashLocal = testContentHash("update-lww-local");
  const existingHashes = new Set([contentHashCreate, contentHashRemote, contentHashLocal]);
  const context = await createTestContext(existingHashes);
  try {
    const path = `notes/update-lww-${randomUUID()}.md`;
    const prepareCreateRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/prepare`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: {
        baseCheckpoint: 0,
        changes: [{ op: "create", path, contentHash: contentHashCreate, operationTimeMs: 1000 }]
      }
    });
    const createBody = prepareCreateRes.json() as PrepareResponse;
    const commitCreateRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/commit`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: { prepareId: createBody.prepareId, idempotencyKey: randomUUID() }
    });
    assert.equal(commitCreateRes.statusCode, 200);

    const fileResult = await query<{ id: string }>(
      `SELECT id
       FROM file_entries
       WHERE vault_id = $1 AND current_path = $2
       LIMIT 1`,
      [context.vaultId, path]
    );
    const fileId = fileResult.rows[0]?.id;
    assert.ok(fileId);

    const prepareRemoteRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/prepare`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: {
        baseCheckpoint: 1,
        changes: [{ op: "update", fileId, path, baseVersion: 1, contentHash: contentHashRemote, operationTimeMs: 2000 }]
      }
    });
    const remoteBody = prepareRemoteRes.json() as PrepareResponse;
    const commitRemoteRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/commit`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: { prepareId: remoteBody.prepareId, idempotencyKey: randomUUID() }
    });
    assert.equal(commitRemoteRes.statusCode, 200);

    const prepareLocalRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/prepare`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: {
        baseCheckpoint: 1,
        changes: [{ op: "update", fileId, path, baseVersion: 1, contentHash: contentHashLocal, operationTimeMs: 3000 }]
      }
    });
    assert.equal(prepareLocalRes.statusCode, 200);
    const localBody = prepareLocalRes.json() as PrepareResponse;
    assert.equal(localBody.conflicts.length, 0);

    const commitLocalRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/commit`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: { prepareId: localBody.prepareId, idempotencyKey: randomUUID() }
    });
    assert.equal(commitLocalRes.statusCode, 200);

    const pullRes = await context.app.inject({
      method: "GET",
      url: `/api/v1/vaults/${context.vaultId}/sync/pull?fromCheckpoint=2`,
      headers: { authorization: `Bearer ${context.accessToken}` }
    });
    assert.equal(pullRes.statusCode, 200);
    assert.equal(pullRes.json().changes[0]?.contentHash, contentHashLocal);
    assert.equal(pullRes.json().changes[0]?.operationTimeMs, 3000);
  } finally {
    await destroyTestContext(context);
    await cleanupObjectHashes([contentHashCreate, contentHashRemote, contentHashLocal]);
  }
});

test("sync prepare should return rich metadata for target path conflicts", async () => {
  const hashA = testContentHash("path-a");
  const hashB = testContentHash("path-b");
  const existingHashes = new Set([hashA, hashB]);
  const context = await createTestContext(existingHashes);
  try {
    const pathA = `notes/a-${randomUUID()}.md`;
    const pathB = `notes/b-${randomUUID()}.md`;
    for (const [path, hash] of [
      [pathA, hashA],
      [pathB, hashB]
    ] as const) {
      const prepareRes = await context.app.inject({
        method: "POST",
        url: `/api/v1/vaults/${context.vaultId}/sync/prepare`,
        headers: { authorization: `Bearer ${context.accessToken}` },
        payload: { baseCheckpoint: 0, changes: [{ op: "create", path, contentHash: hash }] }
      });
      const prepareBody = prepareRes.json() as PrepareResponse;
      await context.app.inject({
        method: "POST",
        url: `/api/v1/vaults/${context.vaultId}/sync/commit`,
        headers: { authorization: `Bearer ${context.accessToken}` },
        payload: { prepareId: prepareBody.prepareId, idempotencyKey: randomUUID() }
      });
    }

    const fileAResult = await query<{ id: string }>(
      `SELECT id FROM file_entries WHERE vault_id = $1 AND current_path = $2 LIMIT 1`,
      [context.vaultId, pathA]
    );
    const fileAId = fileAResult.rows[0]?.id;
    assert.ok(fileAId);

    const conflictPrepareRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/prepare`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: {
        baseCheckpoint: 2,
        changes: [{ op: "rename", fileId: fileAId, path: pathB, baseVersion: 1 }]
      }
    });
    assert.equal(conflictPrepareRes.statusCode, 200);
    const conflictPrepare = conflictPrepareRes.json() as PrepareResponse;
    assert.equal(conflictPrepare.conflicts[0]?.code, "PATH_CONFLICT");
    assert.equal(conflictPrepare.conflicts[0]?.reason, "target_path_exists");
    assert.equal(conflictPrepare.conflicts[0]?.remotePath, pathB);
    assert.equal(conflictPrepare.conflicts[0]?.remoteDeleted, false);
    assert.match(conflictPrepare.conflicts[0]?.existingFileId ?? "", /^[0-9a-f-]{36}$/i);
  } finally {
    await destroyTestContext(context);
    await cleanupObjectHashes([hashA, hashB]);
  }
});

test("sync prepare should treat identical stale update as no-op instead of conflict", async () => {
  const originalHash = testContentHash("noop-original");
  const updateHash = testContentHash("noop-update");
  const existingHashes = new Set([originalHash, updateHash]);
  const context = await createTestContext(existingHashes);
  try {
    const path = `notes/noop-${randomUUID()}.md`;
    const prepareCreateRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/prepare`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: {
        baseCheckpoint: 0,
        changes: [{ op: "create", path, contentHash: originalHash }]
      }
    });
    assert.equal(prepareCreateRes.statusCode, 200);
    const createBody = prepareCreateRes.json() as PrepareResponse;

    const commitCreateRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/commit`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: { prepareId: createBody.prepareId, idempotencyKey: randomUUID() }
    });
    assert.equal(commitCreateRes.statusCode, 200);

    const fileResult = await query<{ id: string }>(
      `SELECT id
       FROM file_entries
       WHERE vault_id = $1
         AND current_path = $2
       LIMIT 1`,
      [context.vaultId, path]
    );
    const fileId = fileResult.rows[0]?.id;
    assert.ok(fileId, "missing created file id");

    const prepareRealUpdateRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/prepare`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: {
        baseCheckpoint: 1,
        changes: [{ op: "update", fileId, path, baseVersion: 1, contentHash: updateHash }]
      }
    });
    const realUpdateBody = prepareRealUpdateRes.json() as PrepareResponse;
    const commitRealUpdateRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/commit`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: { prepareId: realUpdateBody.prepareId, idempotencyKey: randomUUID() }
    });
    assert.equal(commitRealUpdateRes.statusCode, 200);

    const noopPrepareRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/prepare`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: {
        baseCheckpoint: 1,
        changes: [{ op: "update", fileId, path, baseVersion: 1, contentHash: updateHash }]
      }
    });
    assert.equal(noopPrepareRes.statusCode, 200);
    const noopPrepareBody = noopPrepareRes.json() as PrepareResponse;
    assert.deepEqual(noopPrepareBody.conflicts, []);
    assert.deepEqual(noopPrepareBody.uploadTargets, []);

    const noopCommitRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/commit`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: { prepareId: noopPrepareBody.prepareId, idempotencyKey: randomUUID() }
    });
    assert.equal(noopCommitRes.statusCode, 200);
    const noopCommitBody = noopCommitRes.json() as CommitResponse;
    assert.equal(noopCommitBody.appliedChanges, 0);
    assert.equal(noopCommitBody.newCheckpoint, "cp_2");

    const checkpointResult = await query<{ latest_checkpoint: string }>(
      "SELECT latest_checkpoint FROM vault_sync_state WHERE vault_id = $1",
      [context.vaultId]
    );
    assert.equal(Number(checkpointResult.rows[0]?.latest_checkpoint ?? 0), 2);
  } finally {
    await destroyTestContext(context);
    await cleanupObjectHashes([originalHash, updateHash]);
  }
});

test("sync commit should serialize concurrent commits on same vault", async () => {
  const contentHashA = testContentHash(`concurrent-a-${randomUUID()}`);
  const contentHashB = testContentHash(`concurrent-b-${randomUUID()}`);
  const existingHashes = new Set([contentHashA, contentHashB]);
  const context = await createTestContext(existingHashes);
  try {
    const prepareARes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/prepare`,
      headers: {
        authorization: `Bearer ${context.accessToken}`
      },
      payload: {
        baseCheckpoint: 0,
        changes: [
          {
            op: "create",
            path: `notes/concurrent-a-${randomUUID()}.md`,
            contentHash: contentHashA
          }
        ]
      }
    });
    assert.equal(prepareARes.statusCode, 200);
    const prepareABody = prepareARes.json() as PrepareResponse;
    assert.equal(prepareABody.conflicts.length, 0);

    const prepareBRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/prepare`,
      headers: {
        authorization: `Bearer ${context.accessToken}`
      },
      payload: {
        baseCheckpoint: 0,
        changes: [
          {
            op: "create",
            path: `notes/concurrent-b-${randomUUID()}.md`,
            contentHash: contentHashB
          }
        ]
      }
    });
    assert.equal(prepareBRes.statusCode, 200);
    const prepareBBody = prepareBRes.json() as PrepareResponse;
    assert.equal(prepareBBody.conflicts.length, 0);

    const [commitARes, commitBRes] = await Promise.all([
      context.app.inject({
        method: "POST",
        url: `/api/v1/vaults/${context.vaultId}/sync/commit`,
        headers: {
          authorization: `Bearer ${context.accessToken}`
        },
        payload: {
          prepareId: prepareABody.prepareId,
          idempotencyKey: randomUUID()
        }
      }),
      context.app.inject({
        method: "POST",
        url: `/api/v1/vaults/${context.vaultId}/sync/commit`,
        headers: {
          authorization: `Bearer ${context.accessToken}`
        },
        payload: {
          prepareId: prepareBBody.prepareId,
          idempotencyKey: randomUUID()
        }
      })
    ]);

    assert.equal(commitARes.statusCode, 200);
    assert.equal(commitBRes.statusCode, 200);
    const commitABody = commitARes.json() as CommitResponse;
    const commitBBody = commitBRes.json() as CommitResponse;
    assert.equal(commitABody.appliedChanges, 1);
    assert.equal(commitBBody.appliedChanges, 1);
    assert.deepEqual(
      new Set([commitABody.newCheckpoint, commitBBody.newCheckpoint]),
      new Set(["cp_1", "cp_2"])
    );

    const checkpointResult = await query<{ latest_checkpoint: string }>(
      "SELECT latest_checkpoint FROM vault_sync_state WHERE vault_id = $1",
      [context.vaultId]
    );
    assert.equal(Number(checkpointResult.rows[0]?.latest_checkpoint ?? 0), 2);
  } finally {
    await destroyTestContext(context);
    await cleanupObjectHashes([contentHashA, contentHashB]);
  }
});

test("sync commit should fail when uploaded object is missing", async () => {
  const missingHash = testContentHash("missing");
  const context = await createTestContext(new Set());
  try {
    const prepareRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/prepare`,
      headers: {
        authorization: `Bearer ${context.accessToken}`
      },
      payload: {
        baseCheckpoint: 0,
        changes: [
          {
            op: "create",
            path: `notes/missing-${randomUUID()}.md`,
            contentHash: missingHash
          }
        ]
      }
    });
    assert.equal(prepareRes.statusCode, 200);
    const prepareBody = prepareRes.json() as PrepareResponse;
    assert.equal(prepareBody.uploadTargets.length, 1);
    assert.equal(prepareBody.conflicts.length, 0);

    const commitRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/commit`,
      headers: {
        authorization: `Bearer ${context.accessToken}`
      },
      payload: {
        prepareId: prepareBody.prepareId,
        idempotencyKey: randomUUID()
      }
    });
    assert.equal(commitRes.statusCode, 409);
    const commitBody = commitRes.json() as SyncErrorResponse;
    assert.equal(commitBody.code, "SYNC_COMMIT_FAILED");
  } finally {
    await destroyTestContext(context);
    await cleanupObjectHashes([missingHash]);
  }
});

test("delete commit should persist tombstone and only allow a newer create", async () => {
  const originalHash = testContentHash("tombstone-original");
  const recreatedHash = testContentHash("tombstone-recreated");
  const existingHashes = new Set([originalHash, recreatedHash]);
  const context = await createTestContext(existingHashes);
  try {
    const path = `notes/tombstone-${randomUUID()}.md`;
    const createPrepare = await prepareChanges(context, 0, [
      { op: "create", path, contentHash: originalHash, operationTimeMs: 1000 }
    ]);
    await commitPrepare(context, createPrepare.prepareId);

    const fileResult = await query<{ id: string }>(
      "SELECT id FROM file_entries WHERE vault_id = $1 AND current_path = $2 AND deleted_at IS NULL",
      [context.vaultId, path]
    );
    const deletedFileId = fileResult.rows[0]?.id;
    assert.ok(deletedFileId);

    const deletePrepare = await prepareChanges(context, 1, [
      {
        op: "delete",
        fileId: deletedFileId,
        path,
        baseVersion: 1,
        operationTimeMs: 3000
      }
    ]);
    const deleteCommit = await commitPrepare(context, deletePrepare.prepareId);
    assert.equal(deleteCommit.newCheckpoint, "cp_2");

    const tombstoneResult = await query<{
      path: string;
      operation_time_ms: string;
      deleted_file: boolean;
    }>(
      `SELECT tombstone.path,
              tombstone.operation_time_ms,
              file_entry.deleted_at IS NOT NULL AS deleted_file
       FROM tombstones AS tombstone
       JOIN file_entries AS file_entry ON file_entry.id = tombstone.file_id
       WHERE tombstone.vault_id = $1 AND tombstone.file_id = $2`,
      [context.vaultId, deletedFileId]
    );
    assert.equal(tombstoneResult.rows[0]?.path, path);
    assert.equal(Number(tombstoneResult.rows[0]?.operation_time_ms), 3000);
    assert.equal(tombstoneResult.rows[0]?.deleted_file, true);

    const deletePull = await context.app.inject({
      method: "GET",
      url: `/api/v1/vaults/${context.vaultId}/sync/pull?fromCheckpoint=1`,
      headers: { authorization: `Bearer ${context.accessToken}` }
    });
    assert.equal(deletePull.statusCode, 200);
    assert.equal(deletePull.json().changes[0]?.op, "delete");
    assert.equal(deletePull.json().changes[0]?.operationTimeMs, 3000);

    for (const operationTimeMs of [undefined, 2999, 3000]) {
      const staleCreate: Record<string, unknown> = {
        op: "create",
        path,
        contentHash: recreatedHash
      };
      if (operationTimeMs !== undefined) {
        staleCreate.operationTimeMs = operationTimeMs;
      }
      const stalePrepare = await prepareChanges(context, 2, [staleCreate]);
      assert.equal(stalePrepare.conflicts[0]?.code, "PATH_TOMBSTONE_CONFLICT");
      assert.equal(stalePrepare.conflicts[0]?.remoteOperationTimeMs, 3000);
    }

    const recreatePrepare = await prepareChanges(context, 2, [
      { op: "create", path, contentHash: recreatedHash, operationTimeMs: 3001 }
    ]);
    assert.deepEqual(recreatePrepare.conflicts, []);
    const recreateCommit = await commitPrepare(context, recreatePrepare.prepareId);
    assert.equal(recreateCommit.newCheckpoint, "cp_3");

    const recreatedFileResult = await query<{ id: string }>(
      "SELECT id FROM file_entries WHERE vault_id = $1 AND current_path = $2 AND deleted_at IS NULL",
      [context.vaultId, path]
    );
    assert.ok(recreatedFileResult.rows[0]?.id);
    assert.notEqual(recreatedFileResult.rows[0]?.id, deletedFileId);
  } finally {
    await destroyTestContext(context);
    await cleanupObjectHashes([originalHash, recreatedHash]);
  }
});

test("prepare should reject an operation that is not newer than the remote head", async () => {
  const remoteHash = testContentHash("lww-remote-head");
  const staleHash = testContentHash("lww-stale-update");
  const context = await createTestContext(new Set([remoteHash, staleHash]));
  try {
    const path = `notes/lww-${randomUUID()}.md`;
    const createPrepare = await prepareChanges(context, 0, [
      { op: "create", path, contentHash: remoteHash, operationTimeMs: 3000 }
    ]);
    await commitPrepare(context, createPrepare.prepareId);
    const fileResult = await query<{ id: string }>(
      "SELECT id FROM file_entries WHERE vault_id = $1 AND current_path = $2 AND deleted_at IS NULL",
      [context.vaultId, path]
    );
    const fileId = fileResult.rows[0]?.id;
    assert.ok(fileId);

    for (const operationTimeMs of [2999, 3000]) {
      const stalePrepare = await prepareChanges(context, 1, [
        {
          op: "update",
          fileId,
          path,
          baseVersion: 1,
          contentHash: staleHash,
          operationTimeMs
        }
      ]);
      assert.equal(stalePrepare.conflicts[0]?.code, "VERSION_CONFLICT");
      assert.equal(stalePrepare.conflicts[0]?.reason, "stale_operation_time");
      assert.equal(stalePrepare.conflicts[0]?.remoteOperationTimeMs, 3000);
    }

    const newerPrepare = await prepareChanges(context, 1, [
      {
        op: "update",
        fileId,
        path,
        baseVersion: 1,
        contentHash: staleHash,
        operationTimeMs: 3001
      }
    ]);
    assert.deepEqual(newerPrepare.conflicts, []);

    const wrongPathPrepare = await prepareChanges(context, 1, [
      {
        op: "update",
        fileId,
        path: `${path}.moved`,
        baseVersion: 1,
        contentHash: staleHash,
        operationTimeMs: 4000
      }
    ]);
    assert.equal(wrongPathPrepare.conflicts[0]?.code, "VERSION_CONFLICT");
    assert.equal(wrongPathPrepare.conflicts[0]?.reason, "remote_path_mismatch");
    assert.equal(wrongPathPrepare.conflicts[0]?.remotePath, path);
  } finally {
    await destroyTestContext(context);
    await cleanupObjectHashes([remoteHash, staleHash]);
  }
});

test("create commit should recheck a tombstone created after prepare", async () => {
  const staleHash = testContentHash("commit-stale-create");
  const temporaryHash = testContentHash("commit-temporary-create");
  const existingHashes = new Set([staleHash, temporaryHash]);
  const context = await createTestContext(existingHashes);
  try {
    const path = `notes/commit-race-${randomUUID()}.md`;
    const stalePrepare = await prepareChanges(context, 0, [
      { op: "create", path, contentHash: staleHash, operationTimeMs: 1000 }
    ]);
    const temporaryPrepare = await prepareChanges(context, 0, [
      { op: "create", path, contentHash: temporaryHash, operationTimeMs: 2000 }
    ]);
    await commitPrepare(context, temporaryPrepare.prepareId);

    const fileResult = await query<{ id: string }>(
      "SELECT id FROM file_entries WHERE vault_id = $1 AND current_path = $2 AND deleted_at IS NULL",
      [context.vaultId, path]
    );
    const fileId = fileResult.rows[0]?.id;
    assert.ok(fileId);
    const deletePrepare = await prepareChanges(context, 1, [
      { op: "delete", fileId, path, baseVersion: 1, operationTimeMs: 3000 }
    ]);
    await commitPrepare(context, deletePrepare.prepareId);

    const staleCommit = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/commit`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: { prepareId: stalePrepare.prepareId, idempotencyKey: randomUUID() }
    });
    assert.equal(staleCommit.statusCode, 409);
    assert.equal(staleCommit.json().code, "PATH_TOMBSTONE_CONFLICT");
    assert.equal(staleCommit.json().remoteOperationTimeMs, 3000);
  } finally {
    await destroyTestContext(context);
    await cleanupObjectHashes([staleHash, temporaryHash]);
  }
});

test("commit should return structured conflicts when prepared state becomes stale", async () => {
  const originalHash = testContentHash("commit-race-original");
  const staleHash = testContentHash("commit-race-stale");
  const winnerHash = testContentHash("commit-race-winner");
  const context = await createTestContext(new Set([originalHash, staleHash, winnerHash]));
  try {
    const path = `notes/version-race-${randomUUID()}.md`;
    const createPrepare = await prepareChanges(context, 0, [
      { op: "create", path, contentHash: originalHash, operationTimeMs: 1000 }
    ]);
    await commitPrepare(context, createPrepare.prepareId);
    const fileResult = await query<{ id: string }>(
      "SELECT id FROM file_entries WHERE vault_id = $1 AND current_path = $2 AND deleted_at IS NULL",
      [context.vaultId, path]
    );
    const fileId = fileResult.rows[0]?.id;
    assert.ok(fileId);

    const stalePrepare = await prepareChanges(context, 1, [
      { op: "update", fileId, path, baseVersion: 1, contentHash: staleHash, operationTimeMs: 2000 }
    ]);
    const winnerPrepare = await prepareChanges(context, 1, [
      { op: "update", fileId, path, baseVersion: 1, contentHash: winnerHash, operationTimeMs: 3000 }
    ]);
    await commitPrepare(context, winnerPrepare.prepareId);

    const staleCommit = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/commit`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: { prepareId: stalePrepare.prepareId, idempotencyKey: randomUUID() }
    });
    assert.equal(staleCommit.statusCode, 409);
    assert.equal(staleCommit.json().code, "VERSION_CONFLICT");
    assert.equal(staleCommit.json().headVersion, 2);
    assert.equal(staleCommit.json().remoteContentHash, winnerHash);
    assert.equal(staleCommit.json().remoteOperationTimeMs, 3000);
  } finally {
    await destroyTestContext(context);
    await cleanupObjectHashes([originalHash, staleHash, winnerHash]);
  }
});

test("create commit should return PATH_CONFLICT when another commit occupies the path", async () => {
  const staleHash = testContentHash("path-race-stale");
  const winnerHash = testContentHash("path-race-winner");
  const context = await createTestContext(new Set([staleHash, winnerHash]));
  try {
    const path = `notes/path-race-${randomUUID()}.md`;
    const stalePrepare = await prepareChanges(context, 0, [
      { op: "create", path, contentHash: staleHash, operationTimeMs: 1000 }
    ]);
    const winnerPrepare = await prepareChanges(context, 0, [
      { op: "create", path, contentHash: winnerHash, operationTimeMs: 2000 }
    ]);
    await commitPrepare(context, winnerPrepare.prepareId);

    const staleCommit = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/commit`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: { prepareId: stalePrepare.prepareId, idempotencyKey: randomUUID() }
    });
    assert.equal(staleCommit.statusCode, 409);
    assert.equal(staleCommit.json().code, "PATH_CONFLICT");
    assert.equal(staleCommit.json().path, path);
  } finally {
    await destroyTestContext(context);
    await cleanupObjectHashes([staleHash, winnerHash]);
  }
});

test("pull should keep a checkpoint intact when it exceeds the requested limit", async () => {
  const firstHashes = Array.from({ length: 250 }, (_, index) =>
    testContentHash(`large-checkpoint-${index}-${randomUUID()}`)
  );
  const secondHash = testContentHash("after-large-checkpoint");
  const allHashes = [...firstHashes, secondHash];
  const context = await createTestContext(new Set(allHashes));
  try {
    const firstPrepare = await prepareChanges(
      context,
      0,
      firstHashes.map((contentHash, index) => ({
        op: "create",
        path: `bulk/${String(index).padStart(3, "0")}.md`,
        contentHash,
        operationTimeMs: 10_000 + index
      }))
    );
    await commitPrepare(context, firstPrepare.prepareId);

    const secondPrepare = await prepareChanges(context, 1, [
      {
        op: "create",
        path: `bulk/after-${randomUUID()}.md`,
        contentHash: secondHash,
        operationTimeMs: 20_000
      }
    ]);
    await commitPrepare(context, secondPrepare.prepareId);

    const firstPull = await context.app.inject({
      method: "GET",
      url: `/api/v1/vaults/${context.vaultId}/sync/pull?fromCheckpoint=0&limit=200`,
      headers: { authorization: `Bearer ${context.accessToken}` }
    });
    assert.equal(firstPull.statusCode, 200);
    assert.equal(firstPull.json().changes.length, 250);
    assert.equal(firstPull.json().toCheckpoint, "cp_1");
    assert.equal(firstPull.json().hasMore, true);
    assert.equal(new Set(firstPull.json().changes.map((change: { fileId: string }) => change.fileId)).size, 250);

    const secondPull = await context.app.inject({
      method: "GET",
      url: `/api/v1/vaults/${context.vaultId}/sync/pull?fromCheckpoint=1&limit=200`,
      headers: { authorization: `Bearer ${context.accessToken}` }
    });
    assert.equal(secondPull.statusCode, 200);
    assert.equal(secondPull.json().changes.length, 1);
    assert.equal(secondPull.json().toCheckpoint, "cp_2");
    assert.equal(secondPull.json().hasMore, false);
  } finally {
    await destroyTestContext(context);
    await cleanupObjectHashes(allHashes);
  }
});

test("sync snapshot should return only active files at one checkpoint", async () => {
  const deletedHash = testContentHash("snapshot-deleted");
  const activeHash = testContentHash("snapshot-active");
  const context = await createTestContext(new Set([deletedHash, activeHash]));
  try {
    const deletedPath = `notes/snapshot-deleted-${randomUUID()}.md`;
    const activePath = `notes/snapshot-active-${randomUUID()}.md`;
    const createPrepare = await prepareChanges(context, 0, [
      {
        op: "create",
        path: deletedPath,
        contentHash: deletedHash,
        mtimeMs: 111,
        ctimeMs: 112,
        operationTimeMs: 1000
      },
      {
        op: "create",
        path: activePath,
        contentHash: activeHash,
        mtimeMs: 211,
        ctimeMs: 212,
        operationTimeMs: 2000
      }
    ]);
    await commitPrepare(context, createPrepare.prepareId);

    const deletedFileResult = await query<{ id: string }>(
      "SELECT id FROM file_entries WHERE vault_id = $1 AND current_path = $2 AND deleted_at IS NULL",
      [context.vaultId, deletedPath]
    );
    const deletedFileId = deletedFileResult.rows[0]?.id;
    assert.ok(deletedFileId);
    const deletePrepare = await prepareChanges(context, 1, [
      {
        op: "delete",
        fileId: deletedFileId,
        path: deletedPath,
        baseVersion: 1,
        operationTimeMs: 3000
      }
    ]);
    await commitPrepare(context, deletePrepare.prepareId);

    const snapshotResponse = await context.app.inject({
      method: "GET",
      url: `/api/v1/vaults/${context.vaultId}/sync/snapshot`,
      headers: { authorization: `Bearer ${context.accessToken}` }
    });
    assert.equal(snapshotResponse.statusCode, 200);
    assert.equal(snapshotResponse.json().checkpoint, "cp_2");
    assert.deepEqual(snapshotResponse.json().files, [
      {
        fileId: snapshotResponse.json().files[0]?.fileId,
        path: activePath,
        version: 1,
        contentHash: activeHash,
        mtimeMs: 211,
        ctimeMs: 212,
        operationTimeMs: 2000
      }
    ]);
    assert.match(snapshotResponse.json().files[0]?.fileId ?? "", /^[0-9a-f-]{36}$/i);
    assert.deepEqual(snapshotResponse.json().deletedFiles, [
      {
        fileId: deletedFileId,
        path: deletedPath,
        version: 2,
        contentHash: deletedHash,
        operationTimeMs: 3000
      }
    ]);
  } finally {
    await destroyTestContext(context);
    await cleanupObjectHashes([deletedHash, activeHash]);
  }
});


test("file version download-url should return content hash and signed URL", async () => {
  const contentHash = `sha256:test-version-download-${randomUUID()}`;
  const existingHashes = new Set([contentHash]);
  const context = await createTestContext(existingHashes);
  try {
    const path = `notes/version-download-${randomUUID()}.md`;
    const prepareRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/prepare`,
      headers: {
        authorization: `Bearer ${context.accessToken}`
      },
      payload: {
        baseCheckpoint: 0,
        changes: [
          {
            op: "create",
            path,
            contentHash
          }
        ]
      }
    });
    assert.equal(prepareRes.statusCode, 200);
    const prepareBody = prepareRes.json() as PrepareResponse;
    assert.equal(prepareBody.conflicts.length, 0);

    const commitRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/sync/commit`,
      headers: {
        authorization: `Bearer ${context.accessToken}`
      },
      payload: {
        prepareId: prepareBody.prepareId,
        idempotencyKey: randomUUID()
      }
    });
    assert.equal(commitRes.statusCode, 200);

    const fileResult = await query<{ id: string }>(
      `SELECT id
       FROM file_entries
       WHERE vault_id = $1
         AND current_path = $2
       LIMIT 1`,
      [context.vaultId, path]
    );
    const fileId = fileResult.rows[0]?.id;
    assert.ok(fileId, "missing created file id");

    const downloadRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/vaults/${context.vaultId}/files/${fileId}/versions/1/download-url`,
      headers: {
        authorization: `Bearer ${context.accessToken}`
      }
    });
    assert.equal(downloadRes.statusCode, 200);
    assert.deepEqual(downloadRes.json(), {
      fileId,
      version: 1,
      contentHash,
      downloadUrl: `https://download.example.local/${encodeURIComponent(contentHash)}`
    });
  } finally {
    await destroyTestContext(context);
    await cleanupObjectHashes([contentHash]);
  }
});

after(async () => {
  await pool.end();
});
