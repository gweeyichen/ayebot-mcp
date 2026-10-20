// Ayebot buyer index: fetch, WHITELIST-filter, cache.
//
// RULE ZERO (2026-10-02) + maintainer ruling 2026-10-09 ("you can't give the names out right? No proprietary"):
// this service exposes ONLY aggregate counts from the public file https://ayebot.com/data/buyer-index.json.
// Never names, contacts, ticket sizes, individual records, valuation benchmarks or HQ-derived figures.
// The filter below is a whitelist: any field not named here is dropped, and any non-integer count fails closed.

export const UPSTREAM = process.env.UPSTREAM_URL || 'https://ayebot.com/data/buyer-index.json';
export const SITE = 'https://ayebot.com';
const TTL_MS = 60 * 60 * 1000; // 1 hour

/** Per-cell fields that may be published. Size bands (s1..s4), japan_hq and anything else are dropped. */
export const CELL_FIELDS = ['total', 'market_named', 'region_wide', 'global', 'strategic', 'pe', 'family_office', 'other'] as const;
/** Headline fields that may be published. HQ-derived fields (hq_countries, japan_hq, overseas_pct, hq_identifiable, listed) are dropped. */
export const HEADLINE_FIELDS = ['unique', 'strategic', 'pe'] as const;

export type Cell = Record<(typeof CELL_FIELDS)[number], number>;
export type Headline = Record<(typeof HEADLINE_FIELDS)[number], number>;
export interface PublicIndex {
  generated: string;
  source_synced: string;
  as_at: string; // YYYY-MM-DD, Singapore date of source_synced
  sectors: Record<string, string>;
  markets: Record<string, string>;
  headline: Headline;
  cells: Record<string, Cell>;
}

const KEY = /^[a-z]{2,12}$/;
const LABEL = /^[A-Za-z0-9 ,&'-]{2,60}$/;

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 1_000_000;
}

/** Whitelist filter. Throws (fail closed) on any unexpected shape. */
export function sanitize(raw: any): PublicIndex {
  if (!raw || typeof raw !== 'object') throw new Error('upstream: not an object');
  const dateOk = (s: unknown) => typeof s === 'string' && !Number.isNaN(Date.parse(s));
  if (!dateOk(raw.generated) || !dateOk(raw.source_synced)) throw new Error('upstream: bad dates');
  const dict = (o: any, what: string) => {
    if (!o || typeof o !== 'object') throw new Error(`upstream: ${what} missing`);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) {
      if (!KEY.test(k) || typeof v !== 'string' || !LABEL.test(v)) throw new Error(`upstream: bad ${what} entry`);
      out[k] = v;
    }
    return out;
  };
  const sectors = dict(raw.sectors, 'sectors');
  const markets = dict(raw.markets, 'markets');
  const headline = {} as Headline;
  for (const f of HEADLINE_FIELDS) {
    if (!isCount(raw.headline?.[f])) throw new Error(`upstream: headline.${f} not a count`);
    headline[f] = raw.headline[f];
  }
  const cells: Record<string, Cell> = {};
  for (const s of Object.keys(sectors)) {
    for (const m of Object.keys(markets)) {
      const c = raw.cells?.[`${s}|${m}`];
      if (!c) throw new Error(`upstream: cell ${s}|${m} missing`);
      const cell = {} as Cell;
      for (const f of CELL_FIELDS) {
        if (!isCount(c[f])) throw new Error(`upstream: cell ${s}|${m}.${f} not a count`);
        cell[f] = c[f];
      }
      cells[`${s}|${m}`] = cell;
    }
  }
  const as_at = new Date(raw.source_synced).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
  return { generated: raw.generated, source_synced: raw.source_synced, as_at, sectors, markets, headline, cells };
}

let cache: { data: PublicIndex; at: number } | null = null;
let inflight: Promise<PublicIndex> | null = null;

async function fetchFresh(): Promise<PublicIndex> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(UPSTREAM, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': 'ayebot-mcp/1.0 (+https://ayebot.com/developers)' } });
    if (!r.ok) throw new Error(`upstream HTTP ${r.status}`);
    const data = sanitize(await r.json());
    cache = { data, at: Date.now() };
    return data;
  } finally {
    clearTimeout(t);
  }
}

