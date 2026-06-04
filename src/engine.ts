/**
 * engine.ts — JungleBus subscription engine with watchdog.
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
import type { TransactionOutput } from "@bsv/sdk";
import { parseScript, extractProtocols } from "./parser.js";
import type { BData, MapData } from "./parser.js";

/** A single JungleBus subscription to manage. */
export interface Subscription {
  /** Logical stream name used in logs and routing (e.g. `"post"`). */
  type: string;
  /** JungleBus subscription ID created at junglebus.gorillapool.io. */
  id: string;
}

/**
 * The parsed transaction object handed to {@link EngineOptions.onTransaction}.
 * This is the primary consumer-facing shape and what the README documents.
 */
export interface ParsedTransaction {
  /** Transaction ID. */
  txid: string;
  /** Block height (0 for mempool). */
  blockHeight: number;
  /** Effective unix timestamp (block time, or now for mempool). */
  blockTime: number;
  /** Claimed (unverified) AIP signing address, or `"unknown"`. */
  signer: string;
  /** All MAP key/value pairs plus the `tags` array. */
  map: MapData;
  /** B-protocol content. */
  b: BData;
  /** Raw BSV SDK output objects for the transaction. */
  outputs: TransactionOutput[];
}

/** Minimal shape of a JungleBus raw transaction message. */
export interface JungleBusRawTx {
  id: string;
  transaction: string;
  block_height?: number;
  block_time?: number;
}

/** Minimal shape of a JungleBus control/status message. */
export interface JungleBusStatus {
  statusCode?: number;
  status_code?: number;
  message?: string;
  block?: number;
  transactions?: number;
}

/** Options for {@link createEngine}. */
export interface EngineOptions {
  /** JungleBus server hostname. */
  server: string;
  /** Called with (parsedTx, subscription) for each matching tx. */
  onTransaction: (
    tx: ParsedTransaction,
    sub: Subscription,
  ) => void | Promise<void>;
  /** Called with (status, subscription) for control messages. */
  onStatus?: (status: JungleBusStatus, sub: Subscription) => void;
  /** Max silence before force-reconnect (default 5min). */
  staleThresholdMs?: number;
  /** How often the watchdog checks (default 60s). */
  watchdogIntervalMs?: number;
  /** Delay before reconnecting after an error (default 15s). */
  reconnectDelayMs?: number;
  /** Delay between starting each subscription (default 500ms). */
  staggerDelayMs?: number;
  /** Optional health check invoked by the watchdog. */
  healthCheck?: () => boolean | Promise<boolean>;
}

/** Per-stream health bookkeeping. */
interface HealthEntry {
  lastActivity: number;
  restartFn: (() => void) | null;
}

/** Public engine handle returned by {@link createEngine}. */
export interface Engine {
  /** Start indexing the given subscriptions from `startHeight`. */
  start: (subscriptions: Subscription[], startHeight: number) => Promise<void>;
  /** Get a snapshot of per-stream health. */
  getHealth: () => Record<string, HealthEntry>;
}

/**
 * Create a JungleBus indexer engine.
 */
