import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { query } from "../db.js";

const createVaultSchema = z.object({
  name: z.string().min(1).max(100)
});

interface VaultRow {
  id: string;
  name: string;
  created_at: Date;
}

export default async function vaultRoutes(app: FastifyInstance): Promise<void> {
  app.get("/vaults", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    const result = await query<VaultRow>(
      `SELECT id, name, created_at
       FROM vaults
       WHERE owner_user_id = $1
       ORDER BY created_at DESC`,
      [auth.userId]
    );

    return reply.send({
      items: result.rows.map((vault: VaultRow) => ({
        vaultId: vault.id,
        name: vault.name,
        createdAt: vault.created_at.toISOString()
      }))
    });
  });

  app.post("/vaults", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    const parsed = createVaultSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: parsed.error.flatten() });
    }

    const result = await query<VaultRow>(
      `INSERT INTO vaults (owner_user_id, name)
       VALUES ($1, $2)
       RETURNING id, name, created_at`,
      [auth.userId, parsed.data.name]
    );
    const vault = result.rows[0];
    if (!vault) {
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "failed to create vault" });
    }

    return reply.code(201).send({
      vaultId: vault.id,
      name: vault.name,
      createdAt: vault.created_at.toISOString()
    });
  });
}
