// src/anomaly.mjs
// Guard against amplifying extreme, thin-liquidity pumps. A +126% day on a
// small token reads as a pump promotion when a bot posts it with no context.
// Three layers: the source drops thin extremes (isThinExtreme), the prompt asks
// for context on liquid extremes (anomalyPromptBlock), and the validator
// checks the post followed it (checkAnomaly).

export const EXTREME_MOVE_PCT = 30; // |24h change| at or above this is "extreme"
export const MIN_EXTREME_QUOTE_VOLUME = 20e6; // USDT; below this an extreme move is too thin to post

const isNum = (n) => typeof n === "number" && Number.isFinite(n);

/** Every object in `data` that has a cashtag and a numeric 24h change. */
function collectRows(data, out = []) {
  if (Array.isArray(data)) {
    for (const item of data) collectRows(item, out);
  } else if (data && typeof data === "object") {
    if (typeof data.cashtag === "string" && isNum(data.priceChangePercent)) out.push(data);
    for (const value of Object.values(data)) {
      if (value && typeof value === "object") collectRows(value, out);
    }
  }
  return out;
}

// bStock rows call it volumeUSDT; basket rows call it quoteVolume.
const volumeOf = (row) => row.quoteVolume ?? row.volumeUSDT;

export const isExtreme = (row) => Math.abs(row.priceChangePercent) >= EXTREME_MOVE_PCT;

/** Extreme move on thin volume: should never be turned into a post. */
export function isThinExtreme(row) {
  return isExtreme(row) && !(isNum(volumeOf(row)) && volumeOf(row) >= MIN_EXTREME_QUOTE_VOLUME);
}

export function extremeRows(data) {
  return collectRows(data).filter(isExtreme);
}

/** Prompt block for extreme movers that did pass the liquidity filter. */
export function anomalyPromptBlock(data) {
  const rows = extremeRows(data);
  if (rows.length === 0) return "";
  const names = rows.map((r) => `${r.cashtag} (${r.priceChangePercent.toFixed(1)}%)`).join(", ");
  return `\nExtreme mover(s) in this data: ${names}.\nFor each one you mention: state its 24h USDT volume next to the move, and say plainly that a move this size in one day is an outlier. Do not explain WHY it moved (no news, catalysts, partnerships or listings; the data has no cause). No hype wording.\n`;
}

const CONTEXT_WORDS = /\b(?:volume|usdt|outlier|unusual|rare|thin|liquidity)\b/i;
const CAUSE_WORDS = /\b(?:because|due\s+to|driven\s+by|thanks\s+to|news|catalyst|announcement|partnership|listing|rumou?rs?)\b/i;

/**
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkAnomaly(text, rawData) {
  const mentioned = extremeRows(rawData).filter((r) => text.includes(r.cashtag));
  if (mentioned.length === 0) return { ok: true };

  const thin = mentioned.filter(isThinExtreme);
  if (thin.length > 0) {
    return { ok: false, reason: `Extreme move on thin volume mentioned: ${thin.map((r) => r.cashtag).join(", ")}` };
  }
  if (!CONTEXT_WORDS.test(text)) {
    return { ok: false, reason: "Extreme mover posted without volume/outlier context" };
  }
  const cause = text.match(CAUSE_WORDS);
  if (cause) {
    return { ok: false, reason: `Extreme mover with an unsupported cause ("${cause[0]}")` };
  }
  return { ok: true };
}
