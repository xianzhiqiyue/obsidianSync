import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import jwt from "@fastify/jwt";
import Fastify, { type FastifyInstance } from "fastify";
import { appConfig } from "../config.js";
import { query } from "../db.js";
import { hashPassword } from "../security.js";
import authRoutes from "./auth.js";
import userRoutes from "./users.js";

interface TestContext {
  app: FastifyInstance;
  userId: string;
  email: string;
  password: string;
}

async function createTestContext(): Promise<TestContext> {
  const app = Fastify();
  await app.register(jwt, { secret: appConfig.jwtSecret });
  await app.register(authRoutes, { prefix: "/api/v1" });
  await app.register(userRoutes, { prefix: "/api/v1" });
  await app.ready();

  const userId = randomUUID();
  const email = `auth-test-${userId}@example.com`;
  const password = "old-password-123";
  await query("INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)", [
    userId,
    email,
    hashPassword(password),
    "测试用户"
  ]);

  return { app, userId, email, password };
}

async function destroyTestContext(context: TestContext): Promise<void> {
  await context.app.close();
  await query("DELETE FROM refresh_tokens WHERE user_id = $1", [context.userId]);
  await query("DELETE FROM devices WHERE user_id = $1", [context.userId]);
  await query("DELETE FROM users WHERE id = $1", [context.userId]);
}

test("auth login, refresh and logout should manage token lifecycle", async () => {
  const context = await createTestContext();
  try {
    const loginRes = await context.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: context.email,
        password: context.password,
        deviceName: "Nova-MacBook",
        platform: "macos",
        pluginVersion: "0.1.0"
      }
    });
    assert.equal(loginRes.statusCode, 200);
    const login = loginRes.json() as { accessToken: string; refreshToken: string; deviceId: string; user: { email: string } };
    assert.equal(login.user.email, context.email);
    assert.match(login.deviceId, /^[0-9a-f-]{36}$/i);

    const meRes = await context.app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: { authorization: `Bearer ${login.accessToken}` }
    });
    assert.equal(meRes.statusCode, 200);
    assert.equal(meRes.json().devices.length, 1);

    const refreshRes = await context.app.inject({
      method: "POST",
      url: "/api/v1/auth/token/refresh",
      payload: { refreshToken: login.refreshToken }
    });
    assert.equal(refreshRes.statusCode, 200);
    const refreshed = refreshRes.json() as { accessToken: string; refreshToken: string };
    assert.notEqual(refreshed.refreshToken, login.refreshToken);

    const replayRes = await context.app.inject({
      method: "POST",
      url: "/api/v1/auth/token/refresh",
      payload: { refreshToken: login.refreshToken }
    });
    assert.equal(replayRes.statusCode, 401);

    const logoutRes = await context.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { authorization: `Bearer ${refreshed.accessToken}` },
      payload: { refreshToken: refreshed.refreshToken }
    });
    assert.equal(logoutRes.statusCode, 200);

    const refreshAfterLogoutRes = await context.app.inject({
      method: "POST",
      url: "/api/v1/auth/token/refresh",
      payload: { refreshToken: refreshed.refreshToken }
    });
    assert.equal(refreshAfterLogoutRes.statusCode, 401);
  } finally {
    await destroyTestContext(context);
  }
});

test("user password update should revoke other device refresh tokens", async () => {
  const context = await createTestContext();
  try {
    const login = async (deviceName: string) => {
      const res = await context.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: {
          email: context.email,
          password: context.password,
          deviceName,
          platform: "macos",
          pluginVersion: "0.1.0"
        }
      });
      assert.equal(res.statusCode, 200);
      return res.json() as { accessToken: string; refreshToken: string; deviceId: string };
    };

    const first = await login("设备一");
    const second = await login("设备二");

    const updateRes = await context.app.inject({
      method: "POST",
      url: "/api/v1/users/me/password",
      headers: { authorization: `Bearer ${first.accessToken}` },
      payload: { currentPassword: context.password, newPassword: "new-password-456" }
    });
    assert.equal(updateRes.statusCode, 200);

    const secondRefreshRes = await context.app.inject({
      method: "POST",
      url: "/api/v1/auth/token/refresh",
      payload: { refreshToken: second.refreshToken }
    });
    assert.equal(secondRefreshRes.statusCode, 401);

    const firstRefreshRes = await context.app.inject({
      method: "POST",
      url: "/api/v1/auth/token/refresh",
      payload: { refreshToken: first.refreshToken }
    });
    assert.equal(firstRefreshRes.statusCode, 200);

    const oldPasswordRes = await context.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: context.email,
        password: context.password,
        deviceName: "旧密码设备",
        platform: "macos",
        pluginVersion: "0.1.0"
      }
    });
    assert.equal(oldPasswordRes.statusCode, 401);
  } finally {
    await destroyTestContext(context);
  }
});
