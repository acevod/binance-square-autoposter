// src/facts.mjs
// Deterministic comparisons computed in code, so the LLM never has to decide
// "who had the widest range" or "who is ahead" on its own. The same facts feed
// both the prompt (as ground truth) and the semantic validator.

const EPS = 1e-9;

const isNum = (n) => typeof n === "number" && Number.isFinite(n);

/** 24h range as a percentage of the last price. */
export function rangePct(row) {
  return ((row.highPrice - row.lowPrice) / row.lastPrice) * 100;
}

function pickBy(rows, score, dir) {
  let best = null;
  for (const r of rows) {
    const s = score(r);
    if (!isNum(s)) continue;
    if (best === null || (dir === "max" ? s > best.score : s < best.score)) {
      best = { cashtag: r.cashtag, score: s };
    }
  }
  return best;
}

/**
 * Facts for snapshot-style data (BTC/ETH/BNB tickers, bStocks).
 * Returns null when there is nothing to compare (fewer than 2 usable rows).
 */
// bStock rows use lastPriceUSDT / volumeUSDT instead of lastPrice / quoteVolume.
function normalize(r) {
  if (!r || typeof r !== "object") return r;
  return { ...r, lastPrice: r.lastPrice ?? r.lastPriceUSDT, quoteVolume: r.quoteVolume ?? r.volumeUSDT };
}

export function buildMarketFacts(data) {
  if (!Array.isArray(data)) return null;
  const rows = data.map(normalize).filter(
    (r) => r && typeof r.cashtag === "string" && isNum(r.lastPrice) && r.lastPrice > 0 &&
      isNum(r.highPrice) && isNum(r.lowPrice) && isNum(r.priceChangePercent)
  );
  if (rows.length < 2) return null;

  const hasVolume = rows.every((r) => isNum(r.quoteVolume));
  return {
    kind: "snapshot",
    cashtags: rows.map((r) => r.cashtag),
    rangePct: Object.fromEntries(rows.map((r) => [r.cashtag, rangePct(r)])),
    widestRange: pickBy(rows, rangePct, "max"),
    narrowestRange: pickBy(rows, rangePct, "min"),
    largestAbsMove: pickBy(rows, (r) => Math.abs(r.priceChangePercent), "max"),
    biggestGainer: pickBy(rows, (r) => r.priceChangePercent, "max"),
    biggestDecliner: pickBy(rows, (r) => r.priceChangePercent, "min"),
    largestQuoteVolume: hasVolume ? pickBy(rows, (r) => r.quoteVolume, "max") : null,
  };
}

/** Facts for breakout/quiet data: how much tighter or wider than normal. */
export function buildRatioFacts(data) {
  if (!Array.isArray(data)) return null;
  const rows = data.filter((r) => r && typeof r.cashtag === "string" && isNum(r.ratio) && r.ratio > 0);
  if (rows.length === 0) return null;
  return {
    kind: "ratio",
    ratios: Object.fromEntries(rows.map((r) => [r.cashtag, r.ratio])),
  };
}

/** Facts for the relative-strength theme. */
export function buildRelativeFacts(data) {
  if (!data || Array.isArray(data)) return null;
  const { btcChangePercent: btc, altsMedianChangePercent: alts, ethBtcChangePercent: ethBtc } = data;
  if (!isNum(btc) || !isNum(alts)) return null;
  return {
    kind: "relative",
    btcChange: btc,
    altsMedianChange: alts,
    ethBtcChange: isNum(ethBtc) ? ethBtc : null,
    btcAheadOfAlts: btc > alts + EPS,
    altsAheadOfBtc: alts > btc + EPS,
  };
}

/** Facts for the market-regime theme (labels are computed in market.mjs). */
export function buildRegimeFacts(data) {
  if (!data || Array.isArray(data) || !isNum(data.btcChangePercent) || !isNum(data.altsMedianChangePercent)) return null;
  return {
    kind: "regime",
    btcChange: data.btcChangePercent,
    altsMedianChange: data.altsMedianChangePercent,
    breadthUpPct: data.breadthUpPct,
    direction: data.direction,
    leadership: data.leadership,
    btcAheadOfAlts: data.btcChangePercent > data.altsMedianChangePercent + EPS,
    altsAheadOfBtc: data.altsMedianChangePercent > data.btcChangePercent + EPS,
  };
}

/** Picks the right builder for the data shape. */
export function buildFacts(theme, data) {
  if (theme === "market-regime") return buildRegimeFacts(data);
  if (theme === "relative-strength") return buildRelativeFacts(data);
  if (theme === "breakout-watch" || theme === "quiet-movers") return buildRatioFacts(data);
  return buildMarketFacts(data);
}

const fmt = (n) => `${n.toFixed(2)}%`;

/** Prompt block that states the verified comparisons. Empty string if none. */
export function factsPromptBlock(theme, data) {
  const f = buildFacts(theme, data);
  if (!f) return "";
  const lines = [];
  if (f.kind === "snapshot") {
    const ranked = Object.entries(f.rangePct).sort((a, b) => b[1] - a[1]);
    lines.push(`- 24h range as % of price, widest first: ${ranked.map(([k, v]) => `${k} ${fmt(v)}`).join(", ")}`);
    if (f.largestAbsMove) lines.push(`- largest absolute price change: ${f.largestAbsMove.cashtag}`);
    if (f.largestQuoteVolume) lines.push(`- largest volume in USDT (quote) terms: ${f.largestQuoteVolume.cashtag}`);
    lines.push("- volume in token units cannot be compared across different assets; do not rank it");
  } else if (f.kind === "ratio") {
    for (const [k, r] of Object.entries(f.ratios)) {
      const pct = Math.abs(1 - r) * 100;
      lines.push(`- ${k}: today's range is ${r < 1 ? `${pct.toFixed(0)}% tighter` : `${pct.toFixed(0)}% wider`} than its 7-day average (${r.toFixed(2)}x)`);
    }
  } else if (f.kind === "relative") {
    lines.push(`- BTC ${fmt(f.btcChange)} vs median alt ${fmt(f.altsMedianChange)}: ${f.btcAheadOfAlts ? "BTC is ahead of the median alt" : f.altsAheadOfBtc ? "the median alt is ahead of BTC" : "level"}`);
  }
  if (f.kind === "regime") {
    const dir = { "broad-up": "a broad rise", "broad-down": "a broad decline", mixed: "a mixed day" }[f.direction];
    const lead = {
      "alts-ahead": "the typical alt did BETTER than BTC (on a down day: fell less)",
      "btc-ahead": "BTC did BETTER than the typical alt (on a down day: fell less)",
      "in-line": "BTC and the typical alt did about the same",
    }[f.leadership];
    lines.push(`- direction: ${dir} (${f.breadthUpPct}% of alts are up)`);
    lines.push(`- relative: ${lead} (BTC ${fmt(f.btcChange)} vs median alt ${fmt(f.altsMedianChange)})`);
    lines.push('- say these in plain words; never write the tokens "broad-up", "broad-down", "alts-ahead", "btc-ahead" or "in-line", and never say "led the drop" (ambiguous)');
    lines.push("- do not call it risk-on/risk-off (the data has no sentiment or flow)");
  }
  return `\nVerified comparisons (computed by code; use exactly as stated or leave out, never contradict):\n${lines.join("\n")}\n- The data has no trade counts; never write "trade count" or "number of trades".\n`;
}
