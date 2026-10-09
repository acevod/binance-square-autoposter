import test from "node:test";
import assert from "node:assert/strict";
import { headlineTone, pickNarrativeHeadline, agreement, buildNarrative, getDataVsNarrative } from "../src/sources/narrative.mjs";
import { checkSemantics } from "../src/semantic.mjs";
import { factsPromptBlock } from "../src/facts.mjs";
import { selectTheme } from "../src/generate.mjs";
import { validatePost } from "../src/validate.mjs";
import { useTempHistory } from "./helpers.mjs";

const H = (title, ageHours = 2, source = "CoinDesk") => ({ source, title, ageHours });
const REGIME = { btcChangePercent: -0.56, altsMedianChangePercent: -2.95, altsCount: 19, breadthUpPct: 16, breadthDownPct: 84, medianRangePct: 12.14, direction: "broad-down", leadership: "btc-ahead" };

test("headlineTone: single direction only", () => {
  assert.equal(headlineTone("Bitcoin rallies toward a new record high"), "up");
  assert.equal(headlineTone("Crypto market slumps as traders sell off"), "down");
  assert.equal(headlineTone("Bitcoin rallies then slumps in volatile session"), null); // both
  assert.equal(headlineTone("Bitcoin ETF issuer files updated paperwork"), null); // neither
});

test("pickNarrativeHeadline: freshest market-wide headline with a clear tone", () => {
  const hs = [H("Some small token surges after exchange listing today", 1), H("Bitcoin slides as the crypto market turns risk averse", 5), H("Ethereum jumps as network upgrade nears", 3)];
  assert.equal(pickNarrativeHeadline(hs).title, "Ethereum jumps as network upgrade nears");
  assert.equal(pickNarrativeHeadline([H("Exchange adds new staking product for users", 1)]), null);
});

test("agreement is computed from BTC and the median alt", () => {
  assert.equal(agreement("down", REGIME), "supports");
  assert.equal(agreement("up", REGIME), "contradicts");
  assert.equal(agreement("up", { btcChangePercent: 0.7, altsMedianChangePercent: -2 }), "mixed");
});

test("getDataVsNarrative returns [] when news is off, when feeds fail, or when no headline fits", async () => {
  delete process.env.NEWS_CONTEXT;
  assert.deepEqual(await getDataVsNarrative({ fetchImpl: async () => [H("Bitcoin surges to a new high today", 1)], regimeImpl: async () => REGIME }), []);
  process.env.NEWS_CONTEXT = "on";
  const log = console.error; console.error = () => {};
  try {
    assert.deepEqual(await getDataVsNarrative({ fetchImpl: async () => { throw new Error("x"); }, regimeImpl: async () => REGIME }), []);
    assert.deepEqual(await getDataVsNarrative({ fetchImpl: async () => [H("Exchange adds new staking product", 1)], regimeImpl: async () => REGIME }), []);
    const ok = await getDataVsNarrative({ fetchImpl: async () => [H("Bitcoin slides as crypto market turns cautious", 2)], regimeImpl: async () => REGIME });
    assert.equal(ok.agreement, "supports");
    assert.equal(ok.headline.source, "CoinDesk");
  } finally { delete process.env.NEWS_CONTEXT; console.error = log; }
});

test("the theme only takes part in selection when NEWS_CONTEXT=on", () => {
  const pick = () => selectTheme([], new Date("2026-10-10T06:00:00Z"), () => 0.999);
  delete process.env.NEWS_CONTEXT;
  for (let i = 0; i < 20; i++) assert.notEqual(selectTheme([], new Date(), () => i / 20).id, "data-vs-narrative");
  process.env.NEWS_CONTEXT = "on";
  try {
    const ids = new Set(Array.from({ length: 40 }, (_, i) => selectTheme([], new Date("2026-10-10T06:00:00Z"), () => i / 40).id));
    assert.ok(ids.has("data-vs-narrative"));
    assert.ok(pick());
  } finally { delete process.env.NEWS_CONTEXT; }
});

const DATA = buildNarrative(H("Crypto market slumps as traders sell off"), REGIME);

test("semantic: verdict claims must match the computed agreement", () => {
  assert.equal(DATA.agreement, "supports");
  const right = "CoinDesk reported a crypto slump, and the data backs it up: $BTC fell 0.56% and the median alt fell 2.95%.";
  assert.equal(checkSemantics(right, "data-vs-narrative", DATA).ok, true);
  const wrong = "CoinDesk reported a crypto slump, but the data contradicts it: $BTC fell 0.56%.";
  const r = checkSemantics(wrong, "data-vs-narrative", DATA);
  assert.equal(r.ok, false);
  assert.match(r.reason, /contradicts the headline/);
  const mixed = buildNarrative(H("Bitcoin rallies as crypto market recovers"), { ...REGIME, btcChangePercent: 0.4 });
  assert.equal(mixed.agreement, "mixed");
  assert.equal(checkSemantics("The numbers support the headline: $BTC rose 0.4%.", "data-vs-narrative", mixed).ok, false);
});

test("prompt block states the verdict in plain words", () => {
  const block = factsPromptBlock("data-vs-narrative", DATA);
  assert.match(block, /verdict: the 24h data SUPPORTS/);
  assert.match(block, /a broad decline \(16% of alts are up\)/);
});

test("end to end through validatePost: attributed, grounded, no link", async () => {
  await useTempHistory();
  const news = { byToken: { market: [DATA.headline] } };
  const text = "CoinDesk reported that the crypto market slumped, and the 24h data backs it up. $BTC slipped 0.56% while the median alt fell 2.95%, with only 16% of the 19 alts finished green.";
  assert.deepEqual(await validatePost(text, "data-vs-narrative", DATA, { news }), { valid: true });
  const link = text + " Source: coindesk.com";
  assert.equal((await validatePost(link, "data-vs-narrative", DATA, { news })).valid, false);
});
