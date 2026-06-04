# junglebus-indexer

[![CI](https://github.com/datamynt/junglebus-indexer/actions/workflows/ci.yml/badge.svg)](https://github.com/datamynt/junglebus-indexer/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Open%20BSV-blue.svg)](LICENSE)

Generic BSV transaction indexer powered by [JungleBus](https://junglebus.gorillapool.io) from [GorillaPool](https://gorillapool.io).

Subscribe to any on-chain data pattern, parse [Bitcoin Schema](https://bitcoinschema.org) protocols (B, MAP, AIP), and store it wherever you want. Comes with a production-tested engine featuring automatic reconnection, watchdog stale-stream detection, and query timeouts.

Written in **TypeScript** with full type definitions, and performs **real AIP ECDSA signature verification** — it doesn't just trust the claimed signer, it recovers the signing key from the signature and checks it.

## Why

JungleBus lets you subscribe to filtered transaction streams across the entire BSV blockchain — from genesis to mempool. This library wraps that into a simple `onTransaction` callback pattern with the resilience features you need for production.

Built on lessons learned running indexers for [peck.to](https://peck.to). Special thanks to GorillaPool for making JungleBus available — it kickstarted the whole project.

## Quick start

```bash
git clone https://github.com/datamynt/junglebus-indexer.git
cd junglebus-indexer
npm install
```

**1. Create a subscription** at [junglebus.gorillapool.io](https://junglebus.gorillapool.io). You'll get a subscription ID for your filter.

**2. Build and run the included example:**

```bash
npm run build
DB_NAME=indexer SUB_POST=<your-subscription-id> node examples/social.js
```

Or with a config file:

```bash
cp subscriptions.example.yaml subscriptions.yaml
# Edit subscriptions.yaml with your subscription IDs
CONFIG=subscriptions.yaml DB_NAME=indexer node examples/social.js
```

## How it works

```
JungleBus (GorillaPool)
    │
    │  WebSocket streams filtered by your subscriptions
    │
    ▼
┌─────────────────────┐
│  engine.js          │  Manages connections, watchdog, reconnection
│  ├── parser.js      │  Decodes OP_RETURN → B + MAP + AIP protocols
│  └── db.js          │  PostgreSQL pool with timeout-guarded queries
└────────┬────────────┘
         │
         │  onTransaction({ txid, map, b, signer, ... })
         │
         ▼
┌─────────────────────┐
│  Your handler       │  You decide what to do with parsed data
│  (examples/social.js│  Save to DB, forward to queue, filter, etc.
└─────────────────────┘
```

## Use as a library

Written in TypeScript — import everything (and its types) from the package root:

```typescript
import {
    createEngine,
    initPool,
    query,
    healthCheck,
    type ParsedTransaction,
    type Subscription,
} from 'junglebus-indexer';

// Set up database
initPool({ host: 'localhost', database: 'myapp' });

// Create engine with your handler
const engine = createEngine({
    server: 'junglebus.gorillapool.io',
    onTransaction: async (tx: ParsedTransaction, sub: Subscription) => {
        // tx.signer is the *claimed* address; tx.signerVerified tells you
        // whether the AIP ECDSA signature actually checks out.
        const trust = tx.signerVerified ? 'verified' : 'unverified';
        console.log(`${tx.map.type} from ${tx.signer} (${trust}): ${tx.b.content}`);
        // Save, filter, forward — your logic here
    },
    healthCheck,
});

// Start indexing
await engine.start([
    { type: 'post', id: 'your-junglebus-subscription-id' },
], 800000);
```

You can also call the AIP verifier directly:

```typescript
import { parseScript, extractProtocols, verifyAip } from 'junglebus-indexer';

const chunks = parseScript(lockingScriptHex);
const { signer, signerVerified, signerAddress } = extractProtocols(chunks);
```

Exported types include `ParsedTransaction`, `ExtractedProtocols`, `Chunk`,
`BData`, `MapData`, `EngineOptions`, `Engine`, `Subscription`, and
`AipVerifyResult` — so consumers get full autocomplete.

## Parsed transaction format

Your `onTransaction` callback receives:

```typescript
{
    txid: "abc123...",           // Transaction ID
    blockHeight: 850000,         // Block height (0 for mempool)
    blockTime: 1710000000,       // Unix timestamp
    signer: "1A1zP1...",         // CLAIMED Bitcoin address from the AIP block
    signerVerified: true,        // Did the AIP ECDSA signature actually verify?
    signerAddress: "1A1zP1...",  // Address recovered from the signature (null if unverified)
    map: {                       // All MAP key-value pairs
        type: "post",
        app: "myapp",
        context: "...",
        tags: ["bsv", "dev"],
        // ... any MAP keys the transaction contains
    },
    b: {                         // B protocol content
        content: "Hello world",
        mediaType: "text/plain",
        filename: null,
    },
    outputs: [...],              // Raw BSV SDK output objects
}
```

| Field | Type | Description |
|-------|------|-------------|
| `txid` | `string` | Transaction ID |
| `blockHeight` | `number` | Block height (0 for mempool) |
| `blockTime` | `number` | Unix timestamp |
| `signer` | `string` | **Claimed** signing address from the AIP block, or `"unknown"`. Kept for backward compatibility — do not trust it on its own |
| `signerVerified` | `boolean` | `true` only if an AIP `BITCOIN_ECDSA` signature was present **and** the recovered key matched the claimed signer. This is the real cryptographic check |
| `signerAddress` | `string \| null` | Address derived from the recovered signature key, or `null` when no valid signature verified |
| `map` | `object` | All MAP key/value pairs plus a `tags` array |
| `b` | `object` | B-protocol `{ content, mediaType, filename }` |
| `outputs` | `array` | Raw BSV SDK output objects |

> **Security note:** `signer` is only what the transaction *claims*. Gate trust
> on `signerVerified === true` (or compare against `signerAddress`). The
> verifier rebuilds the canonical AIP preimage — the concatenated content bytes
> of every push up to and including the signing-address field — computes the
> Bitcoin-Signed-Message digest, recovers the public key from the 65-byte
> compact signature, and checks its P2PKH address equals the claimed signer.
> Only generic AIP `BITCOIN_ECDSA` is supported.

## Protocols parsed

| Protocol | Address | What it carries |
|----------|---------|----------------|
| **B** | `19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut` | Content data (text, images, files) |
| **MAP** | `1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5` | Structured metadata (type, app, tags, etc.) |
| **AIP** | `15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva` | Author identity — ECDSA signature, **actually verified** (recovers key → derives address → compares to claim) |

AIP verification recovers the signing public key from the embedded 65-byte
compact signature over the Bitcoin-Signed-Message digest of the canonical
preimage, then checks the derived P2PKH address (or compressed pubkey hex, for
that Bitcom variant) matches the claimed signer. Only generic `BITCOIN_ECDSA`
AIP is supported. See [bitcoinschema.org](https://bitcoinschema.org) for protocol specifications.

## Resilience features

All battle-tested in production:

- **Watchdog** — Detects silently stalled WebSocket streams and force-reconnects (default: 5 min threshold)
- **Auto-reconnect** — Exponential backoff on stream errors
- **Query timeouts** — AbortController on all DB queries prevents silent hangs
- **Pool resilience** — Connection/idle timeouts, error handlers on the pg pool
- **Staggered startup** — Subscriptions connect with 500ms delays to avoid API throttling
- **Process handlers** — Catches unhandled rejections and uncaught exceptions

## Configuration

All via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_HOST` | `127.0.0.1` | PostgreSQL host |
| `DB_NAME` | `indexer` | Database name |
| `DB_USER` | `postgres` | Database user |
| `DB_PASSWORD` | `postgres` | Database password |
| `DB_PORT` | `5432` | Database port |
| `JUNGLEBUS_SERVER` | `junglebus.gorillapool.io` | JungleBus server |
| `START_HEIGHT` | `800000` | Starting block if DB is empty |
| `CONFIG` | — | Path to YAML subscription config |
| `SUB_*` | — | Individual subscription IDs (e.g. `SUB_POST=abc...`) |

## Credits

- [GorillaPool](https://gorillapool.io) for [JungleBus](https://junglebus.gorillapool.io) — the backbone of BSV indexing
- [Bitcoin Schema](https://bitcoinschema.org) for the B, MAP, and AIP protocol standards
- [BSV SDK](https://github.com/bsv-blockchain/ts-sdk) for transaction parsing

## License

[Open BSV License](LICENSE)
