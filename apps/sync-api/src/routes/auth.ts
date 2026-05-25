import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, type AuthTokenPayload } from "../auth.js";
import { appConfig } from "../config.js";
import { query, withTransaction } from "../db.js";
import { metricsRegistry } from "../metrics.js";
import { hashPassword, sha256, verifyPassword } from "../security.js";

const platformSchema = z.enum(["macos", "windows", "android", "ios", "linux", "unknown"]);

const registerBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  displayName: z.string().trim().min(1).max(120).optional()
});

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  deviceName: z.string().min(1).max(120),
  platform: platformSchema,
  pluginVersion: z.string().min(1).max(50)
});

const refreshBodySchema = z.object({
  refreshToken: z.string().min(1)
});

const logoutBodySchema = z.object({
  refreshToken: z.string().min(1).optional(),
  revokeDevice: z.boolean().default(false)
});

const revokeBodySchema = z.object({
  deviceId: z.string().uuid()
});

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  password_hash: string;
}

interface DeviceRow {
  id: string;
}

interface RefreshTokenRow {
  id: string;
  user_id: string;
  device_id: string;
}

function accessTokenExpiresAt(): number {
  return appConfig.accessTokenTtlSec;
}

function refreshTokenExpiresAt(): Date {
  const expiresMs = appConfig.refreshTokenTtlDays * 24 * 60 * 60 * 1000;
  return new Date(Date.now() + expiresMs);
}

function canSelfRegister(requestToken: unknown): boolean {
  if (appConfig.allowSelfRegistration) return true;
  return (
    typeof requestToken === "string" &&
    appConfig.bootstrapAdminToken !== undefined &&
    requestToken === appConfig.bootstrapAdminToken
  );
}

async function issueTokenPair(
  app: FastifyInstance,
  userId: string,
  deviceId: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = app.jwt.sign(
    {
      sub: userId,
      deviceId,
      type: "access",
      jti: randomUUID()
    } satisfies AuthTokenPayload,
    { expiresIn: appConfig.accessTokenTtlSec }
  );

  const refreshToken = app.jwt.sign(
    {
      sub: userId,
      deviceId,
      type: "refresh",
      jti: randomUUID()
    } satisfies AuthTokenPayload,
    { expiresIn: `${appConfig.refreshTokenTtlDays}d` }
  );

  return { accessToken, refreshToken };
}

