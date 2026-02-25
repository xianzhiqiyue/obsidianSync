import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import Fastify from "fastify";
import { appConfig } from "./config.js";
import { pool } from "./db.js";
import { logger } from "./logger.js";
import { registerHttpMetricsHooks } from "./metrics.js";
import { ObjectStore } from "./object-store.js";
import authRoutes from "./routes/auth.js";
import syncRoutes from "./routes/sync.js";
import systemRoutes from "./routes/system.js";
import vaultRoutes from "./routes/vaults.js";

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
  await app.register(vaultRoutes, { prefix: "/api/v1" });
  await app.register(syncRoutes(objectStore), { prefix: "/api/v1" });
  await app.register(systemRoutes(objectStore), { prefix: "/api/v1" });

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
