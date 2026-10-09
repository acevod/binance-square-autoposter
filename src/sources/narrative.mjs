// src/sources/narrative.mjs
// Theme 9 - Data vs Narrative: set one market-wide headline next to what the
// last 24h of data actually shows. The agreement verdict is computed here in
// code, so the LLM explains it instead of deciding it.

import { fetchHeadlines, newsEnabled } from "./news.mjs";
import { getMarketRegime } from "./market.mjs";

const UP = /\b(?:rall(?:y|ies|ied)|surg(?:e|es|ed|ing)|soar(?:s|ed|ing)?|jump(?:s|ed|ing)?|climb(?:s|ed|ing)?|ris(?:e|es|en|ing)|rebound(?:s|ed|ing)?|gain(?:s|ed|ing)?|record\s+high|all-time\s+high)\b/i;
const DOWN = /\b(?:plung(?:e|es|ed|ing)|tumbl(?:e|es|ed|ing)|slump(?:s|ed|ing)?|drop(?:s|ped|ping)?|fall(?:s|ing)?|fell|slid(?:e|es|ing)|sell-?off|crash(?:es|ed|ing)?|declin(?:e|es|ed|ing)|sink(?:s|ing)?|slip(?:s|ped|ping)?)\b/i;
const MARKET_WIDE = /\b(?:Bitcoin|BTC|Ethereum|ETH|crypto(?:currency|currencies)?|crypto\s+market|market)\b/;

/** "up", "down", or null when the headline gives no single direction. */
export function headlineTone(title) {
  const up = UP.test(title);
  const down = DOWN.test(title);
  return up === down ? null : up ? "up" : "down";
}

/** Most recent market-wide headline with a single clear direction. */
export function pickNarrativeHeadline(headlines) {
  return (
    [...headlines]
      .sort((a, b) => a.ageHours - b.ageHours)
      .find((h) => MARKET_WIDE.test(h.title) && headlineTone(h.title) !== null) ?? null
  );
}

/** supports / contradicts / mixed, from BTC and the median alt only. */
export function agreement(tone, regime) {
  const { btcChangePercent: btc, altsMedianChangePercent: alts } = regime;
  const sign = tone === "up" ? 1 : -1;
  const b = Math.sign(btc) * sign;
  const a = Math.sign(alts) * sign;
  if (b > 0 && a > 0) return "supports";
  if (b < 0 && a < 0) return "contradicts";
  return "mixed";
}

export function buildNarrative(headline, regime) {
  const tone = headlineTone(headline.title);
  return {
    headline: { source: headline.source, title: headline.title, ageHours: headline.ageHours },
    headlineTone: tone,
    regime,
    agreement: agreement(tone, regime),
  };
}

/** Empty array = "nothing to post today", which generatePost skips cleanly. */
export async function getDataVsNarrative({ fetchImpl = fetchHeadlines, regimeImpl = getMarketRegime } = {}) {
  if (!newsEnabled()) return [];
  let headline;
  try {
    headline = pickNarrativeHeadline(await fetchImpl());
  } catch (err) {
    console.error(`narrative headline skipped: ${err.message}`);
    return [];
  }
  if (!headline) return [];
  return buildNarrative(headline, await regimeImpl());
}
