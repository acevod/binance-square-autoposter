// src/sources/market.mjs
// Powers Theme 1 (Morning Market Brief), Theme 2 (Leaders & Laggards),
// Theme 3 (Breakout Watch), Theme 4 (The Quiet Ones), Theme 5 (Relative
// Strength Check), and Theme 7 (Daily Recap). All from Binance's public
// market data — no API key, and deliberately limited to Binance-listed
// USDT pairs only (no DEX/on-chain tokens), which is what keeps this safe
// from the compliance issue that got the old DEX-based themes flagged.

// api.binance.com returns HTTP 451 from US-hosted IPs (GitHub Actions
// runners included — they run on US Azure datacenters). data-api.binance.vision
// is Binance's public read-only market-data mirror with the same response
// shape and no geo-restriction.
import { fetchWithTimeout } from "../http.mjs";
import { isThinExtreme } from "../anomaly.mjs";

const BASE_URL = "https://data-api.binance.vision";
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT"];

// Matches leveraged tokens (BTCUPUSDT, ETHDOWNUSDT, etc.). Binance actually
// discontinued USDT-paired leveraged tokens years ago, so as of now this
// pattern matches nothing in real ticker data — it's a defensive no-op,
// kept in case a similar product ever reappears, not something currently
// filtering real results.
const LEVERAGED_TOKEN_PATTERN = /(UP|DOWN|BULL|BEAR)USDT$/;

// Stablecoin/USDT pairs (USDCUSDT, FDUSDUSDT, etc.) trade near 1:1 by
// design — they'd otherwise show up in the volume-ranked basket (they're
// often high-volume) but are meaningless for "leader/laggard" or
// "breakout" framing since they basically never move. Matched by base
// asset (the part before USDT), not a leveraged-token-style suffix match.
const STABLECOIN_BASE_ASSETS = new Set([
  "USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "USDD", "PYUSD", "EURI",
  "USD1", "USDE", "USDS", "USDG", "RLUSD", "AEUR", "BFUSD", "XUSD",
]);

function isStablecoinPair(symbol) {
  const baseAsset = symbol.slice(0, -"USDT".length);
  return STABLECOIN_BASE_ASSETS.has(baseAsset);
}

// The name list above can't keep up with new stablecoins (USD1 slipped
// through it and showed up in a real "Quiet Ones" post as a "quiet mover").
// Fingerprint backstop: priced within 2 cents of $1 AND a sub-1% daily
// range is a USD peg for all practical purposes. A genuine coin sitting
// at ~$1 with a range that flat would make a pointless post anyway.
function looksPegged(t) {
  const last = Number(t.lastPrice);
  const rangePct = ((Number(t.highPrice) - Number(t.lowPrice)) / last) * 100;
  return last > 0 && Math.abs(last - 1) <= 0.02 && rangePct < 1;
}

async function fetchTicker24hr(symbol) {
  const res = await fetchWithTimeout(`${BASE_URL}/api/v3/ticker/24hr?symbol=${symbol}`);
  if (!res.ok) {
    throw new Error(`Binance ticker fetch failed for ${symbol}: ${res.status}`);
  }
  return res.json();
}

// Fetches ALL tickers in one call (no symbol param) — this is the only way
// to know who's "top" at anything; there's no endpoint that returns
// pre-ranked results, so we fetch everything then sort/filter ourselves.
async function fetchAllTickers() {
  const res = await fetchWithTimeout(`${BASE_URL}/api/v3/ticker/24hr`);
  if (!res.ok) {
    throw new Error(`Binance all-tickers fetch failed: ${res.status}`);
  }
  const all = await res.json();
  if (!Array.isArray(all)) throw new Error("Binance all-tickers: unexpected response shape");
  return all;
}

