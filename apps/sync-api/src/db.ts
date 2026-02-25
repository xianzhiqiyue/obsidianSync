import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { appConfig } from "./config.js";
import { logger } from "./logger.js";

export const pool = new Pool({
  connectionString: appConfig.postgresDsn,
  max: 20
});

pool.on("error", (error: Error) => {
  logger.error({ err: error }, "postgres pool error");
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<QueryResult<T>> {
  return pool.query<T>(text, values);
}

export async function withTransaction<T>(runner: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await runner(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
