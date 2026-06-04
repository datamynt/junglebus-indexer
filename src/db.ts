/**
 * db.ts — PostgreSQL connection pool with timeout-guarded queries.
 *
 * All queries go through the query() wrapper which applies an
 * AbortController timeout. This prevents the indexer from silently
 * stalling on hung database connections — a real problem we hit
 * in production.
 */

import pkg from "pg";
import type { Pool as PgPool, PoolConfig, QueryResult, QueryResultRow } from "pg";
const { Pool } = pkg;

/** A pg Pool augmented with the per-query timeout this module enforces. */
type TimedPool = PgPool & { _queryTimeoutMs?: number };

let pool: TimedPool | null = null;

/**
 * Initialize the connection pool.
 * @param config - pg Pool config (host, user, password, database, port, etc.)
 * @param queryTimeoutMs - Timeout for individual queries (default 30000ms).
 */
export const initPool = (
  config: PoolConfig,
  queryTimeoutMs = 30_000,
): TimedPool => {
  pool = new Pool({
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: false,
    ...config,
  }) as TimedPool;

  pool.on("error", (err: Error) => {
    console.error("[db] Unexpected pool error:", err.message);
  });

  // Store timeout for use in query()
  pool._queryTimeoutMs = queryTimeoutMs;
  return pool;
};

/**
 * Execute a parameterized query with timeout.
 * @param text - SQL query
 * @param params - Query parameters
 * @returns Query result, or null on error/timeout.
 */
export const query = async <R extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<R> | null> => {
  if (!pool) {
    throw new Error("Database pool not initialized. Call initPool() first.");
  }

  const timeout = pool._queryTimeoutMs ?? 30_000;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeout);

  try {
    // pg's QueryConfig accepts an AbortSignal at runtime, but the bundled
    // typings don't expose it — cast through unknown to attach the signal.
    const config = {
      text,
      values: params,
      signal: abortController.signal,
    } as unknown as { text: string; values: unknown[] };
    return await pool.query<R>(config);
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") {
      console.error(
        `[db] Query timed out after ${timeout}ms:`,
        text.substring(0, 80),
      );
    } else {
      console.error("[db] Query error:", err.message);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Check if the database connection is alive.
 */
export const healthCheck = async (): Promise<boolean> => {
  try {
    if (!pool) return false;
    return !!(await pool.query("SELECT 1"));
  } catch (e) {
    console.error("[db] Health check failed:", (e as Error).message);
    return false;
  }
};

/**
 * Get the raw pool for advanced use (migrations, transactions, etc.)
 */
export const getPool = (): TimedPool | null => pool;
