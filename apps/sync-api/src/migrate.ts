import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appConfig } from "./config.js";
import { pool } from "./db.js";
import { logger } from "./logger.js";
import { hashPassword } from "./security.js";

interface MigrationRow {
  id: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, "../migrations");

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function applyMigrations(): Promise<void> {
  await ensureMigrationsTable();

  const appliedRows = await pool.query<MigrationRow>("SELECT id FROM schema_migrations");
  const applied = new Set(appliedRows.rows.map((row: MigrationRow) => row.id));

  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  for (const fileName of files) {
    if (applied.has(fileName)) {
      continue;
    }

    const migrationPath = path.join(migrationsDir, fileName);
    const sql = await readFile(migrationPath, "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [fileName]);
      await client.query("COMMIT");
      logger.info({ fileName }, "applied migration");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function seedAdminUser(): Promise<void> {
  const result = await pool.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [
    appConfig.seedAdminEmail
  ]);
  if ((result.rowCount ?? 0) > 0) {
    logger.info({ email: appConfig.seedAdminEmail }, "admin user already exists");
    return;
  }

  const passwordHash = hashPassword(appConfig.seedAdminPassword);
  await pool.query("INSERT INTO users (email, password_hash) VALUES ($1, $2)", [
    appConfig.seedAdminEmail,
    passwordHash
  ]);
  logger.info({ email: appConfig.seedAdminEmail }, "seeded admin user");
}

async function run(): Promise<void> {
  try {
    await applyMigrations();
    await seedAdminUser();
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  logger.error({ err: error }, "migration failed");
  process.exit(1);
});