export const createEngine = (options: EngineOptions): Engine => {
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

  const health = new Map<string, HealthEntry>();

  /**
   * Process a raw JungleBus transaction.
   * Decodes hex, parses OP_RETURN outputs, extracts B/MAP/AIP.
   */
  const processTx = async (
    rawTx: JungleBusRawTx,
    sub: Subscription,
  ): Promise<void> => {
    try {
      const t = Transaction.fromHex(rawTx.transaction);

      let parsed: ReturnType<typeof extractProtocols> | null = null;
      for (const output of t.outputs) {
        const hex = output.lockingScript.toHex();
        if (hex.startsWith("006a")) {
          const chunks = parseScript(hex);
          parsed = extractProtocols(chunks);
          if (parsed.map.type) break;
        }
      }

      if (!parsed || !parsed.map.type) return;

      const effectiveTime =
        rawTx.block_time && rawTx.block_time > 0
          ? rawTx.block_time
          : Math.floor(Date.now() / 1000);

      await onTransaction(
        {
          txid: rawTx.id,
          blockHeight: rawTx.block_height || 0,
          blockTime: effectiveTime,
          map: parsed.map,
          b: parsed.b,
          signer: parsed.signer,
          outputs: t.outputs,
        },
        sub,
      );
    } catch (e) {
      console.error(
        `[${sub.type}] Error processing tx ${rawTx.id}:`,
        (e as Error).message,
      );
    }
  };

  /**
   * Manage a single subscription stream with auto-reconnect.
   */
  const manageSubscription = async (
    sub: Subscription,
    delay: number,
    startHeight: number,
  ): Promise<void> => {
    if (!sub.id) return;
    await new Promise((r) => setTimeout(r, delay));

    health.set(sub.type, { lastActivity: Date.now(), restartFn: null });

    const run = async (): Promise<void> => {
      try {
        const client = new JungleBusClient(server, {
          useSSL: true,
          protocol: "json",
        });
        console.log(`[${sub.type}] Subscribing from block ${startHeight}`);

        const entry = health.get(sub.type);
        if (entry) {
          entry.lastActivity = Date.now();
          entry.restartFn = () => setTimeout(() => run(), 1000);
        }

        await client.Subscribe(
          sub.id,
          startHeight,
          async (tx: JungleBusRawTx) => {
            health.get(sub.type)!.lastActivity = Date.now();
            await processTx(tx, sub);
          },
          (status: JungleBusStatus) => {
            health.get(sub.type)!.lastActivity = Date.now();
            const code = status.statusCode || status.status_code;

            if (onStatus) onStatus(status, sub);

            if (code === 999 || code === 101) {
              throw new Error(`JungleBus error (${code}): ${status.message}`);
            }
          },
          (err: { error?: { message?: string } } | unknown) => {
            // Surface the stream error so the outer reconnect logic engages,
            // mirroring the original `throw err` behavior.
            const ctx = err as { error?: { message?: string }; message?: string };
            throw new Error(ctx?.error?.message ?? ctx?.message ?? "JungleBus subscription error");
          },
          async (tx: JungleBusRawTx) => {
            health.get(sub.type)!.lastActivity = Date.now();
            await processTx(tx, sub);
          },
        );
      } catch (err) {
        console.error(
          `[${sub.type}] Stream error: ${(err as Error).message}. Reconnecting in ${reconnectDelayMs / 1000}s...`,
        );
        setTimeout(() => run(), reconnectDelayMs);
      }
    };

    run();
  };

  /**
   * Start the watchdog timer.
   */
  const startWatchdog = (): void => {
    console.log(
      `[watchdog] Active — interval ${watchdogIntervalMs / 1000}s, stale threshold ${staleThresholdMs / 1000}s`,
    );

    setInterval(async () => {
      const now = Date.now();
      let stalled = 0;

      for (const [type, entry] of health.entries()) {
        const silent = now - entry.lastActivity;
        if (silent > staleThresholdMs) {
          stalled++;
          console.warn(
            `[watchdog] ${type} silent for ${Math.round(silent / 1000)}s — forcing reconnect`,
          );
          if (entry.restartFn) {
            entry.restartFn();
            entry.lastActivity = now;
          }
        }
      }

      if (healthCheck) {
        const ok = await healthCheck();
        if (!ok) console.error("[watchdog] Health check failed!");
      }

      if (stalled === 0) {
        console.log(`[watchdog] All ${health.size} streams healthy`);
      }
    }, watchdogIntervalMs);
  };

  return {
    start: async (
      subscriptions: Subscription[],
      startHeight: number,
    ): Promise<void> => {
      for (let i = 0; i < subscriptions.length; i++) {
        manageSubscription(subscriptions[i], i * staggerDelayMs, startHeight);
      }
      // Let streams warm up before watchdog kicks in
      setTimeout(() => startWatchdog(), 30_000);
    },

    getHealth: () => Object.fromEntries(health),
  };
};
