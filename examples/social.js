/**
 * examples/social.js — Bitcoin Schema social data indexer.
 *
 * Indexes posts, likes, follows, and profiles from BSV using standard
 * Bitcoin Schema protocols (B + MAP + AIP).
 *
 * This is a working example — bring your own JungleBus subscription IDs.
 * Create subscriptions at https://junglebus.gorillapool.io
 *
 * Run `npm run build` first (this imports the compiled output in ../dist).
 *
 * Usage:
 *   DB_HOST=localhost DB_NAME=social node examples/social.js
 *
 * Or with a config file:
 *   CONFIG=subscriptions.yaml node examples/social.js
 */

import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { createEngine, initPool, query, healthCheck } from '../dist/index.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Load subscriptions from YAML config or use example defaults
let subscriptions;
const configPath = process.env.CONFIG;

if (configPath) {
    const raw = parseYaml(readFileSync(configPath, 'utf8'));
    subscriptions = raw.subscriptions;
    console.log(`Loaded ${subscriptions.length} subscriptions from ${configPath}`);
} else {
    // Example: replace these IDs with your own from junglebus.gorillapool.io
    subscriptions = [
        { type: 'post',    id: process.env.SUB_POST    || '' },
        { type: 'like',    id: process.env.SUB_LIKE    || '' },
        { type: 'profile', id: process.env.SUB_PROFILE || '' },
    ];
    console.log('No CONFIG file — using subscription IDs from environment (SUB_POST, SUB_LIKE, SUB_PROFILE)');
}

// Filter out empty subscriptions
subscriptions = subscriptions.filter(s => s.id);
if (subscriptions.length === 0) {
    console.error('No subscriptions configured. Set CONFIG=file.yaml or SUB_POST=<id> etc.');
    process.exit(1);
}

const START_HEIGHT = parseInt(process.env.START_HEIGHT || '800000', 10);

// ---------------------------------------------------------------------------
// Database schema — simple and generic
// ---------------------------------------------------------------------------

const initSchema = async () => {
    const pool = initPool({
        host: process.env.DB_HOST || '127.0.0.1',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'postgres',
        database: process.env.DB_NAME || 'indexer',
        port: parseInt(process.env.DB_PORT || '5432', 10),
    });

    const client = await pool.connect();
    try {
        // Generic transaction table — stores everything, you query what you need
        await client.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                txid TEXT PRIMARY KEY,
                block_height INTEGER,
                block_time TIMESTAMP,
                type TEXT,
                app TEXT,
                signer TEXT,
                content TEXT,
                media_type TEXT,
                map_data JSONB,
                tags TEXT[]
            );
        `);

        await client.query(`CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions (type);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_tx_signer ON transactions (signer);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_tx_height ON transactions (block_height);`);

        console.log('Database schema ready');
    } finally {
        client.release();
    }
};

// ---------------------------------------------------------------------------
// Transaction handler — this is where you define your indexing logic
// ---------------------------------------------------------------------------

const handleTransaction = async (tx, sub) => {
    // Skip unsigned transactions
    if (tx.signer === 'unknown') return;

    const mapType = (tx.map.type || sub.type || 'unknown').toLowerCase();

    // Store the raw parsed data — let queries handle the filtering.
    // tx.signer is the *claimed* (unverified) AIP address — see the README note.
    const sql = `
        INSERT INTO transactions (txid, block_height, block_time, type, app, signer, content, media_type, map_data, tags)
        VALUES ($1, $2, to_timestamp($3), $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (txid) DO UPDATE SET block_height = EXCLUDED.block_height;
    `;

    await query(sql, [
        tx.txid,
        tx.blockHeight,
        tx.blockTime,
        mapType,
        tx.map.app || 'unknown',
        tx.signer,
        tx.b.content || tx.map.content || tx.map.body || '',
        tx.b.mediaType || 'text/plain',
        JSON.stringify(tx.map),
        tx.map.tags?.length ? tx.map.tags : null,
    ]);
};

// ---------------------------------------------------------------------------
// Status handler — log sync progress
// ---------------------------------------------------------------------------

const handleStatus = (status, sub) => {
    const code = status.statusCode || status.status_code;
    if (code === 200 && status.block && status.block % 1000 === 0) {
        console.log(`[${sub.type}] Block ${status.block} synced (${status.transactions || 0} txs)`);
    } else if (code === 300) {
        console.warn(`[${sub.type}] Chain reorg at block ${status.block}`);
    }
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const getStartHeight = async () => {
    const res = await query('SELECT MAX(block_height) as h FROM transactions');
    return res?.rows[0]?.h || START_HEIGHT;
};

(async () => {
    console.log('junglebus-indexer starting...');

    await initSchema();
    const startHeight = await getStartHeight();
    console.log(`Resuming from block ${startHeight}`);

    const engine = createEngine({
        server: process.env.JUNGLEBUS_SERVER || 'junglebus.gorillapool.io',
        onTransaction: handleTransaction,
        onStatus: handleStatus,
        healthCheck,
    });

    await engine.start(subscriptions, startHeight);
    console.log(`Indexing ${subscriptions.length} streams...`);
})();

// Keep alive
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
