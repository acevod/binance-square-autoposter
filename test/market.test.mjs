import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { getBreakoutWatch, getQuietMovers, getRelativeStrength, rollingRanges } from "../src/sources/market.mjs";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Ticker with a chosen 24h range %, price 100 (so range% = high - low).
const tick = (symbol, rangePct, qv, change = 1) => ({
  symbol, lastPrice: "100", highPrice: String(100 + rangePct / 2), lowPrice: String(100 - rangePct / 2),
  priceChangePercent: String(change), quoteVolume: String(qv),
});
// Hourly klines (oldest first): `pastDays` full 24h windows whose range is `avgRange`%,
// then the latest 24h window with range `currentRange`%. The range sits in the first
// candle of each window; the other 23 candles are flat at 100.
const candle = (hi, lo) => [0, "100", String(hi), String(lo), "100", "1"];
const hourly = (pastDays, avgRange, currentRange) => {
  const window = (r) => [candle(100 + r / 2, 100 - r / 2), ...Array.from({ length: 23 }, () => candle(100, 100))];
  return [...Array.from({ length: pastDays }, () => window(avgRange)).flat(), ...window(currentRange)];
};

function mock({ tickers, kl = {}, failKlines = [] }) {
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/klines")) {
      const s = u.searchParams.get("symbol");
      if (failKlines.includes(s)) return new Response("err", { status: 500 });
      const t = tickers.find((x) => x.symbol === s);
      const current = t ? Number(t.highPrice) - Number(t.lowPrice) : 5; // price is 100, so range% = high - low
      return new Response(JSON.stringify(kl[s] ?? hourly(7, 5, current)));
    }
    if (u.pathname.endsWith("/ticker/24hr") && !u.searchParams.get("symbol")) return new Response(JSON.stringify(tickers));
    if (u.searchParams.get("symbol") === "ETHBTC") return new Response(JSON.stringify({ lastPrice: "0.03", priceChangePercent: "-1.2" }));
    throw new Error("unexpected " + u);
  };
}

test("breakout-watch keeps only genuinely wide ranges (ratio >= 1.3), widest first", async () => {
  mock({ tickers: [tick("AAAUSDT", 10, 9e9), tick("BBBUSDT", 5, 8e9), tick("CCCUSDT", 6.75, 7e9)] }); // ratios 2.0, 1.0, 1.35 vs avg 5
  const r = await getBreakoutWatch({ basketSize: 10 });
  assert.deepEqual(r.map((x) => x.cashtag), ["$AAA", "$CCC"]);
});

test("quiet-movers keeps only genuinely narrow ranges (ratio <= 0.8), quietest first", async () => {
  mock({ tickers: [tick("AAAUSDT", 2.5, 9e9), tick("BBBUSDT", 4.5, 8e9), tick("CCCUSDT", 3.5, 7e9)] }); // ratios 0.5, 0.9, 0.7
  const r = await getQuietMovers({ basketSize: 10 });
  assert.deepEqual(r.map((x) => x.cashtag), ["$AAA", "$CCC"]);
});

test("nothing anomalous -> empty list (generate.mjs turns that into a retry with another theme)", async () => {
  mock({ tickers: [tick("AAAUSDT", 5, 9e9), tick("BBBUSDT", 5.2, 8e9)] });
  assert.deepEqual(await getBreakoutWatch({ basketSize: 10 }), []);
  assert.deepEqual(await getQuietMovers({ basketSize: 10 }), []);
});

test("a fresh listing without enough history is excluded, not ranked on noise", async () => {
  mock({
    tickers: [tick("NEWUSDT", 20, 9e9), tick("OLDUSDT", 10, 8e9)],
    kl: { NEWUSDT: hourly(2, 5, 20) }, // only 2 full past days
  });
  const r = await getBreakoutWatch({ basketSize: 10 });
  assert.deepEqual(r.map((x) => x.cashtag), ["$OLD"]);
});

test("one failing klines request doesn't sink the whole theme", async () => {
  mock({ tickers: [tick("AAAUSDT", 10, 9e9), tick("BBBUSDT", 10, 8e9)], failKlines: ["BBBUSDT"] });
  const r = await getBreakoutWatch({ basketSize: 10 });
  assert.deepEqual(r.map((x) => x.cashtag), ["$AAA"]);
});

