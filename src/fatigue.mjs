// src/fatigue.mjs
// Guards against repetitive voice: hype words, stock closing phrases, and a
// closing sentence that repeats one used in recent posts. Complements the
// word-overlap duplicate check in validate.mjs, which only sees whole-post copies.

const HYPE = /\b(?:explod\w*|rocket\w*|skyrocket\w*|moon(?:ing|ed)?|parabolic|bloodbath|to\s+the\s+moon)\b/i;

// Stock closings observed repeatedly in published posts.
const STOCK_CLOSINGS = [
  /nothing\s+(?:wild|dramatic)/i,
  /no\s+big\s+drama/i,
  /quiet\s+grind/i,
  /calm\s+day/i,
  /rough\s+shuffle/i,
  /24\/7\s+grind/i,
];

const CLOSING_SIMILARITY = 0.5;
const CLOSINGS_COMPARED = 10;

function lastSentence(text) {
  const parts = text.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function wordSet(s) {
  return new Set(s.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter((w) => w.length > 2));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Texts of the most recent posts that were (or may have been) published. */
export function recentClosings(history, n = CLOSINGS_COMPARED) {
  return history
    .filter((p) => p.status !== "failed")
    .slice(0, n)
    .map((p) => lastSentence(p.text));
}

/**
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkFatigue(text, history = []) {
  const hype = text.match(HYPE);
  if (hype) return { ok: false, reason: `Hype wording ("${hype[0]}"), not allowed` };

  for (const re of STOCK_CLOSINGS) {
    const m = text.match(re);
    if (m) return { ok: false, reason: `Stock closing phrase ("${m[0]}") overused in past posts` };
  }

  const mine = wordSet(lastSentence(text));
  for (const past of recentClosings(history)) {
    if (jaccard(mine, wordSet(past)) >= CLOSING_SIMILARITY) {
      return { ok: false, reason: "Closing sentence too similar to a recent post's closing" };
    }
  }
  return { ok: true };
}