async function registerOrUpdateDevice(args: {
  userId: string;
  deviceName: string;
  platform: z.infer<typeof platformSchema>;
  pluginVersion: string;
}): Promise<DeviceRow | null> {
  const deviceResult = await query<DeviceRow>(
    `INSERT INTO devices (user_id, device_name, platform, plugin_version, status, revoked_at)
     VALUES ($1, $2, $3, $4, 'active', NULL)
     ON CONFLICT (user_id, device_name, platform)
     DO UPDATE SET plugin_version = EXCLUDED.plugin_version, status = 'active', revoked_at = NULL
     RETURNING id`,
    [args.userId, args.deviceName, args.platform, args.pluginVersion]
  );
  return deviceResult.rows[0] ?? null;
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/bootstrap-admin", async (request, reply) => {
    const providedToken = request.headers["x-bootstrap-token"];
    const hasValidBootstrapToken =
      typeof providedToken === "string" &&
      appConfig.bootstrapAdminToken !== undefined &&
      providedToken === appConfig.bootstrapAdminToken;
    if (appConfig.env === "production" || appConfig.bootstrapAdminToken) {
      if (!hasValidBootstrapToken) {
        return reply.code(404).send({ code: "NOT_FOUND", message: "route not found" });
      }
    }

    const existing = await query<{ id: string }>("SELECT id FROM users WHERE email = $1", [
      appConfig.seedAdminEmail
    ]);
    if (existing.rowCount && existing.rowCount > 0) {
      return reply.send({ status: "exists", email: appConfig.seedAdminEmail });
    }

    const passwordHash = hashPassword(appConfig.seedAdminPassword);
    await query("INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3)", [
      appConfig.seedAdminEmail,
      passwordHash,
      "管理员"
    ]);
    return reply.code(201).send({ status: "created", email: appConfig.seedAdminEmail });
  });

  app.post("/auth/register", async (request, reply) => {
    if (!canSelfRegister(request.headers["x-registration-token"])) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "route not found" });
    }

    const parsed = registerBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: parsed.error.flatten() });
    }

    const { email, password, displayName } = parsed.data;
    try {
      const user = await query<{ id: string; email: string; display_name: string | null; created_at: Date }>(
        `INSERT INTO users (email, password_hash, display_name)
         VALUES ($1, $2, $3)
         RETURNING id, email, display_name, created_at`,
        [email, hashPassword(password), displayName ?? null]
      );
      const row = user.rows[0];
      return reply.code(201).send({
        userId: row?.id,
        email: row?.email,
        displayName: row?.display_name,
        createdAt: row?.created_at.toISOString()
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        return reply.code(409).send({ code: "USER_EXISTS", message: "email already registered" });
      }
      throw error;
    }
  });

  app.post("/auth/login", async (request, reply) => {
    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      metricsRegistry.incCounter("sync_api_auth_login_total", { result: "invalid_request" });
      return reply.code(400).send({
        code: "INVALID_REQUEST",
        message: parsed.error.flatten()
      });
    }

    const { email, password, deviceName, platform, pluginVersion } = parsed.data;
    const userResult = await query<UserRow>(
      "SELECT id, email, display_name, password_hash FROM users WHERE email = $1 LIMIT 1",
      [email]
    );
    const user = userResult.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      metricsRegistry.incCounter("sync_api_auth_login_total", { result: "invalid_credentials" });
      return reply.code(401).send({ code: "INVALID_CREDENTIALS", message: "email or password invalid" });
    }

    const device = await registerOrUpdateDevice({ userId: user.id, deviceName, platform, pluginVersion });
    if (!device) {
      metricsRegistry.incCounter("sync_api_auth_login_total", { result: "internal_error" });
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "failed to register device" });
    }

    const { accessToken, refreshToken } = await issueTokenPair(app, user.id, device.id);
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO refresh_tokens (user_id, device_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [user.id, device.id, sha256(refreshToken), refreshTokenExpiresAt()]
      );
      await client.query("UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1", [user.id]);
    });

    metricsRegistry.incCounter("sync_api_auth_login_total", { result: "success" });
    return reply.send({
      user: {
        userId: user.id,
        email: user.email,
        displayName: user.display_name
      },
      deviceId: device.id,
      accessToken,
      refreshToken,
      expiresIn: accessTokenExpiresAt()
    });
  });

  app.post("/auth/token/refresh", async (request, reply) => {
    const parsed = refreshBodySchema.safeParse(request.body);
    if (!parsed.success) {
      metricsRegistry.incCounter("sync_api_auth_refresh_total", { result: "invalid_request" });
      return reply.code(400).send({ code: "INVALID_REQUEST", message: parsed.error.flatten() });
    }

    const { refreshToken } = parsed.data;
    let payload: AuthTokenPayload;
    try {
      payload = await app.jwt.verify<AuthTokenPayload>(refreshToken);
    } catch {
      metricsRegistry.incCounter("sync_api_auth_refresh_total", { result: "token_invalid" });
      return reply.code(401).send({ code: "TOKEN_INVALID", message: "invalid refresh token" });
    }

    if (payload.type !== "refresh") {
      metricsRegistry.incCounter("sync_api_auth_refresh_total", { result: "token_invalid" });
      return reply.code(401).send({ code: "TOKEN_INVALID", message: "invalid token type" });
    }

    const tokenHash = sha256(refreshToken);
    const tokenResult = await query<RefreshTokenRow>(
      `SELECT rt.id, rt.user_id, rt.device_id
       FROM refresh_tokens rt
       JOIN devices d ON d.id = rt.device_id
       WHERE rt.token_hash = $1
         AND rt.revoked_at IS NULL
         AND rt.expires_at > NOW()
         AND d.status = 'active'
       LIMIT 1`,
      [tokenHash]
    );
    const currentToken = tokenResult.rows[0];
    if (!currentToken) {
      metricsRegistry.incCounter("sync_api_auth_refresh_total", { result: "token_expired" });
      return reply.code(401).send({ code: "TOKEN_EXPIRED", message: "refresh token revoked or expired" });
    }

    if (currentToken.user_id !== payload.sub || currentToken.device_id !== payload.deviceId) {
      metricsRegistry.incCounter("sync_api_auth_refresh_total", { result: "token_invalid" });
      return reply.code(401).send({ code: "TOKEN_INVALID", message: "token payload mismatch" });
    }

    const next = await withTransaction(async (client) => {
      await client.query("UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1", [currentToken.id]);
      const tokenPair = await issueTokenPair(app, currentToken.user_id, currentToken.device_id);
      await client.query(
        `INSERT INTO refresh_tokens (user_id, device_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [currentToken.user_id, currentToken.device_id, sha256(tokenPair.refreshToken), refreshTokenExpiresAt()]
      );
      return tokenPair;
    });

    metricsRegistry.incCounter("sync_api_auth_refresh_total", { result: "success" });
    return reply.send({
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      expiresIn: accessTokenExpiresAt()
    });
  });

  app.post("/auth/logout", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    const parsed = logoutBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: parsed.error.flatten() });
    }

    await withTransaction(async (client) => {
      if (parsed.data.refreshToken) {
        await client.query(
          `UPDATE refresh_tokens
           SET revoked_at = NOW()
           WHERE token_hash = $1 AND user_id = $2 AND revoked_at IS NULL`,
          [sha256(parsed.data.refreshToken), auth.userId]
        );
      } else {
        await client.query(
          "UPDATE refresh_tokens SET revoked_at = NOW() WHERE device_id = $1 AND user_id = $2 AND revoked_at IS NULL",
          [auth.deviceId, auth.userId]
        );
      }

      if (parsed.data.revokeDevice) {
        await client.query(
          "UPDATE devices SET status = 'revoked', revoked_at = NOW() WHERE id = $1 AND user_id = $2",
          [auth.deviceId, auth.userId]
        );
      }
    });

    return reply.send({ status: "logged_out", deviceId: auth.deviceId });
  });

  app.get("/auth/me", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    const userResult = await query<{ id: string; email: string; display_name: string | null }>(
      "SELECT id, email, display_name FROM users WHERE id = $1 LIMIT 1",
      [auth.userId]
    );
    const user = userResult.rows[0];
    if (!user) {
      return reply.code(404).send({ code: "USER_NOT_FOUND", message: "user missing" });
    }

    return reply.send({
      userId: user.id,
      email: user.email,
      displayName: user.display_name,
      deviceId: auth.deviceId
    });
  });

  app.post("/auth/device/revoke", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    const parsed = revokeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: parsed.error.flatten() });
    }

    const { deviceId } = parsed.data;
    const updated = await query(
      `UPDATE devices
       SET status = 'revoked', revoked_at = NOW()
       WHERE id = $1
         AND user_id = $2
         AND status <> 'revoked'`,
      [deviceId, auth.userId]
    );

    if ((updated.rowCount ?? 0) === 0) {
      return reply.code(404).send({ code: "DEVICE_NOT_FOUND", message: "device not found" });
    }

    await query("UPDATE refresh_tokens SET revoked_at = NOW() WHERE device_id = $1 AND revoked_at IS NULL", [
      deviceId
    ]);

    return reply.send({ deviceId, status: "revoked" });
  });
}
