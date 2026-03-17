# junglebus-indexer

Generic BSV transaction indexer powered by [JungleBus](https://junglebus.gorillapool.io) from [GorillaPool](https://gorillapool.io).

Subscribe to any on-chain data pattern, parse [Bitcoin Schema](https://bitcoinschema.org) protocols (B, MAP, AIP), and store it wherever you want. Comes with a production-tested engine featuring automatic reconnection, watchdog stale-stream detection, and query timeouts.

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

**2. Run the included example:**

```bash
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

```javascript
import { createEngine, parseScript, extractProtocols } from './src/index.js';
import { initPool, query, healthCheck } from './src/db.js';

// Set up database
initPool({ host: 'localhost', database: 'myapp' });

// Create engine with your handler
const engine = createEngine({
    server: 'junglebus.gorillapool.io',
    onTransaction: async (tx, sub) => {
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

## Parsed transaction format

Your `onTransaction` callback receives:

```javascript
{
    txid: "abc123...",           // Transaction ID
    blockHeight: 850000,        // Block height (0 for mempool)
    blockTime: 1710000000,      // Unix timestamp
    signer: "1A1zP1...",        // Bitcoin address from AIP signature
    map: {                      // All MAP key-value pairs
        type: "post",
        app: "myapp",
        context: "...",
        tags: ["bsv", "dev"],
        // ... any MAP keys the transaction contains
    },
    b: {                        // B protocol content
        content: "Hello world",
        mediaType: "text/plain",
        filename: null,
    },
    outputs: [...],             // Raw BSV SDK output objects
}
```

## Protocols parsed

| Protocol | Address | What it carries |
|----------|---------|----------------|
| **B** | `19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut` | Content data (text, images, files) |
| **MAP** | `1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5` | Structured metadata (type, app, tags, etc.) |
| **AIP** | `15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva` | Author identity (ECDSA signature → address) |

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
