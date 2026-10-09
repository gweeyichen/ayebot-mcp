// OpenAPI 3.1 description of the public JSON API. Only whitelisted aggregate fields are described or served.
import { CELL_FIELDS, HEADLINE_FIELDS } from './data.js';

export function openapi(base: string) {
  const count = { type: 'integer', minimum: 0 };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Ayebot buyer index API',
      version: '1.0.0',
      description:
        'Free, read-only, aggregate counts of acquirers on the Ayebot buyer register by sector and Southeast Asian market. ' +
        'Aggregate counts only; no buyer names or records, no contacts, no ticket sizes, no valuation figures, and no figure from any live sale process. ' +
        'Attribution to ayebot.com is requested. Rate limit: about 60 requests per minute per IP (each message in a JSON-RPC batch counts; batches of at most 10). Docs: https://ayebot.com/developers',
      termsOfService: 'https://ayebot.com/developers#terms',
      contact: { name: 'Ayebot', url: 'https://ayebot.com/developers' },
    },
    servers: [{ url: base }],
    paths: {
      '/api/v1/buyer-index': {
        get: {
          operationId: 'getBuyerIndex',
          summary: 'Aggregate acquirer counts by sector and market',
          description: 'Cached upstream for one hour. CORS open (*).',
          responses: {
            '200': { description: 'Buyer index', content: { 'application/json': { schema: { $ref: '#/components/schemas/BuyerIndex' } } } },
            '429': { description: 'Rate limit exceeded (60 per minute per IP); see Retry-After.' },
            '503': { description: 'Upstream temporarily unavailable.' },
          },
        },
      },
      '/mcp': {
        post: {
          operationId: 'mcp',
          summary: 'Model Context Protocol endpoint (Streamable HTTP, stateless, JSON-RPC 2.0)',
          description: 'Tools: count_buyers, list_sectors_and_markets, buyer_appetite_summary, how_to_sell_next_steps. Use an MCP client.',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { '200': { description: 'JSON-RPC response' } },
        },
      },
      '/mcp/server-card': { get: { operationId: 'serverCard', summary: 'MCP Server Card (application/mcp-server-card+json)', responses: { '200': { description: 'Server card' } } } },
    },
    components: {
      schemas: {
        Cell: {
          type: 'object',
          description:
            'Acquirers that list the sector among their target sectors and cover the market, by naming it (market_named) or through a region-wide (region_wide) or global (global) mandate. ' +
            'total = market_named + region_wide + global = strategic + pe + family_office + other. Counts overlap across cells.',
          properties: Object.fromEntries(CELL_FIELDS.map((f) => [f, count])),
          required: [...CELL_FIELDS],
        },
        BuyerIndex: {
          type: 'object',
          properties: {
            source: { type: 'string', example: 'Ayebot (ayebot.com) buyer index, as at 2026-10-08' },
            url: { type: 'string', format: 'uri' },
            note: { type: 'string' },
            generated: { type: 'string', format: 'date' },
            source_synced: { type: 'string', format: 'date-time' },
            sectors: { type: 'object', additionalProperties: { type: 'string' }, description: 'sector key -> name (12)' },
            markets: { type: 'object', additionalProperties: { type: 'string' }, description: 'market key -> name (6)' },
            headline: { type: 'object', properties: Object.fromEntries(HEADLINE_FIELDS.map((f) => [f, count])), description: 'unique = de-duplicated acquirers on the register; strategic = trade buyers; pe = private equity' },
            cells: { type: 'object', additionalProperties: { $ref: '#/components/schemas/Cell' }, description: 'keyed "sector|market", e.g. "healthcare|sg"' },
          },
        },
      },
    },
  };
}
