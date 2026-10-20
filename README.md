# ayebot-mcp

Public, read-only MCP server and JSON API for Ayebot's aggregate buyer index.
Docs for users: https://ayebot.com/developers

## What it exposes (and never exposes)
Only whitelisted aggregate counts from the public file https://ayebot.com/data/buyer-index.json
(`src/data.ts` CELL_FIELDS / HEADLINE_FIELDS; any other field is dropped, any non-integer count fails closed).
Never: buyer names, contacts, records, ticket sizes or size bands, HQ-derived figures, valuation benchmarks,
or anything from a live sale process (RULE ZERO; Yichen 2026-10-09 "no proprietary").

## Endpoints
| Path | What |
|---|---|
| `POST /mcp` | MCP, Streamable HTTP, stateless, JSON responses |
| `GET /mcp/server-card` | MCP Server Card (SEP-2127), also at `/.well-known/mcp.json` and `/.well-known/mcp/server-card.json` |
| `GET /.well-known/ai-catalog.json` | AI Catalog pointing at the card |
| `GET /api/v1/buyer-index` | filtered JSON, CORS `*` |
| `GET /api/v1/openapi.json` (`/openapi.json`) | OpenAPI 3.1 |
| `GET /health` | liveness + cache state |

Tools: `count_buyers(sector?, market?)`, `list_sectors_and_markets()`, `buyer_appetite_summary(sector)`, `how_to_sell_next_steps()`.
Every result carries `source` ("Ayebot (ayebot.com) buyer index, as at YYYY-MM-DD"), `url` and `note`.

Upstream cached 1 hour (stale copy served if upstream fails). Rate limit 60/min per IP, in memory per instance (2 instances max, so up to 120/min worst case); each JSON-RPC batch message counts; batches capped at 10.
No request bodies are logged. No secrets, no auth.

## Run / test
```
npm ci && npm run build && PORT=8787 PUBLIC_BASE=http://localhost:8787 npm start
node scripts/mcp-client-test.mjs http://localhost:8787/mcp     # initialize, tools/list, tools/call each tool
```

## Deploy (Cloud Run, project gen-lang-client-0056938973, us-west1)
```
python3 "$CONFIDENTIAL_GUARD" src scripts README.md   # local confidentiality guard (path in your shell env), must exit 0
SHA=$(git rev-parse --short HEAD)
gcloud builds submit --project gen-lang-client-0056938973 --tag gcr.io/gen-lang-client-0056938973/ayebot-mcp:$SHA .
gcloud run deploy ayebot-mcp --project gen-lang-client-0056938973 --region us-west1 \
  --image gcr.io/gen-lang-client-0056938973/ayebot-mcp:$SHA --allow-unauthenticated \
  --max-instances 2 --min-instances 0 --port 8080 --set-env-vars PUBLIC_BASE=https://ayebot.com --no-traffic --tag v<N>
node scripts/mcp-client-test.mjs https://v<N>---ayebot-mcp-<hash>-uw.a.run.app/mcp
gcloud run services update-traffic ayebot-mcp --project gen-lang-client-0056938973 --region us-west1 --to-tags v<N>=100
```
Public path: ayebot.com nginx proxies `/mcp`, `/api/v1/` and the discovery files here (ayebot-site `nginx.conf`).
Rollback: `gcloud run services update-traffic ayebot-mcp ... --to-revisions <previous-revision>=100`.

Registry: `server.json` (official MCP Registry, `io.github.gweeyichen/ayebot`).
