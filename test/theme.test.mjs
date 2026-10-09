import test from "node:test";
import assert from "node:assert/strict";
import { themeFitsTime, selectTheme } from "../src/generate.mjs";

// Build a Date from a WIB wall-clock hour (WIB = UTC+7).
const wib = (h, m = 0) => new Date(Date.UTC(2026, 9, 3, h - 7, m));

test("the four cron slots (WIB) get the right themes", () => {
  // 07:17 morning slot
  assert.equal(themeFitsTime("morning-brief", wib(7, 17)), true);
  assert.equal(themeFitsTime("daily-recap", wib(7, 17)), false);
  // 13:17 midday slot: neither
  assert.equal(themeFitsTime("morning-brief", wib(13, 17)), false);
  assert.equal(themeFitsTime("daily-recap", wib(13, 17)), false);
  // 19:17 evening and 01:17 night slots: recap only
  for (const h of [19, 1]) {
    assert.equal(themeFitsTime("daily-recap", wib(h, 17)), true, `recap at ${h}:17`);
    assert.equal(themeFitsTime("morning-brief", wib(h, 17)), false, `morning at ${h}:17`);
  }
});

test("windows survive a GitHub start delay of ~2 hours", () => {
  assert.equal(themeFitsTime("morning-brief", wib(9, 30)), true);
  assert.equal(themeFitsTime("daily-recap", wib(21, 30)), true);
  assert.equal(themeFitsTime("daily-recap", wib(3, 15)), false);
});

test("the recap window wraps past midnight, UTC conversion included", () => {
  assert.equal(themeFitsTime("daily-recap", new Date(Date.UTC(2026, 9, 3, 18, 17))), true); // 01:17 WIB
  assert.equal(themeFitsTime("daily-recap", new Date(Date.UTC(2026, 9, 3, 12, 17))), true); // 19:17 WIB
  assert.equal(themeFitsTime("morning-brief", new Date(Date.UTC(2026, 9, 3, 0, 17))), true); // 07:17 WIB
});

test("unrestricted themes fit at every hour", () => {
  for (let h = 0; h < 24; h++) assert.equal(themeFitsTime("leaders-laggards", wib(h)), true);
});

test("selectTheme never returns a time-inappropriate theme, over every hour and many draws", () => {
  for (let h = 0; h < 24; h++) {
    for (let i = 0; i < 50; i++) {
      const t = selectTheme([], wib(h, 17), Math.random);
      assert.equal(themeFitsTime(t.id, wib(h, 17)), true, `${t.id} picked at ${h}:17 WIB`);
    }
  }
});

test("recent themes are avoided", () => {
  for (let i = 0; i < 100; i++) {
    const t = selectTheme(["leaders-laggards", "breakout-watch", "quiet-movers", "relative-strength"], wib(13, 17));
    // the only fitting, non-recent themes at midday
    assert.ok(["tokenized-stocks", "market-regime"].includes(t.id), t.id);
  }
});

test("if every fitting theme is recent, repeating beats a mistimed theme", () => {
  const all = ["leaders-laggards", "breakout-watch", "quiet-movers", "relative-strength", "tokenized-stocks", "morning-brief", "daily-recap", "market-regime"];
  const t = selectTheme(all, wib(13, 17));
  assert.equal(themeFitsTime(t.id, wib(13, 17)), true);
});
