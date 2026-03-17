/**
 * junglebus-indexer — Generic BSV transaction indexer.
 *
 * Re-exports the core modules so you can use this as a library:
 *
 *   import { createEngine } from 'junglebus-indexer/engine';
 *   import { parseScript, extractProtocols } from 'junglebus-indexer/parser';
 *   import { initPool, query } from 'junglebus-indexer/db';
 *
 * Or run the included example:
 *   node examples/social.js
 */

export { createEngine } from './engine.js';
export { parseScript, extractProtocols, PROTOCOLS } from './parser.js';
export { initPool, query, healthCheck, getPool } from './db.js';
