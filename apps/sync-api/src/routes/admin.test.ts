import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import jwt from "@fastify/jwt";
import Fastify, { type FastifyInstance } from "fastify";
import { appConfig } from "../config.js";
import { query } from "../db.js";
import { ObjectStore } from "../object-store.js";
import adminRoutes from "./admin.js";

interface TestContext {
  app: FastifyInstance;
  userId: string;
  deviceId: string;
  vaultId: string;
  accessToken: string;
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

function testContentHash(label: string): string {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

async function createTestContext(existingHashes: Set<string>): Promise<TestContext> {
  const app = Fastify();
  await app.register(jwt, { secret: appConfig.jwtSecret });
  await app.register(adminRoutes(new FakeObjectStore(existingHashes)), { prefix: "/api/v1" });
  await app.ready();

  const userId = randomUUID();
  const deviceId = randomUUID();
  const vaultId = randomUUID();
  await query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)", [
    userId,
    `admin-test-${userId}@example.com`,
    "test-password-hash"
  ]);
  await query(
    `INSERT INTO devices (id, user_id, device_name, platform, plugin_version, status, revoked_at)
     VALUES ($1, $2, $3, $4, $5, 'active', NULL)`,
    [deviceId, userId, `admin-device-${deviceId}`, "macos", "test"]
  );
  await query("INSERT INTO vaults (id, owner_user_id, name) VALUES ($1, $2, $3)", [
    vaultId,
    userId,
    `vault-${vaultId}`
  ]);

  const accessToken = app.jwt.sign({ sub: userId, deviceId, type: "access" });
  return { app, userId, deviceId, vaultId, accessToken };
}

async function destroyTestContext(context: TestContext, hashes: string[]): Promise<void> {
  await context.app.close();
  await query("DELETE FROM vaults WHERE owner_user_id = $1", [context.userId]);
  await query("DELETE FROM devices WHERE user_id = $1", [context.userId]);
  await query("DELETE FROM users WHERE id = $1", [context.userId]);
  if (hashes.length > 0) {
    await query("DELETE FROM object_blobs WHERE content_hash = ANY($1::text[])", [hashes]);
  }
}

async function seedFile(context: TestContext, path: string, hashes: string[]): Promise<string> {
  const fileId = randomUUID();
  await query("INSERT INTO vault_sync_state (vault_id, latest_checkpoint) VALUES ($1, 1)", [context.vaultId]);
  await query("INSERT INTO object_blobs (content_hash) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING", [hashes]);
  await query(
    "INSERT INTO file_entries (id, vault_id, current_path, head_version) VALUES ($1, $2, $3, $4)",
    [fileId, context.vaultId, path, hashes.length]
  );
  for (const [index, hash] of hashes.entries()) {
    await query(
      "INSERT INTO file_versions (file_id, version, content_hash, author_device_id, mtime_ms, ctime_ms) VALUES ($1, $2, $3, $4, $5, $6)",
      [fileId, index + 1, hash, context.deviceId, 1000 + index, 2000 + index]
    );
  }
  await query(
    `INSERT INTO changesets (vault_id, device_id, checkpoint, status)
     VALUES ($1, $2, 1, 'committed')`,
    [context.vaultId, context.deviceId]
  );
  const changeset = await query<{ id: string }>("SELECT id FROM changesets WHERE vault_id = $1 AND checkpoint = 1", [context.vaultId]);
  await query(
    `INSERT INTO change_events (vault_id, changeset_id, checkpoint, op, file_id, path, version, content_hash)
     VALUES ($1, $2, 1, 'update', $3, $4, $5, $6)`,
    [context.vaultId, changeset.rows[0]!.id, fileId, path, hashes.length, hashes.at(-1)]
  );
  return fileId;
}