/** Cached for 1 hour. On upstream failure, serves the last good copy if there is one. */
export async function getIndex(): Promise<PublicIndex> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (!inflight) inflight = fetchFresh().finally(() => { inflight = null; });
  try {
    return await inflight;
  } catch (e) {
    if (cache) return cache.data; // stale but valid beats an outage
    throw e;
  }
}

export function cacheInfo() {
  return cache ? { cached_at: new Date(cache.at).toISOString(), source_synced: cache.data.source_synced } : null;
}

// ---------- attribution carried on every response ----------
export const NOTE =
  'Counts are aggregate and contain no figure from any live sale process. No buyer names or records are published. ' +
  'On the register means listed in it, not a relationship; a count is not a promise of interest.';
export function attribution(d: PublicIndex, url: string) {
  return { source: `Ayebot (ayebot.com) buyer index, as at ${d.as_at}`, url, note: NOTE };
}

// ---------- tolerant lookups ----------
const SECTOR_SYN: Record<string, string[]> = {
  healthcare: ['health', 'medical', 'clinic', 'clinics', 'hospital', 'pharma', 'pharmaceutical', 'dental', 'aged care', 'elderly care', 'nursing', 'diagnostics', 'healthcare and medical'],
  beauty: ['aesthetics', 'aesthetic', 'wellness', 'spa', 'salon', 'cosmetics', 'fitness', 'beauty aesthetics and wellness'],
  consumer: ['retail', 'consumer brands', 'brands', 'ecommerce', 'e-commerce', 'fmcg', 'lifestyle', 'consumer brands and retail'],
  fnb: ['f&b', 'f and b', 'food', 'beverage', 'food and beverage', 'restaurant', 'restaurants', 'catering', 'bakery'],
  education: ['school', 'schools', 'tuition', 'training', 'childcare', 'preschool', 'learning', 'edtech'],
  logistics: ['supply chain', 'freight', 'shipping', 'warehousing', 'warehouse', '3pl', 'courier', 'cold chain', 'marine', 'maritime', 'logistics and supply chain'],
  industrial: ['engineering', 'manufacturing', 'precision engineering', 'machinery', 'automation', 'chemicals', 'industrial and engineering'],
  building: ['building services', 'infrastructure', 'construction', 'facilities', 'facility management', 'm&e', 'cleaning', 'hvac', 'fire', 'electrical', 'building services and infrastructure'],
  technology: ['tech', 'software', 'saas', 'it', 'it services', 'digital', 'cybersecurity', 'data', 'technology and software'],
  services: ['business services', 'professional services', 'consulting', 'outsourcing', 'staffing', 'recruitment', 'hr', 'marketing', 'accounting', 'bpo', 'business and professional services'],
  financial: ['finance', 'financial services', 'insurance', 'wealth', 'wealth management', 'payments', 'lending', 'brokerage'],
  energy: ['environment', 'renewable', 'renewables', 'solar', 'waste', 'recycling', 'water', 'energy and environment', 'cleantech'],
};
const MARKET_SYN: Record<string, string[]> = {
  sg: ['singapore', 'sgp'], my: ['malaysia', 'mys'], id: ['indonesia', 'idn'], th: ['thailand', 'tha'],
  vn: ['vietnam', 'viet nam', 'vnm'], ph: ['philippines', 'the philippines', 'phl'],
};
const norm = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

function resolve(input: string, labels: Record<string, string>, syn: Record<string, string[]>): string | null {
  const q = norm(input);
  if (!q) return null;
  for (const k of Object.keys(labels)) if (q === k || q === norm(labels[k])) return k;
  for (const [k, list] of Object.entries(syn)) if (k in labels && list.some((x) => norm(x) === q)) return k;
  return null;
}
export const resolveSector = (s: string, d: PublicIndex) => resolve(s, d.sectors, SECTOR_SYN);
export const resolveMarket = (s: string, d: PublicIndex) => resolve(s, d.markets, MARKET_SYN);
