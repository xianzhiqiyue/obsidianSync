import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import jwt from "@fastify/jwt";
import Fastify, { type FastifyInstance } from "fastify";
import { appConfig } from "../config.js";
import { query } from "../db.js";
import { ObjectStore } from "../object-store.js";
import fileRoutes from "./files.js";
import syncRoutes from "./sync.js";

interface TestContext {
  app: FastifyInstance;
  userId: string;
  deviceId: string;
  vaultId: string;
  accessToken: string;
}

interface FileWriteResponse {
  fileId: string;
  path: string;
  version: number;
  contentHash: string;
  checkpoint: string;
  changesetId: string;
  op: "create" | "update" | "delete";
}

class FakeObjectStore extends ObjectStore {
  readonly objects = new Map<string, Buffer>();

  constructor() {
    super(appConfig);
  }

  override async ensureBucket(): Promise<void> {}

  override async objectExists(contentHash: string): Promise<boolean> {
    return this.objects.has(contentHash);
  }

  override async putObjectBytes(contentHash: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(contentHash, Buffer.from(bytes));
  }

  override async createUploadUrl(contentHash: string): Promise<string> {
    return `https://upload.example.local/${encodeURIComponent(contentHash)}`;
  }

  override async createDownloadUrl(contentHash: string): Promise<string> {
    return `https://download.example.local/${encodeURIComponent(contentHash)}`;
  }

