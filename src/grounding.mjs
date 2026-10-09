// src/grounding.mjs
// Checks that a generated post only talks about tickers and numbers that
// actually exist in the data the LLM was given. The LLM is instructed not to
// invent anything, but that is a request; this is the enforcement.
//
// Scope and limits (be honest about what this does NOT catch):
//  - Cashtags must be in the source data (exact match).
//  - Every "significant" number must match a source number (or one derived
//    from it) within one unit of the last digit the post shows. That allows
//    rounding AND truncation ("1.21%" for 1.2118) but not invention.
//  - Numbers are compared by magnitude only (sign ignored: "down 1.2%" matches
//    -1.2). A number can still match an unrelated field with the same value.
//  - Words ("about twice its usual range") and wrong relationships between
//    real numbers are not checked.

import { extractCashtags, stripCashtags } from "./cashtags.mjs";

// Tickers that are legitimate in a theme even though they have no `cashtag`
// field in that theme's data (relative-strength is computed from BTC and ETH).
const THEME_EXTRA_CASHTAGS = {
  "relative-strength": ["$BTC", "$ETH"],
  // regime data is a computed summary (BTC vs the alts as a group), no per-asset rows
  "market-regime": ["$BTC"],
};

const SUFFIX_MULT = { k: 1e3, m: 1e6, b: 1e9, thousand: 1e3, million: 1e6, billion: 1e9 };

/** All cashtag fields found anywhere in the source data. */
export function collectSourceCashtags(data, out = new Set()) {
  if (Array.isArray(data)) {
    for (const item of data) collectSourceCashtags(item, out);
  } else if (data && typeof data === "object") {
    if (typeof data.cashtag === "string") out.add(data.cashtag.toUpperCase());
    for (const value of Object.values(data)) collectSourceCashtags(value, out);
  }
  return out;
}

/** Every finite numeric leaf in the source data, plus a few derived values. */
export function collectSourceNumbers(data, out = []) {
  if (Array.isArray(data)) {
    for (const item of data) collectSourceNumbers(item, out);
  } else if (data && typeof data === "object") {
    for (const value of Object.values(data)) {
      if (typeof value === "number" && Number.isFinite(value)) out.push(Math.abs(value));
      else collectSourceNumbers(value, out);
    }
    // Derived: 24h range as % of price (the post may state it for themes
    // whose data only carries high/low/last).
    const last = data.lastPrice ?? data.lastPriceUSDT;
    if (Number.isFinite(data.highPrice) && Number.isFinite(data.lowPrice) && last > 0) {
      out.push(((data.highPrice - data.lowPrice) / last) * 100);
    }
    // Derived: "about a third tighter / 35% wider" comes from the ratio.
    if (Number.isFinite(data.ratio)) out.push(Math.abs(data.ratio - 1) * 100);
  }
  return out;
}

// $1,234.56 | 12.3% | 1.42 B | 1.42 billion | 3.72 million | 12.8k | 0.00583
const NUMBER_RE = /(\$)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(\s?%|\s?(?:thousand|million|billion)\b|\s?[KkMmBb](?![A-Za-z]))?/g;

/** Numbers in `text` that the grounding check cares about. */
export function extractSignificantNumbers(text) {
  const clean = stripCashtags(text);
  const found = [];
  for (const m of clean.matchAll(NUMBER_RE)) {
    const [raw, dollar, digits, suffix] = m;
    const end = m.index + raw.length;
    // "24h", "1st": a number glued to letters is not a quantity.
    if (!suffix && /[A-Za-z]/.test(clean[end] ?? "")) continue;

    const isPercent = suffix?.trim() === "%";
    const mult = suffix && !isPercent ? SUFFIX_MULT[suffix.trim().toLowerCase()] : 1;
    const decimals = digits.includes(".") ? digits.split(".")[1].length : 0;
    const value = Number(digits.replace(/,/g, "")) * mult;

    // Small bare integers are counts and durations ("3 tokens", "24 hours").
    const bare = !dollar && !isPercent && !suffix && decimals === 0 && !digits.includes(",");
    if (bare && value <= 100) continue;

    found.push({ raw: raw.trim(), value, unit: Math.pow(10, -decimals) * mult });
  }
  return found;
}

function isGrounded({ value, unit }, sources) {
  const tolerance = unit * 1.0001; // one unit of the last shown digit
  return sources.some((s) => Math.abs(s - value) <= tolerance);
}

/**
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkGrounding(text, theme, rawData) {
  const allowed = collectSourceCashtags(rawData);
  for (const extra of THEME_EXTRA_CASHTAGS[theme] ?? []) allowed.add(extra);

  if (allowed.size === 0) {
    return { ok: false, reason: "No source data to ground the post against" };
  }

  const unknownTags = [...extractCashtags(text)].filter((t) => !allowed.has(t));
  if (unknownTags.length > 0) {
    return { ok: false, reason: `Cashtag not in source data: ${unknownTags.join(", ")}` };
  }

  const sources = collectSourceNumbers(rawData);
  const ungrounded = extractSignificantNumbers(text).filter((n) => !isGrounded(n, sources));
  if (ungrounded.length > 0) {
    return {
      ok: false,
      reason: `Number(s) not traceable to source data: ${ungrounded.map((n) => n.raw).join(", ")}`,
    };
  }

  return { ok: true };
}
