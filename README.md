# junglebus-indexer

[![CI](https://github.com/datamynt/junglebus-indexer/actions/workflows/ci.yml/badge.svg)](https://github.com/datamynt/junglebus-indexer/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Open%20BSV-blue.svg)](LICENSE)

Generic BSV transaction indexer powered by [JungleBus](https://junglebus.gorillapool.io) from [GorillaPool](https://gorillapool.io).

Subscribe to any on-chain data pattern, parse [Bitcoin Schema](https://bitcoinschema.org) protocols (B, MAP, AIP), and store it wherever you want. Comes with a production-tested engine featuring automatic reconnection, watchdog stale-stream detection, and query timeouts.

Written in **TypeScript** with full type definitions. It parses the AIP block and extracts the **claimed** signing address, but does not cryptographically verify the signature (see [A note on AIP verification](#a-note-on-aip-verification) for the rationale).

## Why

JungleBus lets you subscribe to filtered transaction streams across the entire BSV blockchain — from genesis to mempool. This library wraps that into a simple `onTransaction` callback pattern with the resilience features you need for production.

Built on lessons learned running indexers for [peck.to](https://peck.to). Special thanks to GorillaPool for making JungleBus available — it kickstarted the whole project.

## Subscriptions — filtering through GorillaPool's node

This is the whole point of JungleBus: instead of running a full node and syncing
the entire chain yourself, you subscribe to a **server-side filter** on
GorillaPool's pre-indexed node and receive only the transactions you care about —
streamed from any start block all the way to mempool.

**A subscription is a filter you create once**, on the
[JungleBus dashboard](https://junglebus.gorillapool.io) (or via the JungleBus
API). You tell it what to match — typically the **addresses** and/or **Bitcom
protocol prefixes** that appear in the transactions you want:

- Index *all* Bitcoin Schema metadata → filter on the **MAP** protocol address
  `1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5`.
- Index on-chain content → filter on the **B** protocol address
  `19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut`.
- Index a single app or wallet → filter on its address(es).

(See the [JungleBus docs](https://junglebus.gorillapool.io) for the exact filter
format — this library *consumes* a subscription, it doesn't create one.)

Creating the subscription gives you an **ID**. In this library each subscription
is just a `{ type, id }` pair — drop them in `subscriptions.yaml` (or pass them as
`SUB_*` env vars):

```yaml
subscriptions:
  - type: post      # your routing label — passed to your handler as sub.type
    id: "5f1d…"     # the JungleBus subscription ID (defines the on-chain filter)
  - type: profile
    id: "a93c…"
```

- **`id`** is the JungleBus subscription ID — it defines the actual on-chain filter.
- **`type`** is purely *your* label for routing: the engine hands it to your
  handler as `sub.type`, so you can branch on which stream a transaction came from.

Each entry becomes an **independent stream** with its own auto-reconnect and
watchdog. The engine resumes every stream from the highest block already in your
database (or `START_HEIGHT` on first run), so you backfill once and then stay live.

## Quick start

```bash
git clone https://github.com/datamynt/junglebus-indexer.git
cd junglebus-indexer
npm install
```

**1. Create a subscription** at [junglebus.gorillapool.io](https://junglebus.gorillapool.io). You'll get a subscription ID for your filter — see [Subscriptions](#subscriptions--filtering-through-gorillapools-node) for what to filter on and why this is the whole point.

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
│  engine.ts          │  Manages connections, watchdog, reconnection
│  ├── parser.ts      │  Decodes OP_RETURN → B + MAP + AIP protocols
│  └── db.ts          │  PostgreSQL pool with timeout-guarded queries
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
        // tx.signer is the *claimed* (unverified) address from the AIP block.
        console.log(`${tx.map.type} from ${tx.signer}: ${tx.b.content}`);
        // Save, filter, forward — your logic here
    },
    healthCheck,
});

// Start indexing
await engine.start([
    { type: 'post', id: 'your-junglebus-subscription-id' },
], 800000);
```

You can also parse a locking script directly:

```typescript
import { parseScript, extractProtocols } from 'junglebus-indexer';

const chunks = parseScript(lockingScriptHex);
const { signer, map, b } = extractProtocols(chunks);
// `signer` is the claimed (unverified) AIP address — see the note below.
```

Exported types include `ParsedTransaction`, `ExtractedProtocols`, `Chunk`,
`BData`, `MapData`, `EngineOptions`, `Engine`, and `Subscription` — so consumers
get full autocomplete.

## Parsed transaction format

Your `onTransaction` callback receives:

```typescript
{
    txid: "abc123...",           // Transaction ID
    blockHeight: 850000,         // Block height (0 for mempool)
    blockTime: 1710000000,       // Unix timestamp
    signer: "1A1zP1...",         // CLAIMED (unverified) address from the AIP block
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
| `signer` | `string` | **Claimed** (unverified) signing address from the AIP block, or `"unknown"`. The address as stated on-chain — not cryptographically verified. Treat as a hint, not proof |
| `map` | `object` | All MAP key/value pairs plus a `tags` array |
| `b` | `object` | B-protocol `{ content, mediaType, filename }` |
| `outputs` | `array` | Raw BSV SDK output objects |

> **Security note:** `signer` is only what the transaction *claims*. This
> library does not verify it cryptographically — see the note below.

## A note on AIP verification

This library parses the AIP block and extracts the **claimed** signing address,
but does not cryptographically verify the signature. This is a deliberate choice:
the large majority of historical on-chain AIP data is absent, malformed, or uses
non-standard signing variants, so signature verification yields little reliable
signal in practice. Verified authorship belongs in an identity layer
(e.g. BRC-100 / overlay-based identity), not in a generic transaction indexer.

Treat the `signer` field as an unverified hint — the address as claimed on-chain —
not as cryptographic proof of authorship.

## Protocols parsed

| Protocol | Address | What it carries |
|----------|---------|----------------|
| **B** | `19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut` | Content data (text, images, files) |
| **MAP** | `1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5` | Structured metadata (type, app, tags, etc.) |
| **AIP** | `15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva` | Author identity — the **claimed** (unverified) signing address is extracted. See [the note on AIP verification](#a-note-on-aip-verification) |

The AIP block's claimed signing address is extracted into the `signer` field;
the signature is not cryptographically verified (see [A note on AIP verification](#a-note-on-aip-verification)).
See [bitcoinschema.org](https://bitcoinschema.org) for protocol specifications.

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