  override async verifyObjectContentHash(contentHash: string): Promise<boolean> {
    const bytes = this.objects.get(contentHash);
    if (!bytes) return false;
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}` === contentHash;
  }
}

function hashText(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function b64(text: string): string {
  return Buffer.from(text).toString("base64");
}

async function createTestContext(objectStore = new FakeObjectStore()): Promise<TestContext & { objectStore: FakeObjectStore }> {
  const app = Fastify();
  await app.register(jwt, { secret: appConfig.jwtSecret });
  await app.register(syncRoutes(objectStore), { prefix: "/api/v1" });
  await app.register(fileRoutes(objectStore), { prefix: "/api/v1" });
  await app.ready();

  const userId = randomUUID();
  const deviceId = randomUUID();
  const vaultId = randomUUID();
  await query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)", [
    userId,
    `files-test-${userId}@example.com`,
    "test-password-hash"
  ]);
  await query(
    `INSERT INTO devices (id, user_id, device_name, platform, plugin_version, status, revoked_at)
     VALUES ($1, $2, $3, $4, $5, 'active', NULL)`,
    [deviceId, userId, `test-device-${deviceId}`, "linux", "test"]
  );
  await query("INSERT INTO vaults (id, owner_user_id, name) VALUES ($1, $2, $3)", [
    vaultId,
    userId,
    `vault-${vaultId}`
  ]);

  const accessToken = app.jwt.sign({ sub: userId, deviceId, type: "access" });
  return { app, userId, deviceId, vaultId, accessToken, objectStore };
}

async function destroyTestContext(context: TestContext): Promise<void> {
  await context.app.close();
  await query("DELETE FROM vaults WHERE owner_user_id = $1", [context.userId]);
  await query("DELETE FROM refresh_tokens WHERE user_id = $1", [context.userId]);
  await query("DELETE FROM devices WHERE user_id = $1", [context.userId]);
  await query("DELETE FROM users WHERE id = $1", [context.userId]);
}

test("server file API should create, list, read, pull, update, and delete by path", async () => {
  const context = await createTestContext();
  try {
    const path = `AI-Todo/tasks/${randomUUID()}.md`;
    const encodedPath = encodeURIComponent(path);
    const firstContent = "---\nsource: ai-todo\n---\n# First\n";
    const createRes = await context.app.inject({
      method: "PUT",
      url: `/api/v1/vaults/${context.vaultId}/files/by-path/${encodedPath}`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: {
        contentBase64: b64(firstContent),
        idempotencyKey: randomUUID()
      }
    });
    assert.equal(createRes.statusCode, 200);
    const createBody = createRes.json() as FileWriteResponse;
    assert.equal(createBody.path, path);
    assert.equal(createBody.version, 1);
    assert.equal(createBody.contentHash, hashText(firstContent));
    assert.equal(createBody.checkpoint, "cp_1");
    assert.equal(createBody.op, "create");
    assert.equal(context.objectStore.objects.has(createBody.contentHash), true);

    const listRes = await context.app.inject({
      method: "GET",
      url: `/api/v1/vaults/${context.vaultId}/files?prefix=${encodeURIComponent("AI-Todo/")}`,
      headers: { authorization: `Bearer ${context.accessToken}` }
    });
    assert.equal(listRes.statusCode, 200);
    const listBody = listRes.json() as { checkpoint: string; items: Array<{ fileId: string; path: string; version: number }> };
    assert.equal(listBody.checkpoint, "cp_1");
    assert.equal(listBody.items.length, 1);
    assert.equal(listBody.items[0]?.path, path);

    const readRes = await context.app.inject({
      method: "GET",
      url: `/api/v1/vaults/${context.vaultId}/files/by-path/${encodedPath}?includeDownloadUrl=true`,
      headers: { authorization: `Bearer ${context.accessToken}` }
    });
    assert.equal(readRes.statusCode, 200);
    const readBody = readRes.json() as { file: { fileId: string; path: string; version: number }; downloadUrl: string };
    assert.equal(readBody.file.fileId, createBody.fileId);
    assert.equal(readBody.file.version, 1);
    assert.match(readBody.downloadUrl, /^https:\/\/download\.example\.local\//);

    const pullCreateRes = await context.app.inject({
      method: "GET",
      url: `/api/v1/vaults/${context.vaultId}/sync/pull?fromCheckpoint=0`,
      headers: { authorization: `Bearer ${context.accessToken}` }
    });
    assert.equal(pullCreateRes.statusCode, 200);
    const pullCreateBody = pullCreateRes.json() as { changes: Array<{ op: string; path: string; version: number }> };
    assert.deepEqual(pullCreateBody.changes.map((change) => [change.op, change.path, change.version]), [
      ["create", path, 1]
    ]);

    const secondContent = "---\nsource: ai-todo\n---\n# Second\n";
    const updateRes = await context.app.inject({
      method: "PUT",
      url: `/api/v1/vaults/${context.vaultId}/files/by-path/${encodedPath}`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: {
        contentBase64: b64(secondContent),
        baseVersion: 1,
        idempotencyKey: randomUUID()
      }
    });
    assert.equal(updateRes.statusCode, 200);
    const updateBody = updateRes.json() as FileWriteResponse;
    assert.equal(updateBody.version, 2);
    assert.equal(updateBody.checkpoint, "cp_2");
    assert.equal(updateBody.op, "update");

    const conflictRes = await context.app.inject({
      method: "PUT",
      url: `/api/v1/vaults/${context.vaultId}/files/by-path/${encodedPath}`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: {
        contentBase64: b64("# conflict\n"),
        baseVersion: 1,
        idempotencyKey: randomUUID()
      }
    });
    assert.equal(conflictRes.statusCode, 409);
    assert.equal((conflictRes.json() as { code: string }).code, "VERSION_CONFLICT");

    const deleteKey = randomUUID();
    const deleteRes = await context.app.inject({
      method: "DELETE",
      url: `/api/v1/vaults/${context.vaultId}/files/by-path/${encodedPath}`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: {
        baseVersion: 2,
        idempotencyKey: deleteKey
      }
    });
    assert.equal(deleteRes.statusCode, 200);
    const deleteBody = deleteRes.json() as FileWriteResponse;
    assert.equal(deleteBody.version, 3);
    assert.equal(deleteBody.op, "delete");
    assert.equal(deleteBody.checkpoint, "cp_3");

    const deleteReplayRes = await context.app.inject({
      method: "DELETE",
      url: `/api/v1/vaults/${context.vaultId}/files/by-path/${encodedPath}`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: {
        baseVersion: 2,
        idempotencyKey: deleteKey
      }
    });
    assert.equal(deleteReplayRes.statusCode, 200);
    assert.deepEqual(deleteReplayRes.json(), deleteBody);

    const listAfterDeleteRes = await context.app.inject({
      method: "GET",
      url: `/api/v1/vaults/${context.vaultId}/files?prefix=${encodeURIComponent("AI-Todo/")}`,
      headers: { authorization: `Bearer ${context.accessToken}` }
    });
    assert.equal(listAfterDeleteRes.statusCode, 200);
    assert.equal((listAfterDeleteRes.json() as { items: unknown[] }).items.length, 0);
  } finally {
    await destroyTestContext(context);
  }
});
