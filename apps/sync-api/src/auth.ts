import type { FastifyReply, FastifyRequest } from "fastify";
import { query } from "./db.js";

export interface AuthTokenPayload {
  sub: string;
  deviceId: string;
  type?: "access" | "refresh";
}

export interface AuthContext {
  userId: string;
  deviceId: string;
}

interface ActiveDeviceRow {
  id: string;
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<AuthContext | null> {
  try {
    await request.jwtVerify<AuthTokenPayload>();
    const payload = request.user as AuthTokenPayload;
    if (payload.type !== "access") {
      reply.code(401).send({ code: "UNAUTHORIZED", message: "access token required" });
      return null;
    }
    const activeDevice = await query<ActiveDeviceRow>(
      `SELECT id
       FROM devices
       WHERE id = $1
         AND user_id = $2
         AND status = 'active'
       LIMIT 1`,
      [payload.deviceId, payload.sub]
    );
    if ((activeDevice.rowCount ?? 0) === 0) {
      reply.code(403).send({ code: "DEVICE_REVOKED", message: "device is revoked or missing" });
      return null;
    }
    return {
      userId: payload.sub,
      deviceId: payload.deviceId
    };
  } catch {
    reply.code(401).send({ code: "UNAUTHORIZED", message: "invalid access token" });
    return null;
  }
}