test("admin restore should create a new version, admin event, audit row and checkpoint", async () => {
  const oldHash = testContentHash("admin-old");
  const badHash = testContentHash("admin-bad");
  const context = await createTestContext(new Set([oldHash, badHash]));
  try {
    const fileId = await seedFile(context, `notes/${randomUUID()}.md`, [oldHash, badHash]);
    await query("UPDATE file_entries SET deleted_at = NOW() WHERE id = $1", [fileId]);

    const previewRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/admin/vaults/${context.vaultId}/files/${fileId}/actions/preview`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: { action: "restore", version: 1, targetPath: "notes/restored.md" }
    });
    assert.equal(previewRes.statusCode, 200);
    const preview = previewRes.json() as { confirmToken: string; willCreateVersion: number; willCreateCheckpoint: string };
    assert.equal(preview.willCreateVersion, 3);
    assert.equal(preview.willCreateCheckpoint, "cp_2");

    const restoreRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/admin/vaults/${context.vaultId}/files/${fileId}/restore`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: { version: 1, targetPath: "notes/restored.md", reason: "恢复误删除文件", confirmToken: preview.confirmToken }
    });
    assert.equal(restoreRes.statusCode, 200);
    const restored = restoreRes.json() as { operationId: string; changesetId: string; newVersion: number; newCheckpoint: string };
    assert.equal(restored.newVersion, 3);
    assert.equal(restored.newCheckpoint, "cp_2");

    const file = await query<{ current_path: string; head_version: number; deleted_at: Date | null }>(
      "SELECT current_path, head_version, deleted_at FROM file_entries WHERE id = $1",
      [fileId]
    );
    assert.equal(file.rows[0]?.current_path, "notes/restored.md");
    assert.equal(file.rows[0]?.head_version, 3);
    assert.equal(file.rows[0]?.deleted_at, null);

    const version = await query<{ content_hash: string }>(
      "SELECT content_hash FROM file_versions WHERE file_id = $1 AND version = 3",
      [fileId]
    );
    assert.equal(version.rows[0]?.content_hash, oldHash);

    const event = await query<{ op: string; source: string; reason: string; admin_operation_id: string }>(
      "SELECT op, source, reason, admin_operation_id FROM change_events WHERE vault_id = $1 AND checkpoint = 2",
      [context.vaultId]
    );
    assert.equal(event.rows[0]?.op, "update");
    assert.equal(event.rows[0]?.source, "admin");
    assert.equal(event.rows[0]?.reason, "恢复误删除文件");
    assert.equal(event.rows[0]?.admin_operation_id, restored.operationId);

    const operation = await query<{ changeset_id: string; after_json: { headVersion: number } }>(
      "SELECT changeset_id, after_json FROM admin_operations WHERE id = $1",
      [restored.operationId]
    );
    assert.equal(operation.rows[0]?.changeset_id, restored.changesetId);
    assert.equal(operation.rows[0]?.after_json.headVersion, 3);
  } finally {
    await destroyTestContext(context, [oldHash, badHash]);
  }
});

test("admin soft delete should use three month tombstone retention and reject stale confirmation", async () => {
  const hash = testContentHash("admin-delete");
  const context = await createTestContext(new Set([hash]));
  try {
    const fileId = await seedFile(context, `notes/${randomUUID()}.md`, [hash]);
    const previewRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/admin/vaults/${context.vaultId}/files/${fileId}/actions/preview`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: { action: "soft_delete" }
    });
    assert.equal(previewRes.statusCode, 200);
    const preview = previewRes.json() as { confirmToken: string };

    const staleRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/admin/vaults/${context.vaultId}/files/${fileId}/soft-delete`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: { reason: "测试陈旧确认", confirmToken: `${preview.confirmToken}x` }
    });
    assert.equal(staleRes.statusCode, 409);

    const deleteRes = await context.app.inject({
      method: "POST",
      url: `/api/v1/admin/vaults/${context.vaultId}/files/${fileId}/soft-delete`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      payload: { reason: "后台软删除测试", confirmToken: preview.confirmToken }
    });
    assert.equal(deleteRes.statusCode, 200);
    assert.equal(deleteRes.json().newCheckpoint, "cp_2");

    const tombstone = await query<{ retention_days: string }>(
      "SELECT ROUND(EXTRACT(EPOCH FROM (expire_at - deleted_at)) / 86400)::text AS retention_days FROM tombstones WHERE file_id = $1",
      [fileId]
    );
    assert.equal(Number(tombstone.rows[0]?.retention_days), 90);
  } finally {
    await destroyTestContext(context, [hash]);
  }
});
