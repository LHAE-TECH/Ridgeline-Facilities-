import pg from 'pg';
import { config } from './config.js';

// BIGINT (int8) → JS number. Cent amounts stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// NUMERIC → JS number (used for quantities/coordinates, never for money).
pg.types.setTypeParser(1700, (v) => Number(v));
// DATE → keep as 'YYYY-MM-DD' string to avoid timezone shifts.
pg.types.setTypeParser(1082, (v) => v);

export type Db = pg.Pool | pg.PoolClient;

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

export async function query<T extends pg.QueryResultRow = any>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query<T>(sql, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = any>(db: Db, sql: string, params: unknown[] = []): Promise<T> {
  const rows = await query<T>(db, sql, params);
  if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
  return rows[0];
}

export async function maybeOne<T extends pg.QueryResultRow = any>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(db, sql, params);
  return rows[0] ?? null;
}

function isPoolClient(db: Db): db is pg.PoolClient {
  return typeof (db as pg.PoolClient).release === 'function';
}

/**
 * Runs fn inside a database transaction. If db is already a transaction client, a savepoint is used
 * so services can be composed. Serialization failures and deadlocks are retried.
 */
export async function tx<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  if (isPoolClient(db)) {
    const sp = `sp_${Math.random().toString(36).slice(2, 10)}`;
    await db.query(`SAVEPOINT ${sp}`);
    try {
      const result = await fn(db);
      await db.query(`RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (err) {
      await db.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      throw err;
    }
  }
  for (let attempt = 1; ; attempt++) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((err?.code === '40001' || err?.code === '40P01') && attempt < 4) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (!constraint || e.constraint === constraint);
}
