import test from "node:test";
import assert from "node:assert/strict";
import { validatePost } from "../src/validate.mjs";
import { useTempHistory, RECAP_DATA, GOOD_RECAP } from "./helpers.mjs";

const FILLER = " moved today while volume stayed active and the range held steady across the whole session.";

test("fabricated ticker passes shape checks but fails once rawData is supplied", async () => {
  await useTempHistory();
  const text = "$NOTREAL rose 12.3%" + FILLER;
  assert.equal((await validatePost(text, "leaders-laggards")).valid, true); // old behaviour, no rawData
  const r = await validatePost(text, "leaders-laggards", RECAP_DATA);
  assert.equal(r.valid, false);
  assert.match(r.reason, /Not grounded/);
});

test("grounded post is valid", async () => {
  await useTempHistory();
  assert.deepEqual(await validatePost(GOOD_RECAP, "daily-recap", RECAP_DATA), { valid: true });
});

test("GROUNDING_MODE=warn logs instead of rejecting", async () => {
  await useTempHistory();
  process.env.GROUNDING_MODE = "warn";
  try {
    const r = await validatePost("$NOTREAL rose 12.3%" + FILLER, "leaders-laggards", RECAP_DATA);
    assert.equal(r.valid, true);
  } finally {
    delete process.env.GROUNDING_MODE;
  }
});

test("digit tickers count toward the 3-cashtag cap", async () => {
  await useTempHistory();
  const r = await validatePost("$BTC $1INCH $1000SATS $ETH all moved" + FILLER, "leaders-laggards");
  assert.equal(r.valid, false);
  assert.match(r.reason, /Too many cashtags \(4/);
});

test("a post with only a digit ticker satisfies the cashtag requirement", async () => {
  await useTempHistory();
  assert.equal((await validatePost("$1000SATS rose 2%" + FILLER, "leaders-laggards")).valid, true);
});

test("price shorthand like $84K is not counted as a cashtag", async () => {
  await useTempHistory();
  const r = await validatePost("$BTC $ETH $BNB all near $84K, $2.7K and $775 today and the market stayed calm.", "morning-brief");
  assert.equal(r.valid, true);
});

test("'as an airdrop' is not flagged as breaking character", async () => {
  await useTempHistory();
  const r = await validatePost("$ARB popped after being floated as an airdrop candidate and volume stayed active.", "leaders-laggards");
  assert.equal(r.valid, true);
});

test("'as an AI' still is", async () => {
  await useTempHistory();
  const r = await validatePost("As an AI I cannot give advice but $BTC moved 2% today and stayed active.", "morning-brief");
  assert.equal(r.valid, false);
});

for (const phrase of ["watch the next resistance", "could signal tighter liquidity", "a squeeze is brewing"]) {
  test(`predictive wording rejected: "${phrase}"`, async () => {
    await useTempHistory();
    const r = await validatePost(`$BTC held $84,750 today, ${phrase} for the session ahead.`, "morning-brief");
    assert.equal(r.valid, false);
    assert.match(r.reason, /Predictive/);
  });
}

test("near-duplicate of a stored post is rejected", async () => {
  await useTempHistory([{ id: "1", date: "2026-10-01", theme: "daily-recap", text: GOOD_RECAP, status: "published" }]);
  const r = await validatePost(GOOD_RECAP, "daily-recap");
  assert.equal(r.valid, false);
  assert.match(r.reason, /Too similar/);
});

test("em dash and length limits", async () => {
  await useTempHistory();
  assert.equal((await validatePost("$BTC rose 2% \u2014 and stayed active across the whole session today.", "morning-brief")).valid, false);
  assert.equal((await validatePost("$BTC", "morning-brief")).valid, false);
  assert.equal((await validatePost("$BTC " + "x ".repeat(1000), "morning-brief")).valid, false);
});

test("market-regime posts pass grounding although the data has no cashtag fields (real failure, 9 Oct)", async () => {
  await useTempHistory();
  const data = { btcChangePercent: -0.56, altsMedianChangePercent: -2.95, altsCount: 19, breadthUpPct: 16, medianRangePct: 12.14, direction: "broad-down", leadership: "btc-ahead" };
  const text = "$BTC slipped 0.56%, but the typical alt fell 2.95%, so BTC held up better. Only 16% of the 19 alts finished green, and their typical 24h range was 12.14%, a wide day for a broad decline.";
  assert.deepEqual(await validatePost(text, "market-regime", data), { valid: true });
});

test("market-regime: '74% dropped' is grounded via breadthDownPct (real failure, 9 Oct, second run)", async () => {
  await useTempHistory();
  const data = { btcChangePercent: 0.68, altsMedianChangePercent: -2.03, altsCount: 19, breadthUpPct: 26, breadthDownPct: 74, medianRangePct: 10.38, direction: "broad-down", leadership: "btc-ahead" };
  const text = "$BTC nudged up 0.68% while most alts slid hard. About 74% of the 19 coins dropped, leaving just 26% in the green. The median alt fell roughly 2%, and its typical 24-hour swing was 10.38%. So $BTC held up better than the pack.";
  assert.deepEqual(await validatePost(text, "market-regime", data), { valid: true });
});
