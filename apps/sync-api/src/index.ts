import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { appConfig } from "./config.js";
import { pool } from "./db.js";
import { logger } from "./logger.js";
import { registerHttpMetricsHooks } from "./metrics.js";
import { ObjectStore } from "./object-store.js";
import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import syncRoutes from "./routes/sync.js";
import systemRoutes from "./routes/system.js";
import vaultRoutes from "./routes/vaults.js";


const adminContentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".map", "application/json; charset=utf-8"]
]);

function resolveAdminAssetPath(requestPath: string): string {
  const adminRoot = path.resolve(process.cwd(), "../admin/dist");
  const relativePath = requestPath.replace(/^\/admin\/?/, "") || "index.html";
  const safePath = path.normalize(relativePath).replace(/^\.\.(?:\/|$)/, "");
  return path.join(adminRoot, safePath);
}

async function registerAdminUiRoutes(app: Awaited<ReturnType<typeof Fastify>>): Promise<void> {
  app.get("/admin", async (_request: FastifyRequest, reply: FastifyReply) => reply.redirect("/admin/"));
  app.get("/admin/*", async (request: FastifyRequest, reply: FastifyReply) => {
    const filePath = resolveAdminAssetPath(request.url);
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        return reply.code(404).send({ code: "NOT_FOUND", message: "admin asset not found" });
      }
      const contentType = adminContentTypes.get(path.extname(filePath)) ?? "application/octet-stream";
      return reply.header("content-type", contentType).send(createReadStream(filePath));
    } catch {
      return reply.code(404).send({ code: "NOT_FOUND", message: "admin asset not found" });
    }
  });
}

async function buildServer() {
  const app = Fastify({
    loggerInstance: logger
  });
  registerHttpMetricsHooks(app);

  await app.register(cors, {
    origin:
      appConfig.corsOrigin === "*"
        ? true
        : appConfig.corsOrigin.split(",").map((origin) => origin.trim())
  });

  await app.register(jwt, {
    secret: appConfig.jwtSecret
  });

  const objectStore = new ObjectStore(appConfig);
  await objectStore.ensureBucket();

  await app.register(authRoutes, { prefix: "/api/v1" });
  await app.register(adminRoutes(objectStore), { prefix: "/api/v1" });
  await app.register(vaultRoutes, { prefix: "/api/v1" });
  await app.register(syncRoutes(objectStore), { prefix: "/api/v1" });
  await app.register(systemRoutes(objectStore), { prefix: "/api/v1" });
  await registerAdminUiRoutes(app);

  return app;
}

async function start() {
  const app = await buildServer();

  const close = async () => {
    logger.info("shutting down sync-api");
    await app.close();
    await pool.end();
    process.exit(0);
  };

  process.on("SIGINT", close);
  process.on("SIGTERM", close);

  await app.listen({
    host: appConfig.host,
    port: appConfig.port
  });

  logger.info({ host: appConfig.host, port: appConfig.port }, "sync-api started");
}

start().catch((error) => {
  logger.error({ err: error }, "sync-api failed to start");
  process.exit(1);
});