test("relative-strength uses the median alt, so one outlier can't fake a trend", async () => {
  mock({ tickers: [tick("BTCUSDT", 3, 9e9, 2), tick("AAAUSDT", 3, 8e9, 1), tick("BBBUSDT", 3, 7e9, 1), tick("CCCUSDT", 3, 6e9, 1), tick("DDDUSDT", 3, 5e9, 89)] });
  const r = await getRelativeStrength({ basketSize: 20 });
  assert.equal(r.altsMedianChangePercent, 1); // a mean would say 23
  assert.equal(r.altsCount, 4);
  assert.equal(r.btcChangePercent, 2);
  assert.equal("basketSize" in r, false);
});

test("rollingRanges: windows are 24 candles back from now, so a spike 30h ago is NOT in the latest window", () => {
  const flat = () => ({ high: 100, low: 100, close: 100 });
  const hourlyArr = Array.from({ length: 24 * 8 }, flat);
  hourlyArr[hourlyArr.length - 31] = { high: 110, low: 90, close: 100 }; // 30h ago -> window 1
  const r = rollingRanges(hourlyArr, 7);
  assert.equal(r.current, 0);
  assert.equal(r.past[0], 20);
  assert.equal(r.past.length, 7);
});

test("rollingRanges: too little history returns null", () => {
  const flat = () => ({ high: 100, low: 100, close: 100 });
  assert.equal(rollingRanges(Array.from({ length: 24 * 4 }, flat), 7), null);
});

test("ratio uses hourly klines for BOTH sides (current range comes from klines, not the ticker)", async () => {
  // ticker says a tiny range, klines say the latest 24h is wide: the ratio must follow the klines
  mock({ tickers: [tick("AAAUSDT", 0.1, 9e9)], kl: { AAAUSDT: hourly(7, 5, 10) } });
  const r = await getBreakoutWatch({ basketSize: 10 });
  assert.equal(r.length, 1);
  assert.equal(Math.round(r[0].ratio * 100) / 100, 2);
});

import { buildRegime } from "../src/sources/market.mjs";

const asset = (symbol, change, range = 4) => ({ symbol, lastPrice: 100, priceChangePercent: change, highPrice: 100 + range / 2, lowPrice: 100 - range / 2, quoteVolume: 1e9 });

test("buildRegime: broad-up and alt-led", () => {
  const basket = [asset("BTCUSDT", 1), ...[3, 3.5, 2.8, 3.2, 2.5, 4, 3.1, 2.9, -0.5, 3.3].map((c, i) => asset(`A${i}USDT`, c))];
  const r = buildRegime(basket);
  assert.equal(r.direction, "broad-up");
  assert.equal(r.leadership, "alts-ahead");
  assert.equal(r.breadthUpPct, 90);
  assert.equal(r.altsCount, 10);
});

test("buildRegime: broad-down and btc-led", () => {
  const basket = [asset("BTCUSDT", -0.5), ...[-3, -2.5, -3.2, -2, -2.8, 0.2, -3.1].map((c, i) => asset(`A${i}USDT`, c))];
  const r = buildRegime(basket);
  assert.equal(r.direction, "broad-down");
  assert.equal(r.leadership, "btc-ahead");
});

test("buildRegime: mixed and in-line", () => {
  const basket = [asset("BTCUSDT", 0.5), ...[1, -1, 0.8, -0.9, 0.6, -0.4].map((c, i) => asset(`A${i}USDT`, c))];
  const r = buildRegime(basket);
  assert.equal(r.direction, "mixed");
  assert.equal(r.leadership, "in-line");
});

test("buildRegime: throws without BTC or with too few alts (generate retries another theme)", () => {
  assert.throws(() => buildRegime([asset("AAAUSDT", 1), asset("BBBUSDT", 1)]), /BTC missing/);
  assert.throws(() => buildRegime([asset("BTCUSDT", 1), asset("AAAUSDT", 1)]), /too few alts/);
});
