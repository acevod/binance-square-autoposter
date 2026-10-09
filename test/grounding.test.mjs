import test from "node:test";
import assert from "node:assert/strict";
import { checkGrounding, extractSignificantNumbers } from "../src/grounding.mjs";
import { RECAP_DATA, GOOD_RECAP } from "./helpers.mjs";

test("a real-style recap post is fully grounded (rounding, truncation, K/M/B suffixes)", () => {
  assert.deepEqual(checkGrounding(GOOD_RECAP, "daily-recap", RECAP_DATA), { ok: true });
});

test("fabricated ticker is rejected", () => {
  const r = checkGrounding("$NOTREAL rose 1.2% while $BTC held $84,750.", "daily-recap", RECAP_DATA);
  assert.equal(r.ok, false);
  assert.match(r.reason, /\$NOTREAL/);
});

test("fabricated percentage is rejected", () => {
  const r = checkGrounding("$BTC jumped 7.8% to $84,750.", "daily-recap", RECAP_DATA);
  assert.equal(r.ok, false);
  assert.match(r.reason, /7\.8%/);
});

test("invented price level is rejected (the 'next resistance' failure)", () => {
  const r = checkGrounding("$BTC sits at $84,750 with $84,600 as the level.", "daily-recap", RECAP_DATA);
  assert.equal(r.ok, false);
  assert.match(r.reason, /84,600/);
});

test("sign is ignored: 'down 0.5%' matches -0.5", () => {
  const data = [{ cashtag: "$XRP", lastPrice: 1.4879, priceChangePercent: -0.5, highPrice: 1.49, lowPrice: 1.48 }];
  assert.equal(checkGrounding("$XRP slipped 0.5% to $1.4879.", "quiet-movers", data).ok, true);
});

test("derived range % and ratio-based gap are accepted", () => {
  const data = [{ cashtag: "$SUI", lastPrice: 1.1579, priceChangePercent: 0.3, highPrice: 1.19, lowPrice: 1.12, last24hRangePct: 6.4, avgRangePct: 11, ratio: 0.58 }];
  // (1.19-1.12)/1.1579*100 = 6.05 ; |0.58-1|*100 = 42
  assert.equal(checkGrounding("$SUI swung 6.4% vs 11%, about 42% tighter.", "quiet-movers", data).ok, true);
});

test("small counts and durations are ignored", () => {
  assert.equal(checkGrounding("In the past 24 hours, 3 coins led and $BTC was flat at $84,750.", "daily-recap", RECAP_DATA).ok, true);
});

test("digits inside tickers are not read as numbers", () => {
  const data = [{ cashtag: "$1INCH", lastPrice: 0.18, priceChangePercent: 3, highPrice: 0.2, lowPrice: 0.17 }];
  assert.equal(checkGrounding("$1INCH gained 3% to $0.18.", "leaders-laggards", data).ok, true);
  assert.deepEqual(extractSignificantNumbers("$1INCH and $1000SATS"), []);
});

test("relative-strength allows $BTC/$ETH although data has no cashtag fields", () => {
  const data = { ethBtcPrice: 0.032, ethBtcChangePercent: -1.24, btcChangePercent: 1.96, altsMedianChangePercent: -1.61, altsCount: 19 };
  const ok = checkGrounding("$ETH is down 1.24% against $BTC, which gained 1.96%. Alts slipped 1.61%.", "relative-strength", data);
  assert.equal(ok.ok, true);
  assert.equal(checkGrounding("$SOL is down 1.24%.", "relative-strength", data).ok, false);
});

test("empty source data cannot ground anything", () => {
  const r = checkGrounding("$NVDAB rose 2%.", "tokenized-stocks", []);
  assert.equal(r.ok, false);
  assert.match(r.reason, /No source data/);
});

import { checkGrounding as checkG } from "../src/grounding.mjs";

test("'3.72 million' / '1.4 billion' are read as 3,720,000 / 1.4e9 (real failed draft, 9 Oct)", () => {
  const data = [{ cashtag: "$SKHYB", lastPriceUSDT: 173.47, priceChangePercent: -1.722, volumeUSDT: 3721456.2 }];
  assert.equal(checkG("$SKHYB moved about 3.72 million USDT.", "tokenized-stocks", data).ok, true);
  assert.equal(checkG("$SKHYB moved about 4.9 million USDT.", "tokenized-stocks", data).ok, false);
  const big = [{ cashtag: "$BTC", quoteVolume: 1.41e9 }];
  assert.equal(checkG("$BTC saw 1.4 billion USDT.", "daily-recap", big).ok, true);
});
