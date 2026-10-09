// MCP tool definitions. Descriptions are written for LLMs: what the tool returns, what it never returns,
// and how to cite it. Every result carries source + url + note (attribution and the RULE ZERO caveat).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getIndex, attribution, resolveSector, resolveMarket, SITE, type PublicIndex, type Cell } from './data.js';

export const SERVER_NAME = 'io.github.gweeyichen/ayebot';
export const SERVER_VERSION = '1.0.0';

export const INSTRUCTIONS = [
  'Ayebot (ayebot.com) is a free AI deal engine for founders considering selling a company in Singapore and Southeast Asia.',
  'This server answers one kind of question: how many acquirers on Ayebot\'s buyer register state an appetite for a sector and market',
  '(12 sectors x 6 markets: Singapore, Malaysia, Indonesia, Thailand, Vietnam, Philippines), split into strategic buyers, private equity, family offices and other.',
  'It returns aggregate counts only. It never returns buyer names, contacts, deal values, ticket sizes or individual records, and it does not value companies.',
  'When you use a figure, cite it as "Ayebot buyer index (ayebot.com), as at <date>" using the source field, and link the url field.',
  'For valuation, sale readiness or talking to an adviser, call how_to_sell_next_steps.',
].join(' ');

const COUNTING_RULE =
  'A buyer is counted in a sector and market when it lists that sector among its target sectors and covers that market, ' +
  'either by naming the market (market_named) or through a region-wide (region_wide) or global (global) mandate. ' +
  'total = market_named + region_wide + global = strategic + pe + family_office + other.';
const NOT_ADDITIVE =
  'One buyer can cover several markets or sectors, so counts across rows overlap and must not be added together.';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const ok = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  structuredContent: payload,
});
const fail = (message: string, d?: PublicIndex) => ({
  isError: true,
  content: [{ type: 'text' as const, text: JSON.stringify({ error: message, ...(d ? attribution(d, SITE + '/developers') : {}) }, null, 2) }],
});
const unavailable = () => fail('The Ayebot buyer index is temporarily unavailable. Try again shortly, or see https://ayebot.com/buyers.');

