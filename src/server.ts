// Ayebot MCP server + JSON API. Stateless Streamable HTTP (one McpServer per request), read-only, no auth, no secrets.
// Never logs request bodies. Exposes ONLY whitelisted aggregate counts (see data.ts).
import express, { type Request, type Response, type NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer, SERVER_NAME, SERVER_VERSION } from './tools.js';
import { getIndex, cacheInfo, attribution, SITE, CELL_FIELDS, HEADLINE_FIELDS } from './data.js';
import { openapi } from './openapi.js';

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_BASE = (process.env.PUBLIC_BASE || SITE).replace(/\/$/, ''); // where clients reach us (ayebot.com via nginx)
const RATE_PER_MIN = Number(process.env.RATE_PER_MIN || 60);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false); // client IP is derived explicitly below

// ---------- client IP for rate limiting ----------
// Cloud Run appends the connecting client's IP as the LAST X-Forwarded-For entry. When the request comes through the
// ayebot.com nginx proxy, nginx forwards the header it received unchanged and Cloud Run then appends nginx's egress IP,
// so the real client is the second-to-last entry. Leftmost entries are client-supplied and never trusted.
function clientIp(req: Request): string {
  const parts = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const viaEdge = req.headers['x-ayebot-edge'] === 'nginx';
  const idx = parts.length - (viaEdge ? 2 : 1);
  return parts[idx] || req.socket.remoteAddress || 'unknown';
}

// ---------- per-IP rate limit (fixed 60s window, in memory, per instance: with 2 instances the ceiling is up to 2x) ----------
const hits = new Map<string, { n: number; reset: number }>();
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); }, 60_000).unref();
const MAX_BATCH = 10; // JSON-RPC batch cap; every message in a batch counts against the per-IP limit
function rateLimit(req: Request, res: Response, next: NextFunction) {
  const weight = Array.isArray(req.body) ? req.body.length : 1;
  if (weight > MAX_BATCH) return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: `Batch too large: at most ${MAX_BATCH} messages.` }, id: null });
  const ip = clientIp(req);
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || h.reset <= now) { h = { n: 0, reset: now + 60_000 }; hits.set(ip, h); }
  if (hits.size > 50_000) hits.clear(); // memory backstop
  h.n += Math.max(1, weight);
  res.setHeader('RateLimit-Limit', String(RATE_PER_MIN));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, RATE_PER_MIN - h.n)));
  if (h.n > RATE_PER_MIN) {
    res.setHeader('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
    return res.status(429).json({ error: 'Too many requests: limit is ' + RATE_PER_MIN + ' per minute per IP.' });
  }
  next();
}

// ---------- CORS (public, read-only, no credentials) ----------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version, RateLimit-Limit, RateLimit-Remaining, Retry-After');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ---------- discovery ----------
const serverCard = () => ({
  $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
  name: SERVER_NAME,
  version: SERVER_VERSION,
  title: 'Ayebot buyer index',
  description: 'Aggregate counts of acquirers by sector and Southeast Asian market, from Ayebot (ayebot.com). Counts only, no names.',
  websiteUrl: SITE + '/developers',
  icons: [{ src: SITE + '/icon-512.png', mimeType: 'image/png', sizes: ['512x512'] }],
  remotes: [{ type: 'streamable-http', url: PUBLIC_BASE + '/mcp', supportedProtocolVersions: ['2025-11-25', '2025-06-18', '2025-03-26'] }],
});
const sendCard = (_req: Request, res: Response) => {
  res.type('application/mcp-server-card+json').setHeader('Cache-Control', 'public, max-age=3600');
  res.send(JSON.stringify(serverCard(), null, 2));
};
app.get('/mcp/server-card', sendCard);
// Legacy/draft locations still probed by some tools (SEP-1649 drafts). Current convention (SEP-2127, merged 2026-10-06):
// <streamable-http-url>/server-card, advertised from /.well-known/ai-catalog.json.
app.get(['/.well-known/mcp.json', '/.well-known/mcp/server-card.json'], sendCard);
app.get('/.well-known/ai-catalog.json', (_req, res) => {
  res.type('application/ai-catalog+json').setHeader('Cache-Control', 'public, max-age=3600');
  res.send(JSON.stringify({
    specVersion: '1.0',
    entries: [{ identifier: 'urn:air:ayebot.com:mcp:buyer-index', type: 'application/mcp-server-card+json', url: PUBLIC_BASE + '/mcp/server-card' }],
  }, null, 2));
});

// Off unless DEBUG_XFF=1 (used once on a no-traffic tag to confirm the X-Forwarded-For shape). Echoes only the caller's own header.
if (process.env.DEBUG_XFF === '1') app.get('/debug/xff', (req, res) => res.json({ xff: req.headers['x-forwarded-for'] || null, edge: req.headers['x-ayebot-edge'] || null, client: clientIp(req) }));

app.get('/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok', name: SERVER_NAME, version: SERVER_VERSION, data: cacheInfo() });
});

app.get(['/openapi.json', '/api/v1/openapi.json'], (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(openapi(PUBLIC_BASE));
});

// ---------- JSON API ----------
app.get('/api/v1/buyer-index', rateLimit, async (_req, res) => {
  try {
    const d = await getIndex();
    res.setHeader('Cache-Control', 'public, max-age=900');
    res.json({
      ...attribution(d, SITE + '/developers'),
      generated: d.generated, source_synced: d.source_synced,
      fields: { headline: HEADLINE_FIELDS, cells: CELL_FIELDS },
      sectors: d.sectors, markets: d.markets, headline: d.headline, cells: d.cells,
    });
  } catch {
    res.status(503).json({ error: 'Buyer index temporarily unavailable.' });
  }
});

// ---------- MCP (stateless Streamable HTTP) ----------
app.post('/mcp', express.json({ limit: '64kb' }), rateLimit, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('mcp error:', (e as Error)?.message); // message only, never the body
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
});
const notAllowed = (_req: Request, res: Response) =>
  res.status(405).setHeader('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless; use POST.' }, id: null });
app.get('/mcp', notAllowed);
app.delete('/mcp', notAllowed);

app.get('/', (_req, res) => {
  res.json({ name: 'Ayebot MCP server and buyer index API', docs: SITE + '/developers', mcp: PUBLIC_BASE + '/mcp', api: PUBLIC_BASE + '/api/v1/buyer-index', openapi: PUBLIC_BASE + '/api/v1/openapi.json' });
});

// Malformed JSON and other errors: short message, no body echo.
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err?.type === 'entity.too.large' ? 413 : err?.type === 'entity.parse.failed' ? 400 : 500;
  res.status(status).json({ jsonrpc: '2.0', error: { code: status === 500 ? -32603 : -32700, message: status === 500 ? 'Internal server error' : 'Invalid request body' }, id: null });
});
app.use((_req, res) => res.status(404).json({ error: 'Not found', docs: SITE + '/developers' }));

app.listen(PORT, () => {
  console.log(`ayebot-mcp ${SERVER_VERSION} listening on :${PORT}`);
  getIndex().catch((e) => console.error('warm-up fetch failed:', e?.message));
});
