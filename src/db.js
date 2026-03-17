/**
 * db.js — PostgreSQL connection pool with timeout-guarded queries.
 *
 * All queries go through the query() wrapper which applies an
 * AbortController timeout. This prevents the indexer from silently
 * stalling on hung database connections — a real problem we hit
 * in production.
 */

import pkg from 'pg';
const { Pool } = pkg;

let pool = null;

/**
 * Initialize the connection pool.
 * @param {object} config - pg Pool config (host, user, password, database, port, etc.)
 * @param {number} [queryTimeoutMs=30000] - Timeout for individual queries.
 */
export const initPool = (config, queryTimeoutMs = 30_000) => {
    pool = new Pool({
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
        allowExitOnIdle: false,
        ...config,
    });

    pool.on('error', (err) => {
        console.error('[db] Unexpected pool error:', err.message);
    });

    // Store timeout for use in query()
    pool._queryTimeoutMs = queryTimeoutMs;
    return pool;
};

/**
 * Execute a parameterized query with timeout.
 * @param {string} text - SQL query
 * @param {Array} [params] - Query parameters
 * @returns {Promise<object|null>} Query result or null on error
 */
export const query = async (text, params = []) => {
    if (!pool) throw new Error('Database pool not initialized. Call initPool() first.');

    const timeout = pool._queryTimeoutMs || 30_000;
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeout);

    try {
        return await pool.query({ text, values: params, signal: abortController.signal });
    } catch (e) {
        if (e.name === 'AbortError') {
            console.error(`[db] Query timed out after ${timeout}ms:`, text.substring(0, 80));
        } else {
            console.error('[db] Query error:', e.message);
        }
        return null;
    } finally {
        clearTimeout(timer);
    }
};

/**
 * Check if the database connection is alive.
 * @returns {Promise<boolean>}
 */
export const healthCheck = async () => {
    try {
        return !!(await pool.query('SELECT 1'));
    } catch (e) {
        console.error('[db] Health check failed:', e.message);
        return false;
    }
};

/**
 * Get the raw pool for advanced use (migrations, transactions, etc.)
 * @returns {Pool}
 */
export const getPool = () => pool;
