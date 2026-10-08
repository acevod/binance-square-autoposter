import test from "node:test";
import assert from "node:assert/strict";
import { checkSemantics } from "../src/semantic.mjs";
import { checkFatigue } from "../src/fatigue.mjs";
import { buildMarketFacts, factsPromptBlock } from "../src/facts.mjs";

// Numbers from the real 7 Oct morning-brief post that said "BTC widest swing".
const OCT7 = [
  { symbol: "BTCUSDT", cashtag: "$BTC", lastPrice: 83179, priceChangePercent: -2.7, highPrice: 85619, lowPrice: 82787, volume: 20826, quoteVolume: 1.75e9 },
  { symbol: "ETHUSDT", cashtag: "$ETH", lastPrice: 2568, priceChangePercent: -4.8, highPrice: 2701, lowPrice: 2538, volume: 433322, quoteVolume: 1.13e9 },
  { symbol: "BNBUSDT", cashtag: "$BNB", lastPrice: 772.6, priceChangePercent: -0.9, highPrice: 780, lowPrice: 758, volume: 127342, quoteVolume: 9.79e7 },
];

test("facts: widest range is by % of price, volume by quote terms", () => {
  const f = buildMarketFacts(OCT7);
  assert.equal(f.widestRange.cashtag, "$ETH");
  assert.equal(f.largestQuoteVolume.cashtag, "$BTC");
  assert.equal(f.largestAbsMove.cashtag, "$ETH");
});

test("rejects 'BTC widest swing' when ETH had the widest % range (real 7 Oct post)", () => {
  const text = "$ETH had the biggest move and the biggest dollar volume, $BTC showed the widest swing, and $BNB stayed the most static.";
  const r = checkSemantics(text, "morning-brief", OCT7);
  assert.equal(r.ok, false);
  assert.match(r.reason, /widest range/);
  assert.match(r.reason, /dollar volume/);
});

test("carries the subject across clauses: '$BTC slipped..., the widest swing of the three'", () => {
  const r = checkSemantics("$BTC slipped 2.7% to $83,179, the widest swing of the three.", "morning-brief", OCT7);
  assert.equal(r.ok, false);
});

test("accepts correct superlatives", () => {
  const text = "$ETH dropped the hardest and had the widest range of the three. $BTC led on dollar volume.";
  assert.equal(checkSemantics(text, "morning-brief", OCT7).ok, true);
});

test("rejects unqualified volume ranking across assets and 'trade count'", () => {
  const r = checkSemantics("$ETH saw the heftiest volume. Trade count was 127,342 BNB.", "daily-recap", OCT7);
  assert.equal(r.ok, false);
  assert.match(r.reason, /token units/);
  assert.match(r.reason, /trade counts/);
});

const NEAR = [{ symbol: "NEARUSDT", cashtag: "$NEAR", lastPrice: 5.06, priceChangePercent: -2, last24hRangePct: 7.6, avgRangePct: 9.7, ratio: 7.6 / 9.7 }];

test("rejects 'a third tighter' when the range is only ~22% tighter (real NEAR post)", () => {
  const r = checkSemantics("$NEAR slipped 2% to $5.06. The price band was about a third tighter than usual.", "quiet-movers", NEAR);
  assert.equal(r.ok, false);
  assert.match(r.reason, /22%/);
});

test("accepts 'a third of the usual range' when ratio is ~0.35", () => {
  const data = [{ symbol: "XRPUSDT", cashtag: "$XRP", lastPrice: 2, priceChangePercent: 0.1, last24hRangePct: 1.39, avgRangePct: 4, ratio: 0.3475 }];
  assert.equal(checkSemantics("$XRP's 1.39% band is about a third of the usual 4% range.", "quiet-movers", data).ok, true);
});

const REL = { ethBtcChangePercent: -0.57, btcChangePercent: 1.37, altsMedianChangePercent: 1.78, altsCount: 19 };

test("rejects 'BTC still ahead of the broader market' when the median alt is ahead (real 4 Oct post)", () => {
  const text = "$BTC up 1.37%. The median alt gained 1.78%, so the typical alt is outperforming $BTC. $BTC's still ahead of the broader market.";
  assert.equal(checkSemantics(text, "relative-strength", REL).ok, false);
});

test("accepts a correct relative-strength read", () => {
  const text = "$BTC is up 1.37%, but the median alt gained 1.78%, so the typical alt is beating $BTC today.";
  assert.equal(checkSemantics(text, "relative-strength", REL).ok, true);
});

test("bStocks: rejects after-hours / overnight claims drawn from 24h volume", () => {
  const data = [{ symbol: "TSLABUSDT", cashtag: "$TSLAB", lastPrice: 378, priceChangePercent: -0.5, highPrice: 383, lowPrice: 370, quoteVolume: 1.6e6 }];
  const r = checkSemantics("$TSLAB slipped 0.525%. The move kept rolling through the night.", "tokenized-stocks", data);
  assert.equal(r.ok, false);
});

test("fatigue: rejects hype words and stock closings", () => {
  assert.equal(checkFatigue("$RLC exploded 126% today.").ok, false);
  assert.equal(checkFatigue("$BTC slipped 1%. Nothing wild, just a modest dip.").ok, false);
});

test("fatigue: rejects a closing that repeats a recent post's closing", () => {
  const history = [{ status: "published", text: "$BTC held $84,000 today. Altcoins were split between small gains and small losses." }];
  const r = checkFatigue("$ETH fell 2%. Altcoins were split between small gains and small losses.", history);
  assert.equal(r.ok, false);
  assert.equal(checkFatigue("$ETH fell 2%. BNB barely moved.", history).ok, true);
});

test("prompt block states verified comparisons", () => {
  const block = factsPromptBlock("morning-brief", OCT7);
  assert.match(block, /widest first: \$ETH/);
  assert.match(block, /largest volume in USDT \(quote\) terms: \$BTC/);
});

test("bare tickers without $ are attributed correctly (real 7 Oct wording)", () => {
  const text = "$BNB barely budged. Trade volume was fine. Overall, ETH had the biggest move and the biggest dollar volume, BTC showed the widest swing, and BNB stayed the most static.";
  const r = checkSemantics(text, "morning-brief", OCT7);
  assert.equal(r.ok, false);
  assert.match(r.reason, /\$BTC called the widest range/);
  assert.match(r.reason, /\$ETH called the largest dollar volume/);
  assert.doesNotMatch(r.reason, /\$BNB called the biggest move/);
});

test("relative strength: contradiction inside one sentence is caught (real 4 Oct post)", () => {
  const text = "BTC's still ahead of the broader market, but the bulk of alts are pulling a bit harder.";
  assert.equal(checkSemantics(text, "relative-strength", REL).ok, false);
});

test("relative strength: correct 'alts beating BTC' is accepted", () => {
  assert.equal(checkSemantics("The median alt gained 1.78%, so the typical alt is outperforming BTC.", "relative-strength", REL).ok, true);
});
