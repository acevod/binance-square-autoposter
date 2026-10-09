import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { getTokenizedStocksSnapshot } from "../src/sources/tokenized-stocks.mjs";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const ticker = (symbol) => ({ symbol, lastPrice: "100", highPrice: "101", lowPrice: "99", priceChangePercent: "1", quoteVolume: "1000000" });
const mockHealthy = (healthy) => {
  globalThis.fetch = async (url) => {
    const s = new URL(String(url)).searchParams.get("symbol");
    return healthy.has(s) ? new Response(JSON.stringify(ticker(s))) : new Response("err", { status: 500 });
  };
};

test("all healthy -> 3 tokens", async () => {
  mockHealthy(new Set(["NVDABUSDT", "TSLABUSDT", "CRCLBUSDT", "MUBUSDT", "SNDKBUSDT", "CBRSBUSDT", "SPYBUSDT"]));
  assert.equal((await getTokenizedStocksSnapshot()).length, 3);
});

test("failed symbols are backfilled: with 2 healthy of 7 it ALWAYS returns both (was 0-1 about 74% of runs)", async () => {
  mockHealthy(new Set(["NVDABUSDT", "TSLABUSDT"]));
  for (let i = 0; i < 100; i++) {
    const r = await getTokenizedStocksSnapshot();
    assert.deepEqual(r.map((t) => t.cashtag).sort(), ["$NVDAB", "$TSLAB"]);
  }
});

test("only 1 healthy symbol -> throws instead of feeding the LLM a thin dataset", async () => {
  mockHealthy(new Set(["NVDABUSDT"]));
  await assert.rejects(getTokenizedStocksSnapshot(), /only 1 of 2 required/);
});

test("everything failing -> throws (no more empty array into the prompt)", async () => {
  mockHealthy(new Set());
  await assert.rejects(getTokenizedStocksSnapshot(), /only 0 of 2 required/);
});

test("selection is uniform (Fisher-Yates), each symbol ~42.9% of picks", async () => {
  mockHealthy(new Set(["NVDABUSDT", "TSLABUSDT", "CRCLBUSDT", "MUBUSDT", "SNDKBUSDT", "CBRSBUSDT", "SPYBUSDT"]));
  const N = 6000, counts = {};
  for (let i = 0; i < N; i++) for (const t of await getTokenizedStocksSnapshot()) counts[t.cashtag] = (counts[t.cashtag] ?? 0) + 1;
  for (const [tag, c] of Object.entries(counts)) {
    const pct = (c / N) * 100;
    assert.ok(pct > 39.5 && pct < 46.5, `${tag} picked ${pct.toFixed(1)}% (expected ~42.9%)`);
  }
});

import { parseExtraBStocks } from "../src/sources/tokenized-stocks.mjs";

test("parseExtraBStocks: parses pairs, names optional, rejects unsafe or malformed symbols", () => {
  const r = parseExtraBStocks("aaplbusdt=Apple, MSFTBUSDT , BAD/../x=Evil, USDT, TSLA?x=1USDT, NOUSD=Nope");
  assert.deepEqual(Object.keys(r).sort(), ["AAPLBUSDT", "MSFTBUSDT"]);
  assert.equal(r.AAPLBUSDT, "Apple");
  assert.equal(r.MSFTBUSDT, undefined);
  assert.deepEqual(parseExtraBStocks(undefined), {});
});

test("BSTOCKS_EXTRA symbols join the pool (no code change needed)", async () => {
  process.env.BSTOCKS_EXTRA = "AAPLBUSDT=Apple";
  try {
    mockHealthy(new Set(["AAPLBUSDT"]));
    const r = await getTokenizedStocksSnapshot({ count: 1 }).catch(() => null);
    // only AAPL is healthy; with MIN_TOKENS=2 this must throw, proving it was in the pool but alone
    assert.equal(r, null);
    mockHealthy(new Set(["AAPLBUSDT", "NVDABUSDT"]));
    const both = await getTokenizedStocksSnapshot();
    assert.deepEqual(both.map((t) => t.cashtag).sort(), ["$AAPLB", "$NVDAB"]);
    assert.equal(both.find((t) => t.cashtag === "$AAPLB").name, "Apple");
  } finally {
    delete process.env.BSTOCKS_EXTRA;
  }
});
