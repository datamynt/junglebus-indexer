# CLAUDE.md — junglebus-indexer

Generic BSV transaction indexer using JungleBus (GorillaPool).
Parses B, MAP, AIP protocols. Pluggable handler pattern.

## Structure

```
src/
  engine.js   — JungleBus connection manager + watchdog
  parser.js   — OP_RETURN → B/MAP/AIP extraction
  db.js       — PostgreSQL pool with timeout wrapper
  index.js    — Library exports
examples/
  social.js   — Bitcoin Schema social data example
```

## Run example

```bash
npm install
DB_NAME=indexer SUB_POST=<id> node examples/social.js
```

## Key patterns

- `createEngine({ server, onTransaction })` — you provide the handler
- `parseScript(hex)` / `extractProtocols(chunks)` — usable standalone
- All MAP keys stored as-is (no filtering) — consumer decides what matters
- Watchdog force-reconnects stalled streams (5min default)
- Query timeout via AbortController (30s default)

## Dependencies

@gorillapool/js-junglebus, @bsv/sdk, pg, yaml

## License

Open BSV License
