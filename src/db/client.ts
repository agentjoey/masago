import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { config } from '../config/index.js';
import { logger } from '../observability/index.js';
import * as schema from './schema/index.js';

export const pool = new Pool({
  connectionString: config.db.url,
  max: config.db.poolMax,
  idleTimeoutMillis: config.db.poolIdleTimeoutMs,
  connectionTimeoutMillis: config.db.connectionTimeoutMs,
  ssl: { rejectUnauthorized: true },
});

pool.on('error', (error) => {
  logger.error('idle database client error', { err: error });
});

export const db: NodePgDatabase<typeof schema> = drizzle(pool, { schema });

export async function closeDb(): Promise<void> {
  await pool.end();
}
