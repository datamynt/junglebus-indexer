/**
 * junglebus-indexer — Generic BSV transaction indexer.
 *
 * Re-exports the core modules so you can use this as a library:
 *
 *   import { createEngine, parseScript, extractProtocols } from 'junglebus-indexer';
 *   import { initPool, query } from 'junglebus-indexer';
 *
 * Or run the included example:
 *   node examples/social.js
 */

export { createEngine } from "./engine.js";
export type {
  Engine,
  EngineOptions,
  Subscription,
  ParsedTransaction,
  JungleBusRawTx,
  JungleBusStatus,
} from "./engine.js";

export { parseScript, extractProtocols, PROTOCOLS } from "./parser.js";
export type {
  Chunk,
  BData,
  MapData,
  ExtractedProtocols,
} from "./parser.js";

export { initPool, query, healthCheck, getPool } from "./db.js";
