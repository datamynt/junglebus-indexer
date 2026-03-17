/**
 * engine.js — JungleBus subscription engine with watchdog.
 *
 * Manages WebSocket connections to JungleBus, handles reconnection
 * on errors, and runs a watchdog that detects silently stalled streams.
 *
 * Usage:
 *   const engine = createEngine({ server, onTransaction, onStatus });
 *   await engine.start(subscriptions, startHeight);
 *
 * The onTransaction callback receives parsed protocol data for each tx.
 * You decide what to do with it — save to DB, forward to a queue, etc.
 */

import { JungleBusClient } from "@gorillapool/js-junglebus";
import { Transaction } from "@bsv/sdk";
import { parseScript, extractProtocols } from './parser.js';

/**
 * @typedef {object} EngineOptions
 * @property {string} server - JungleBus server hostname
 * @property {function} onTransaction - Called with (parsedTx, subscription) for each tx
 * @property {function} [onStatus] - Called with (status, subscription) for control messages
 * @property {number} [staleThresholdMs=300000] - Max silence before force-reconnect (default 5min)
 * @property {number} [watchdogIntervalMs=60000] - How often watchdog checks (default 60s)
 * @property {number} [reconnectDelayMs=15000] - Delay before reconnecting after error
 * @property {number} [staggerDelayMs=500] - Delay between starting each subscription
 * @property {function} [healthCheck] - Optional health check called by watchdog
 */

/**
 * Create a JungleBus indexer engine.
 * @param {EngineOptions} options
 */
export const createEngine = (options) => {
    const {
        server,
        onTransaction,
        onStatus,
        staleThresholdMs = 5 * 60 * 1000,
        watchdogIntervalMs = 60 * 1000,
        reconnectDelayMs = 15_000,
        staggerDelayMs = 500,
        healthCheck,
    } = options;

    /** @type {Map<string, { lastActivity: number, restartFn: (() => void) | null }>} */
    const health = new Map();

    /**
     * Process a raw JungleBus transaction.
     * Decodes hex, parses OP_RETURN outputs, extracts B/MAP/AIP.
     */
    const processTx = async (rawTx, sub) => {
        try {
            const t = Transaction.fromHex(rawTx.transaction);

            let parsed = null;
            for (const output of t.outputs) {
                const hex = output.lockingScript.toHex();
                if (hex.startsWith('006a')) {
                    const chunks = parseScript(hex);
                    parsed = extractProtocols(chunks);
                    if (parsed.map.type) break;
                }
            }

            if (!parsed || !parsed.map.type) return;

            const effectiveTime = (rawTx.block_time && rawTx.block_time > 0)
                ? rawTx.block_time
                : Math.floor(Date.now() / 1000);

            await onTransaction({
                txid: rawTx.id,
                blockHeight: rawTx.block_height || 0,
                blockTime: effectiveTime,
                map: parsed.map,
                b: parsed.b,
                signer: parsed.signer,
                outputs: t.outputs,
            }, sub);
        } catch (e) {
            console.error(`[${sub.type}] Error processing tx ${rawTx.id}:`, e.message);
        }
    };

    /**
     * Manage a single subscription stream with auto-reconnect.
     */
    const manageSubscription = async (sub, delay, startHeight) => {
        if (!sub.id) return;
        await new Promise(r => setTimeout(r, delay));

        health.set(sub.type, { lastActivity: Date.now(), restartFn: null });

        const run = async () => {
            try {
                const client = new JungleBusClient(server, { useSSL: true, protocol: 'json' });
                console.log(`[${sub.type}] Subscribing from block ${startHeight}`);

                const entry = health.get(sub.type);
                if (entry) {
                    entry.lastActivity = Date.now();
                    entry.restartFn = () => setTimeout(() => run(), 1000);
                }

                await client.Subscribe(
                    sub.id,
                    startHeight,
                    async (tx) => {
                        health.get(sub.type).lastActivity = Date.now();
                        await processTx(tx, sub);
                    },
                    (status) => {
                        health.get(sub.type).lastActivity = Date.now();
                        const code = status.statusCode || status.status_code;

                        if (onStatus) onStatus(status, sub);

                        if (code === 999 || code === 101) {
                            throw new Error(`JungleBus error (${code}): ${status.message}`);
                        }
                    },
                    (err) => { throw err; },
                    async (tx) => {
                        health.get(sub.type).lastActivity = Date.now();
                        await processTx(tx, sub);
                    }
                );
            } catch (err) {
                console.error(`[${sub.type}] Stream error: ${err.message}. Reconnecting in ${reconnectDelayMs / 1000}s...`);
                setTimeout(() => run(), reconnectDelayMs);
            }
        };

        run();
    };

    /**
     * Start the watchdog timer.
     */
    const startWatchdog = () => {
        console.log(`[watchdog] Active — interval ${watchdogIntervalMs / 1000}s, stale threshold ${staleThresholdMs / 1000}s`);

        setInterval(async () => {
            const now = Date.now();
            let stalled = 0;

            for (const [type, entry] of health.entries()) {
                const silent = now - entry.lastActivity;
                if (silent > staleThresholdMs) {
                    stalled++;
                    console.warn(`[watchdog] ${type} silent for ${Math.round(silent / 1000)}s — forcing reconnect`);
                    if (entry.restartFn) {
                        entry.restartFn();
                        entry.lastActivity = now;
                    }
                }
            }

            if (healthCheck) {
                const ok = await healthCheck();
                if (!ok) console.error('[watchdog] Health check failed!');
            }

            if (stalled === 0) {
                console.log(`[watchdog] All ${health.size} streams healthy`);
            }
        }, watchdogIntervalMs);
    };

    return {
        /**
         * Start indexing.
         * @param {Array<{type: string, id: string}>} subscriptions
         * @param {number} startHeight - Block height to start from
         */
        start: async (subscriptions, startHeight) => {
            for (let i = 0; i < subscriptions.length; i++) {
                manageSubscription(subscriptions[i], i * staggerDelayMs, startHeight);
            }
            // Let streams warm up before watchdog kicks in
            setTimeout(() => startWatchdog(), 30_000);
        },

        /** Get health status of all streams */
        getHealth: () => Object.fromEntries(health),
    };
};
