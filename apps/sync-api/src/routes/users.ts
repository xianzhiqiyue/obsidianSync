import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { query, withTransaction } from "../db.js";
import { hashPassword, verifyPassword } from "../security.js";

const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(120).nullable().optional()
});

const updatePasswordSchema = z.object({
  currentPassword: z.string().min(8),
  newPassword: z.string().min(8).max(200)
});

const deviceParamsSchema = z.object({
  deviceId: z.string().uuid()
});

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  created_at: Date;
  updated_at: Date | null;
  last_login_at: Date | null;
}

interface UserWithPasswordRow extends UserRow {
  password_hash: string;
}

interface DeviceRow {
  id: string;
  device_name: string;
  platform: string;
  plugin_version: string;
  status: "active" | "revoked";
  created_at: Date;
  revoked_at: Date | null;
  active_refresh_token_count: string;
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function serializeUser(user: UserRow): Record<string, unknown> {
  return {
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
    createdAt: user.created_at.toISOString(),
    updatedAt: toIso(user.updated_at),
    lastLoginAt: toIso(user.last_login_at)
  };
}

function serializeDevice(device: DeviceRow, currentDeviceId: string): Record<string, unknown> {
  return {
    deviceId: device.id,
    deviceName: device.device_name,
    platform: device.platform,
    pluginVersion: device.plugin_version,
    status: device.status,
    current: device.id === currentDeviceId,
    createdAt: device.created_at.toISOString(),
    revokedAt: toIso(device.revoked_at),
    activeRefreshTokenCount: Number(device.active_refresh_token_count)
  };
}

async function loadUser(userId: string): Promise<UserRow | null> {
  const result = await query<UserRow>(
    `SELECT id, email, display_name, created_at, updated_at, last_login_at
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] ?? null;
}

async function loadDevices(userId: string): Promise<DeviceRow[]> {
  const result = await query<DeviceRow>(
    `SELECT d.id, d.device_name, d.platform, d.plugin_version, d.status, d.created_at, d.revoked_at,
            COUNT(rt.id) FILTER (WHERE rt.revoked_at IS NULL AND rt.expires_at > NOW())::text AS active_refresh_token_count
     FROM devices d
     LEFT JOIN refresh_tokens rt ON rt.device_id = d.id
     WHERE d.user_id = $1
     GROUP BY d.id
     ORDER BY d.created_at DESC`,
    [userId]
  );
  return result.rows;
}

export default async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get("/users/me", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    const user = await loadUser(auth.userId);
    if (!user) {
      return reply.code(404).send({ code: "USER_NOT_FOUND", message: "user missing" });
    }
    const devices = await loadDevices(auth.userId);
    return reply.send({
      user: serializeUser(user),
      currentDeviceId: auth.deviceId,
      devices: devices.map((device) => serializeDevice(device, auth.deviceId))
    });
  });

  app.patch("/users/me", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    const parsed = updateProfileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: parsed.error.flatten() });
    }

    const result = await query<UserRow>(
      `UPDATE users
       SET display_name = COALESCE($2, display_name), updated_at = NOW()
       WHERE id = $1
       RETURNING id, email, display_name, created_at, updated_at, last_login_at`,
      [auth.userId, parsed.data.displayName ?? null]
    );
    const user = result.rows[0];
    if (!user) {
      return reply.code(404).send({ code: "USER_NOT_FOUND", message: "user missing" });
    }

    return reply.send({ user: serializeUser(user) });
  });

  app.post("/users/me/password", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    const parsed = updatePasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: parsed.error.flatten() });
    }
    if (parsed.data.currentPassword === parsed.data.newPassword) {
      return reply.code(400).send({ code: "PASSWORD_UNCHANGED", message: "new password must differ" });
    }

    const userResult = await query<UserWithPasswordRow>(
      `SELECT id, email, display_name, password_hash, created_at, updated_at, last_login_at
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [auth.userId]
    );
    const user = userResult.rows[0];
    if (!user) {
      return reply.code(404).send({ code: "USER_NOT_FOUND", message: "user missing" });
    }
    if (!verifyPassword(parsed.data.currentPassword, user.password_hash)) {
      return reply.code(401).send({ code: "INVALID_CREDENTIALS", message: "current password invalid" });
    }

    await withTransaction(async (client) => {
      await client.query("UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1", [
        auth.userId,
        hashPassword(parsed.data.newPassword)
      ]);
      await client.query(
        `UPDATE refresh_tokens
         SET revoked_at = NOW()
         WHERE user_id = $1 AND device_id <> $2 AND revoked_at IS NULL`,
        [auth.userId, auth.deviceId]
      );
    });

    return reply.send({ status: "password_updated", revokedOtherDevices: true });
  });

  app.get("/users/me/devices", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    const devices = await loadDevices(auth.userId);
    return reply.send({ items: devices.map((device) => serializeDevice(device, auth.deviceId)) });
  });

  app.post("/users/me/devices/:deviceId/revoke", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    const parsed = deviceParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: parsed.error.flatten() });
    }

    const updated = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE devices
         SET status = 'revoked', revoked_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status <> 'revoked'`,
        [parsed.data.deviceId, auth.userId]
      );
      if ((result.rowCount ?? 0) > 0) {
        await client.query(
          "UPDATE refresh_tokens SET revoked_at = NOW() WHERE device_id = $1 AND revoked_at IS NULL",
          [parsed.data.deviceId]
        );
      }
      return result.rowCount ?? 0;
    });

    if (updated === 0) {
      return reply.code(404).send({ code: "DEVICE_NOT_FOUND", message: "device not found" });
    }
    return reply.send({ deviceId: parsed.data.deviceId, status: "revoked" });
  });
}