async function fetchKlines(symbol, interval = "1d", limit = 8) {
  const res = await fetchWithTimeout(
    `${BASE_URL}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  );
  if (!res.ok) {
    throw new Error(`Binance klines fetch failed for ${symbol}: ${res.status}`);
  }
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error(`Binance klines for ${symbol}: unexpected response shape`);
  // Each row: [openTime, open, high, low, close, volume, closeTime, ...]
  return raw.map((k) => ({
    openTime: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

// A real published post wrote "$MARSCOINUSDT", "$ZECUSDT" etc — the LLM
// cashtagged the raw trading-pair symbol (base+quote glued together)
// instead of just the base asset. Square actually parsed it fine (only
// "$MARSCOIN" rendered as the live cashtag, "USDT" sat after as plain
// text) but with no space it reads as one garbled ticker. Same fix
// already applied to bStocks: send a ready-made cashtag, don't make the
// LLM derive one from a raw pair symbol.
function toCashtag(symbol) {
  return `$${symbol.replace(/USDT$/, "")}`;
}

// Median is robust to a single outlier (one +89% alt would drag a mean to
// +18% and make "the typical alt" a lie).
function median(numbers) {
  const v = numbers.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function average(numbers) {
  const valid = numbers.filter(Number.isFinite);
  if (valid.length === 0) return NaN;
  return valid.reduce((sum, n) => sum + n, 0) / valid.length;
}

/**
 * Fetch 24hr ticker stats for BTC, ETH, BNB.
 * Used identically by Theme 1 (morning) and Theme 7 (recap) —
 * the two themes differ only in prompt framing, not in the data shape.
 */
export async function getMarketSnapshot() {
  const results = await Promise.all(SYMBOLS.map(fetchTicker24hr));

  return results.map((t) => ({
    symbol: t.symbol,
    cashtag: toCashtag(t.symbol),
    lastPrice: Number(t.lastPrice),
    priceChangePercent: Number(t.priceChangePercent),
    highPrice: Number(t.highPrice),
    lowPrice: Number(t.lowPrice),
    volume: Number(t.volume),
    quoteVolume: Number(t.quoteVolume),
  }));
}

/**
 * The "basket": top N USDT pairs by 24h quote volume, excluding leveraged
 * tokens. Rebuilt fresh every run — if a pair gets delisted it just drops
 * out naturally, no manual list to maintain. Deliberately volume-ranked
 * (not just "any USDT pair") so the basket only ever contains tokens with
 * real trading activity on Binance, not obscure/thin listings.
 */
export async function getDynamicBasket(size = 20) {
  const all = await fetchAllTickers();

  return all
    .filter(
      (t) =>
        t.symbol.endsWith("USDT") &&
        !LEVERAGED_TOKEN_PATTERN.test(t.symbol) &&
        !isStablecoinPair(t.symbol) &&
        !looksPegged(t)
    )
    .map((t) => ({
      symbol: t.symbol,
      cashtag: toCashtag(t.symbol),
      lastPrice: Number(t.lastPrice),
      priceChangePercent: Number(t.priceChangePercent),
      highPrice: Number(t.highPrice),
      lowPrice: Number(t.lowPrice),
      quoteVolume: Number(t.quoteVolume),
    }))
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, size);
}

/**
 * Theme 2 — Leaders & Laggards.
 * Contrast framing: who's winning vs losing today within the basket,
 * not just a flat ranking.
 */
export async function getLeadersLaggards({ basketSize = 20, topN = 3 } = {}) {
  // Thin-liquidity extreme movers (e.g. +126% on a small volume) are dropped
  // here so the bot never promotes a pump; see anomaly.mjs.
  const basket = (await getDynamicBasket(basketSize)).filter((t) => !isThinExtreme(t));
  const sorted = [...basket].sort((a, b) => b.priceChangePercent - a.priceChangePercent);

  return {
    leaders: sorted.slice(0, topN),
    laggards: sorted.slice(-topN).reverse(),
  };
}

/**
 * Shared helper for Theme 3 & 4: for each basket token, compare the most
 * recent 24h's high-low range (as % of price) against its average daily
 * range over the past `historyDays`. Ratio > 1 means the last 24h were
 * more volatile than usual (breakout candidate); ratio < 1 means unusually
 * quiet (compression). Basket kept smaller here (default 10) since this
 * fetches klines per token — 10 extra calls is fine, 20+ starts adding
 * meaningful latency.
 *
 * Both sides now use the SAME kind of window: hourly klines are cut into
 * consecutive 24-hour windows counted back from now (window 0 = the last 24h,
 * window 1 = the 24h before that, and so on). The old version compared the
 * rolling-24h ticker range with UTC calendar-day candles, which are different
 * windows, so the ratio was only directionally right.
 */
// A token needs this many full past days for its "usual range" to mean anything
// (a listing from 2 days ago has no usual range).
const MIN_HISTORY_DAYS = 5;
// The prompts call 1.0-1.3 "basically normal" and 0.8-1.0 "basically normal",
// so a theme built on them would be about nothing. Only genuine anomalies qualify.
export const BREAKOUT_MIN_RATIO = 1.3;
export const QUIET_MAX_RATIO = 0.8;

const WINDOW_HOURS = 24;

/**
 * Cuts hourly candles (oldest first, last one = the forming hour) into
 * consecutive 24h windows counted back from the newest candle.
 * Returns the range % of the latest window and of each earlier window
 * (up to `days`), or null if there are fewer than MIN_HISTORY_DAYS earlier
 * windows. Range % = (highest high - lowest low) / last close of the window.
 */
export function rollingRanges(hourly, days) {
  const windows = [];
  for (let k = 0; k <= days; k++) {
    const end = hourly.length - WINDOW_HOURS * k;
    const start = end - WINDOW_HOURS;
    if (start < 0) break;
    const slice = hourly.slice(start, end);
    const high = Math.max(...slice.map((c) => c.high));
    const low = Math.min(...slice.map((c) => c.low));
    const ref = slice[slice.length - 1].close;
    if (!(ref > 0)) return null;
    windows.push(((high - low) / ref) * 100);
  }
  const past = windows.slice(1);
  if (past.length < MIN_HISTORY_DAYS) return null;
  return { current: windows[0], past };
}

async function getRangeAnomalies({ basketSize = 10, historyDays = 7 } = {}) {
  const basket = await getDynamicBasket(basketSize);

  // allSettled: one pair's failing klines request shouldn't sink the theme.
  const settled = await Promise.allSettled(
    basket.map(async (t) => {
      const hourly = await fetchKlines(t.symbol, "1h", WINDOW_HOURS * (historyDays + 1));
      const ranges = rollingRanges(hourly, historyDays);
      if (!ranges) return null;
      const avgRangePct = average(ranges.past);
      const last24hRangePct = ranges.current;

      return {
        symbol: t.symbol,
        cashtag: toCashtag(t.symbol),
        lastPrice: t.lastPrice,
        priceChangePercent: t.priceChangePercent,
        last24hRangePct,
        avgRangePct,
        ratio: last24hRangePct / avgRangePct,
      };
    })
  );

  return settled
    .filter((r) => r.status === "fulfilled" && r.value)
    .map((r) => r.value)
    .filter((r) => Number.isFinite(r.ratio) && r.avgRangePct > 0);
}

/** Theme 3 — Breakout Watch: today's range is unusually WIDE vs normal. */
export async function getBreakoutWatch({ basketSize = 10, historyDays = 7, topN = 3 } = {}) {
  const anomalies = await getRangeAnomalies({ basketSize, historyDays });
  return anomalies
    .filter((a) => a.ratio >= BREAKOUT_MIN_RATIO)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, topN);
}

/** Theme 4 — The Quiet Ones: today's range is unusually NARROW vs normal. */
export async function getQuietMovers({ basketSize = 10, historyDays = 7, topN = 3 } = {}) {
  const anomalies = await getRangeAnomalies({ basketSize, historyDays });
  return anomalies
    .filter((a) => a.ratio <= QUIET_MAX_RATIO)
    .sort((a, b) => a.ratio - b.ratio)
    .slice(0, topN);
}

/**
 * Theme 5 — Relative Strength Check.
 * ETH/BTC pair gives a direct, native ratio-change reading (no manual
 * math needed — Binance lists ETHBTC as its own pair). Combined with how
 * the average alt in the basket did vs BTC itself, this tells a "where's
 * money rotating" story instead of just listing prices.
 */
export async function getRelativeStrength({ basketSize = 20 } = {}) {
  const [ethBtc, basket] = await Promise.all([
    fetchTicker24hr("ETHBTC"),
    getDynamicBasket(basketSize),
  ]);

  const btc = basket.find((t) => t.symbol === "BTCUSDT");
  const alts = basket.filter((t) => t.symbol !== "BTCUSDT");

  return {
    ethBtcPrice: Number(ethBtc.lastPrice),
    ethBtcChangePercent: Number(ethBtc.priceChangePercent),
    btcChangePercent: btc?.priceChangePercent ?? null,
    altsMedianChangePercent: median(alts.map((t) => t.priceChangePercent)),
    altsCount: alts.length,
  };
}

/**
 * Theme 8 - Market Regime.
 * Classifies the last 24h from the basket in code, so the LLM explains labels
 * instead of inventing them: direction (how broad the move is) and leadership
 * (whether the typical alt did better or worse than BTC; on a down day "ahead" means it fell LESS). Descriptive only, no
 * forecast. Thresholds are deliberately plain and live here, not in a prompt.
 */
export const BROAD_BREADTH_PCT = 70; // share of alts moving the same way to call a move "broad"
export const LEADERSHIP_SPREAD_PCT = 1; // median-alt minus BTC change needed to call someone "leading"

const round2 = (n) => Math.round(n * 100) / 100;

export function buildRegime(basket) {
  const btc = basket.find((t) => t.symbol === "BTCUSDT");
  const alts = basket.filter((t) => t.symbol !== "BTCUSDT");
  if (!btc) throw new Error("market-regime: BTC missing from basket");
  if (alts.length < 5) throw new Error("market-regime: too few alts to classify");

  const altsMedian = median(alts.map((t) => t.priceChangePercent));
  const breadthUpPct = Math.round((alts.filter((t) => t.priceChangePercent > 0).length / alts.length) * 100);
  const breadthDownPct = Math.round((alts.filter((t) => t.priceChangePercent < 0).length / alts.length) * 100);
  const medianRangePct = median(alts.map((t) => ((t.highPrice - t.lowPrice) / t.lastPrice) * 100));
  const spread = altsMedian - btc.priceChangePercent;

  const direction =
    breadthUpPct >= BROAD_BREADTH_PCT ? "broad-up" : breadthUpPct <= 100 - BROAD_BREADTH_PCT ? "broad-down" : "mixed";
  const leadership =
    spread >= LEADERSHIP_SPREAD_PCT ? "alts-ahead" : spread <= -LEADERSHIP_SPREAD_PCT ? "btc-ahead" : "in-line";

  return {
    btcChangePercent: round2(btc.priceChangePercent),
    altsMedianChangePercent: round2(altsMedian),
    altsCount: alts.length,
    breadthUpPct,
    breadthDownPct,
    medianRangePct: round2(medianRangePct),
    direction,
    leadership,
  };
}

export async function getMarketRegime({ basketSize = 20 } = {}) {
  return buildRegime(await getDynamicBasket(basketSize));
}

// Standalone test: `node src/sources/market.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const [snapshot, leadersLaggards, breakout, quiet, relativeStrength] = await Promise.all([
    getMarketSnapshot(),
    getLeadersLaggards(),
    getBreakoutWatch(),
    getQuietMovers(),
    getRelativeStrength(),
  ]);
  console.log(JSON.stringify({ snapshot, leadersLaggards, breakout, quiet, relativeStrength }, null, 2));
}
