// src/sources/tokenized-stocks.mjs
// Powers Theme 6 (Tokenized Stocks Corner).
//
// Rewritten to use data-api.binance.vision instead of www.binance.com/bapi/defi
// (the old binance-tokenized-securities-info skill's endpoint). bStocks —
// Binance's tokenized US equities (NVDAB, TSLAB, CRCLB, etc.) — trade as
// regular SPOT pairs, so they're readable through the exact same public
// ticker endpoint as BTC/ETH/BNB. No special headers, no separate domain,
// no geo-block risk (www.binance.com wasn't confirmed safe from GitHub
// Actions the way data-api.binance.vision is).
//
// Trade-off: this drops the underlying-stock fundamentals (P/E, dividend
// yield, 52-week range) that the old RWA endpoint provided — spot ticker
// data doesn't include those. The theme's angle shifts accordingly: instead
// of "on-chain price vs stock fundamentals", it's now "equities trading
// 24/7 alongside crypto, including outside normal market hours" — which is
// arguably the more interesting story anyway.

import { fetchWithTimeout } from "../http.mjs";

const BASE_URL = "https://data-api.binance.vision";

// Known bStocks USDT pairs as of the product's rollout. This list is NOT
// guaranteed exhaustive or current — Binance has been adding new bStocks
// regularly (5 at launch, 46+ within two months). Update this list
// periodically by checking Binance's bStocks announcement page. A symbol
// that gets delisted or renamed will just fail its own fetch (caught and
// skipped below) rather than breaking the whole theme.
const BSTOCKS = {
  NVDABUSDT: "Nvidia",
  TSLABUSDT: "Tesla",
  CRCLBUSDT: "Circle",
  MUBUSDT: "Micron",
  SNDKBUSDT: "Sandisk",
  CBRSBUSDT: "Cerebras",
  SPYBUSDT: "S&P 500 ETF",
};

// New bStocks can be added WITHOUT a code change: set the BSTOCKS_EXTRA
// variable (GitHub: Settings > Secrets and variables > Actions > Variables) to
// e.g. "AAPLBUSDT=Apple,MSFTBUSDT=Microsoft". Names are optional ("AAPLBUSDT").
// Only plain USDT symbols are accepted, since the symbol goes into a URL. An
// entry that is not a real pair just fails its own fetch and is skipped, like
// any delisted symbol above.
const SYMBOL_PATTERN = /^[A-Z0-9]{2,20}USDT$/;

export function parseExtraBStocks(raw) {
  const extra = {};
  for (const part of String(raw ?? "").split(",")) {
    const [symbol, ...nameParts] = part.split("=");
    const sym = symbol?.trim().toUpperCase();
    if (!sym || !SYMBOL_PATTERN.test(sym)) continue;
    const name = nameParts.join("=").trim();
    extra[sym] = name || undefined;
  }
  return extra;
}

function activeBStocks() {
  return { ...BSTOCKS, ...parseExtraBStocks(process.env.BSTOCKS_EXTRA) };
}

async function fetchTicker24hr(symbol) {
  const res = await fetchWithTimeout(`${BASE_URL}/api/v3/ticker/24hr?symbol=${symbol}`);
  if (!res.ok) {
    throw new Error(`bStock ticker fetch failed for ${symbol}: ${res.status}`);
  }
  return res.json();
}

// The prompt asks for 2-3 tokens; fewer than this and the LLM has to pad the
// post, which is exactly when it starts inventing data.
const MIN_TOKENS = 2;

// Fisher-Yates. (sort(() => Math.random() - 0.5) is biased: it favours
// the early positions, so some tickers were picked far more than others.)
function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Fetch live data for a handful of bStocks. Picks a random subset each run
 * (rather than always the same ones). A symbol that fails to fetch
 * (delisted, renamed, transient error) is replaced by the next candidate
 * instead of silently shrinking the dataset. If fewer than MIN_TOKENS can be
 * fetched, this throws so the run can retry with another theme.
 */
export async function getTokenizedStocksSnapshot({ count = 3 } = {}) {
  const known = activeBStocks();
  const queue = shuffle(Object.keys(known));
  const fetched = [];

  while (fetched.length < count && queue.length > 0) {
    const batch = queue.splice(0, count - fetched.length);
    const results = await Promise.allSettled(batch.map(fetchTicker24hr));
    for (const r of results) if (r.status === "fulfilled") fetched.push(r.value);
  }

  if (fetched.length < MIN_TOKENS) {
    throw new Error(`bStocks: only ${fetched.length} of ${MIN_TOKENS} required tickers could be fetched`);
  }

  return fetched
    .map((t) => ({
      // Exact tradable ticker as a ready-made cashtag (e.g. "$NVDAB").
      // Without this the LLM derives "$NVDA" from the symbol, which isn't
      // the bStock and won't link to its chart on Square.
      cashtag: `$${t.symbol.replace(/USDT$/, "")}`,
      name: known[t.symbol],
      lastPriceUSDT: Number(t.lastPrice),
      priceChangePercent: Number(t.priceChangePercent),
      highPrice: Number(t.highPrice),
      lowPrice: Number(t.lowPrice),
      // quote volume only: raw base volume got confused with USDT volume
      volumeUSDT: Number(t.quoteVolume),
    }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const data = await getTokenizedStocksSnapshot();
  console.log(JSON.stringify(data, null, 2));
}
