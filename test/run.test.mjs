import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/run.mjs";
import { HistoryError } from "../src/validate.mjs";

const DRAFT = { theme: "daily-recap", themeLabel: "Daily Recap", text: "$BTC held $84,750 today.", rawData: [] };
const OK = { id: "1", shareLink: "l", status: "published" };
const quiet = () => {};

function harness(overrides = {}) {
  const calls = { generate: 0, validate: 0, publish: 0, sleeps: [] };
  const deps = {
    generate: async () => { calls.generate++; return DRAFT; },
    validate: async () => { calls.validate++; return { valid: true }; },
    publish: async () => { calls.publish++; return OK; },
    sleep: async (ms) => { calls.sleeps.push(ms); },
    maxAttempts: 3,
    baseDelayMs: 100,
    ...overrides,
  };
  return { calls, deps };
}

async function silently(fn) {
  const { log, error, warn } = console;
  console.log = console.error = console.warn = quiet;
  try { return await fn(); } finally { Object.assign(console, { log, error, warn }); }
}

test("happy path publishes once", async () => {
  const { calls, deps } = harness();
  const r = await silently(() => run(deps));
  assert.equal(r.exitCode, 0);
  assert.deepEqual([calls.generate, calls.publish], [1, 1]);
});

test("transient generate failure is retried with growing backoff", async () => {
  let n = 0;
  const { calls, deps } = harness({ generate: async () => { calls.generate++; if (++n < 3) throw new Error("Binance 503"); return DRAFT; } });
  const r = await silently(() => run(deps));
  assert.equal(r.exitCode, 0);
  assert.equal(calls.generate, 3);
  assert.deepEqual(calls.sleeps, [100, 200]);
});

test("generate failing every time exits 1 and never publishes", async () => {
  const { calls, deps } = harness({ generate: async () => { throw new Error("Groq and Gemini down"); } });
  const r = await silently(() => run(deps));
  assert.equal(r.exitCode, 1);
  assert.equal(calls.publish, 0);
});

test("validation failure regenerates", async () => {
  let n = 0;
  const { calls, deps } = harness({ validate: async () => (++n < 2 ? { valid: false, reason: "bad" } : { valid: true }) });
  const r = await silently(() => run(deps));
  assert.equal(r.exitCode, 0);
  assert.equal(calls.generate, 2);
});

test("all attempts invalid -> exit 1, nothing published", async () => {
  const { calls, deps } = harness({ validate: async () => ({ valid: false, reason: "bad" }) });
  const r = await silently(() => run(deps));
  assert.equal(r.exitCode, 1);
  assert.equal(calls.publish, 0);
  assert.equal(calls.generate, 3);
});

test("Square definitive rejection (e.g. 220095) regenerates and can still succeed", async () => {
  let n = 0;
  const { calls, deps } = harness({
    publish: async () => {
      calls.publish++;
      if (++n === 1) throw Object.assign(new Error("API error [220095]: too many cashtags"), { publishOutcome: "failed" });
      return OK;
    },
  });
  const r = await silently(() => run(deps));
  assert.equal(r.exitCode, 0);
  assert.equal(calls.publish, 2);
});

test("UNKNOWN publish outcome is never retried (duplicate risk)", async () => {
  const { calls, deps } = harness({
    publish: async () => { calls.publish++; throw Object.assign(new Error("Request timed out"), { publishOutcome: "unknown" }); },
  });
  const r = await silently(() => run(deps));
  assert.equal(r.exitCode, 1);
  assert.equal(calls.publish, 1);
  assert.equal(calls.generate, 1);
});

test("an error with no outcome tag is treated as unknown, not retried", async () => {
  const { calls, deps } = harness({ publish: async () => { calls.publish++; throw new Error("???"); } });
  await silently(() => run(deps));
  assert.equal(calls.publish, 1);
});

test("HistoryError is fatal and propagates", async () => {
  const { deps } = harness({ validate: async () => { throw new HistoryError("corrupt"); } });
  await assert.rejects(silently(() => run(deps)), HistoryError);
});

test("504 'unknown' result exits non-zero (so the run is not green) and is not retried", async () => {
  const { calls, deps } = harness({ publish: async () => { calls.publish++; return { id: null, shareLink: null, status: "unknown" }; } });
  const r = await silently(() => run(deps));
  assert.equal(r.exitCode, 2);
  assert.equal(calls.publish, 1);
});

test("buildMeta records provider, model, prompt version and a stable source hash", async () => {
  const { buildMeta } = await import("../src/run.mjs");
  const draft = { rawData: [{ cashtag: "$BTC", lastPrice: 1 }], fetchedAt: "2026-10-10T00:00:00.000Z", promptVersion: "2.0", provider: "gemini", model: "gemini-2.5-flash" };
  const a = buildMeta(draft);
  assert.equal(a.provider, "gemini");
  assert.equal(a.model, "gemini-2.5-flash");
  assert.equal(a.sourceFetchedAt, "2026-10-10T00:00:00.000Z");
  assert.deepEqual(a.sourceSnapshot, draft.rawData);
  assert.equal(a.sourceHash, buildMeta({ ...draft }).sourceHash);
});
