import type { FastifyReply, FastifyRequest } from "fastify";

export interface AuthTokenPayload {
  sub: string;
  deviceId: string;
  type?: "access" | "refresh";
}

export interface AuthContext {
  userId: string;
  deviceId: string;
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<AuthContext | null> {
  try {
    await request.jwtVerify<AuthTokenPayload>();
    const payload = request.user as AuthTokenPayload;
    return {
      userId: payload.sub,
      deviceId: payload.deviceId
    };
  } catch {
    reply.code(401).send({ code: "UNAUTHORIZED", message: "invalid access token" });
    return null;
  }
}