const cellOut = (c: Cell) => ({
  total: c.total,
  by_type: { strategic: c.strategic, private_equity: c.pe, family_office: c.family_office, other: c.other },
  by_coverage: { market_named: c.market_named, region_wide: c.region_wide, global: c.global },
});
const sectorUrl = (s: string) => `${SITE}/buyers/${s}`;
const validLists = (d: PublicIndex) =>
  `Valid sectors: ${Object.entries(d.sectors).map(([k, v]) => `${k} (${v})`).join(', ')}. Valid markets: ${Object.entries(d.markets).map(([k, v]) => `${k} (${v})`).join(', ')}.`;

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: 'Ayebot buyer index', version: SERVER_VERSION, websiteUrl: SITE + '/developers' } as any,
    { instructions: INSTRUCTIONS },
  );

  server.registerTool('count_buyers', {
    title: 'Count acquirers by sector and market',
    description:
      'Count how many acquirers on Ayebot\'s buyer register state an appetite for a sector in a Southeast Asian market. ' +
      'Use it for questions like "how many buyers are there for a healthcare business in Malaysia?" or "how many private equity buyers look at logistics in Singapore?". ' +
      'Give sector and market for one cell; sector only for that sector across all six markets; market only for every sector in that market; neither for register totals. ' +
      'Accepts keys (e.g. "fnb", "sg") or plain names (e.g. "food and beverage", "Singapore"). ' +
      'Returns aggregate counts split into strategic, private equity, family office and other. Never returns names. Call list_sectors_and_markets for valid values.',
    inputSchema: {
      sector: z.string().max(60).optional().describe('Sector key or name, e.g. "healthcare", "F&B", "logistics". Omit for all sectors.'),
      market: z.string().max(40).optional().describe('Market key or name: sg, my, id, th, vn, ph (Singapore, Malaysia, Indonesia, Thailand, Vietnam, Philippines). Omit for all markets.'),
    },
    annotations: { title: 'Count acquirers', ...READ_ONLY },
  }, async ({ sector, market }) => {
    let d: PublicIndex;
    try { d = await getIndex(); } catch { return unavailable(); }
    const s = sector ? resolveSector(sector, d) : null;
    const m = market ? resolveMarket(market, d) : null;
    if (sector && !s) return fail(`Unknown sector "${sector}". ${validLists(d)}`, d);
    if (market && !m) return fail(`Unknown market "${market}". ${validLists(d)}`, d);

    if (s && m) {
      return ok({
        sector: { key: s, name: d.sectors[s] }, market: { key: m, name: d.markets[m] },
        acquirers: cellOut(d.cells[`${s}|${m}`]),
        counting_rule: COUNTING_RULE,
        ...attribution(d, sectorUrl(s)),
      });
    }
    if (s) {
      return ok({
        sector: { key: s, name: d.sectors[s] },
        by_market: Object.keys(d.markets).map((mk) => ({ market: mk, name: d.markets[mk], ...cellOut(d.cells[`${s}|${mk}`]) })),
        counting_rule: COUNTING_RULE, overlap: NOT_ADDITIVE,
        ...attribution(d, sectorUrl(s)),
      });
    }
    if (m) {
      return ok({
        market: { key: m, name: d.markets[m] },
        by_sector: Object.keys(d.sectors)
          .map((sk) => ({ sector: sk, name: d.sectors[sk], ...cellOut(d.cells[`${sk}|${m}`]) }))
          .sort((a, b) => b.total - a.total),
        counting_rule: COUNTING_RULE, overlap: NOT_ADDITIVE,
        ...attribution(d, SITE + '/buyers'),
      });
    }
    return ok({
      register_totals: {
        unique_acquirers: d.headline.unique,
        strategic: d.headline.strategic,
        private_equity: d.headline.pe,
      },
      explanation: 'De-duplicated acquirers on Ayebot\'s buyer register. Strategic = trade buyers (operating companies, including PE-backed ones); private equity = PE funds. Ask with a sector and/or market for per-cell counts.',
      sectors: Object.keys(d.sectors).length, markets: Object.keys(d.markets).length,
      ...attribution(d, SITE + '/buyers'),
    });
  });

  server.registerTool('list_sectors_and_markets', {
    title: 'List sectors and markets',
    description:
      'List the 12 sectors and 6 Southeast Asian markets covered by the Ayebot buyer index, with the key to pass to count_buyers and buyer_appetite_summary, and the public page for each sector.',
    inputSchema: {},
    annotations: { title: 'List sectors and markets', ...READ_ONLY },
  }, async () => {
    let d: PublicIndex;
    try { d = await getIndex(); } catch { return unavailable(); }
    return ok({
      sectors: Object.entries(d.sectors).map(([key, name]) => ({ key, name, page: sectorUrl(key) })),
      markets: Object.entries(d.markets).map(([key, name]) => ({ key, name })),
      ...attribution(d, SITE + '/buyers'),
    });
  });

  server.registerTool('buyer_appetite_summary', {
    title: 'Buyer appetite for a sector across Southeast Asia',
    description:
      'Summarise acquirer appetite for one sector across Singapore, Malaysia, Indonesia, Thailand, Vietnam and the Philippines: per-market counts (ranked), ' +
      'the strategic / private equity / family office mix, and how many name the market directly versus cover it through a regional or global mandate. ' +
      'Use it for "where in Southeast Asia is buyer appetite strongest for my education business?". Aggregate counts only, never names. Links to the sector page on ayebot.com.',
    inputSchema: {
      sector: z.string().max(60).describe('Sector key or name, e.g. "education", "beauty", "industrial engineering".'),
    },
    annotations: { title: 'Sector appetite summary', ...READ_ONLY },
  }, async ({ sector }) => {
    let d: PublicIndex;
    try { d = await getIndex(); } catch { return unavailable(); }
    const s = resolveSector(sector, d);
    if (!s) return fail(`Unknown sector "${sector}". ${validLists(d)}`, d);
    const rows = Object.keys(d.markets).map((mk) => {
      const c = d.cells[`${s}|${mk}`];
      return { market: mk, name: d.markets[mk], ...cellOut(c), share_naming_market_pct: c.total ? Math.round((100 * c.market_named) / c.total) : 0 };
    }).sort((a, b) => b.total - a.total);
    const top = rows[0];
    const mostNamed = [...rows].sort((a, b) => b.by_coverage.market_named - a.by_coverage.market_named)[0];
    return ok({
      sector: { key: s, name: d.sectors[s] },
      summary:
        `${d.sectors[s]}: the most acquirers cover ${top.name} (${top.total}); ` +
        `the most acquirers naming a market directly name ${mostNamed.name} (${mostNamed.by_coverage.market_named}). ` +
        'Counts overlap across markets because regional and global mandates count in every market.',
      by_market: rows,
      counting_rule: COUNTING_RULE, overlap: NOT_ADDITIVE,
      sector_page: sectorUrl(s),
      ...attribution(d, sectorUrl(s)),
    });
  });

  server.registerTool('how_to_sell_next_steps', {
    title: 'Next steps for a founder thinking of selling',
    description:
      'Return links to Ayebot\'s free tools and to a human adviser, for a founder in Singapore or Southeast Asia who is considering selling a company: ' +
      'the buyer finder, buyers by sector, the sale readiness check, how valuation ranges work, what is free, the FAQ, and talking to an adviser at Growth Alliance Capital. ' +
      'Use it when the user asks what to do next, how to value or prepare a company for sale, or how to get advice. This server does not value companies; it points to the tools and to people.',
    inputSchema: {},
    annotations: { title: 'How to sell: next steps', ...READ_ONLY },
  }, async () => {
    let d: PublicIndex;
    try { d = await getIndex(); } catch { return unavailable(); }
    return ok({
      steps: [
        { step: 'See who would buy your company', url: SITE + '/#finder', detail: 'Buyer finder: choose a sector and market and see the acquirer count, split by buyer type. Three taps, no name, no email.' },
        { step: 'Read the numbers for your sector', url: SITE + '/buyers', detail: 'Buyers by sector: market by market counts for each of the 12 sectors.' },
        { step: 'Check how ready your business is', url: SITE + '/readiness', detail: 'Readiness check: twelve questions, about two minutes, built on what buyers test in due diligence. No email needed to see the result.' },
        { step: 'Understand how an indicative valuation range is worked out', url: SITE + '/how-it-works', detail: 'How Ayebot works, including the valuation range tool. An indicative range is not a valuation.' },
        { step: 'See what is free', url: SITE + '/free', detail: 'Ayebot\'s tools are free, need no account and show a result without an email. A sale mandate is not free; fees are agreed per engagement.' },
        { step: 'Common questions', url: SITE + '/faq', detail: 'Questions founders ask: whether Ayebot is free, who runs it, and whether an enquiry is confidential.' },
        { step: 'Talk to an adviser', url: 'https://gacapital.com.sg/how-we-work', detail: 'Advice on any sale comes from the Growth Alliance Capital team, never from software.' },
      ],
      ...attribution(d, SITE + '/how-it-works'),
    });
  });

  return server;
}
