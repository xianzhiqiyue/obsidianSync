import type { FastifyInstance } from "fastify";
import { query } from "../db.js";
import { metricsRegistry } from "../metrics.js";
import type { ObjectStore } from "../object-store.js";

export default function systemRoutes(objectStore: ObjectStore) {
  return async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
    app.get("/health", async () => ({
      status: "ok",
      service: "sync-api",
      ts: new Date().toISOString()
    }));

    app.get("/ready", async (request, reply) => {
      try {
        await query("SELECT 1");
        await objectStore.healthcheck();
        return {
          status: "ready",
          ts: new Date().toISOString()
        };
      } catch (error) {
        request.log.error({ err: error }, "readiness check failed");
        return reply.code(503).send({
          status: "not_ready",
          ts: new Date().toISOString()
        });
      }
    });

    app.get("/metrics", async (_request, reply) => {
      const body = metricsRegistry.renderPrometheus();
      reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
      return reply.send(body);
    });
  };
}
