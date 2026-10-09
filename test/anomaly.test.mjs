import test from "node:test";
import assert from "node:assert/strict";
import { checkAnomaly, isThinExtreme, anomalyPromptBlock } from "../src/anomaly.mjs";
import { checkFatigue } from "../src/fatigue.mjs";

const row = (cashtag, change, quoteVolume) => ({ cashtag, priceChangePercent: change, lastPrice: 1, highPrice: 1.2, lowPrice: 0.8, quoteVolume });
const THIN = { leaders: [row("$RLC", 126, 8e6), row("$NEAR", 3.6, 90e6)], laggards: [row("$UNI", -3, 70e6)] };
const LIQUID = { leaders: [row("$SAND", 126, 62e6), row("$NEAR", 3.6, 90e6)], laggards: [] };

test("thin extreme mover is flagged for the source filter", () => {
  assert.equal(isThinExtreme(row("$RLC", 126, 8e6)), true);
  assert.equal(isThinExtreme(row("$SAND", 126, 62e6)), false);
  assert.equal(isThinExtreme(row("$NEAR", 3.6, 8e6)), false); // ordinary move, not extreme
});

test("rejects a post that features a thin extreme mover", () => {
  const r = checkAnomaly("$RLC is up 126% to $0.86 on $8 M USDT volume.", THIN);
  assert.equal(r.ok, false);
  assert.match(r.reason, /thin volume/);
});

test("ignores a thin extreme mover the post does not mention", () => {
  assert.equal(checkAnomaly("$NEAR nudged up 3.6% to $5.16.", THIN).ok, true);
});

test("liquid extreme mover needs volume/outlier context", () => {
  assert.equal(checkAnomaly("$SAND is up 126% today.", LIQUID).ok, false);
  assert.equal(checkAnomaly("$SAND is up 126% on $62 M USDT volume, a one-day outlier.", LIQUID).ok, true);
});

test("liquid extreme mover may not be given a cause", () => {
  const r = checkAnomaly("$SAND is up 126% on $62 M USDT volume because of a partnership.", LIQUID);
  assert.equal(r.ok, false);
  assert.match(r.reason, /unsupported cause/);
});

test("prompt block only appears when an extreme mover exists", () => {
  assert.match(anomalyPromptBlock(LIQUID), /\$SAND \(126\.0%\)/);
  assert.equal(anomalyPromptBlock({ leaders: [row("$NEAR", 3.6, 9e7)], laggards: [] }), "");
});

test("the real 6 Oct RLC post would have been rejected (hype wording)", () => {
  assert.equal(checkFatigue("$RLC exploded, up about 126 % to $0.8624").ok, false);
});

test("bStock rows: volumeUSDT counts as volume (a liquid extreme move is not 'thin')", () => {
  const liquid = { cashtag: "$TSLAB", priceChangePercent: 35, volumeUSDT: 50e6 };
  const thin = { cashtag: "$TSLAB", priceChangePercent: 35, volumeUSDT: 2e6 };
  assert.equal(isThinExtreme(liquid), false);
  assert.equal(isThinExtreme(thin), true);
});
