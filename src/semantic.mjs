// src/semantic.mjs
// Checks that RELATIONSHIPS stated in a post agree with the data, which
// grounding.mjs deliberately does not do (it only matches number magnitudes).
// Conservative by design: it only judges claims it can attribute to a ticker,
// and stays silent otherwise, so it rejects wrong claims rather than style.

import { extractCashtags } from "./cashtags.mjs";
import { buildFacts, rangePct } from "./facts.mjs";

const EPS = 1e-9;

// Sentence split that keeps "$1,234.56" and "1.3" intact.
function sentences(text) {
  return text
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z$])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function clauses(sentence) {
  return sentence.split(/[,;]|\band\b|\bwhile\b|\bbut\b/i).map((c) => c.trim()).filter(Boolean);
}

// Mentions of known assets in a clause, with or without "$" ("BTC", "$BTC"),
// in order of appearance. Plain uppercase only, so "bitcoin" prose is ignored.
function mentionedAssets(clause, known) {
  const found = [];
  for (const tag of known) {
    const base = tag.slice(1);
    const re = new RegExp(`(?<![A-Za-z0-9])\\$?${base}(?![A-Za-z0-9])`, "g");
    for (const m of clause.matchAll(re)) found.push({ tag, index: m.index });
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.tag);
}

// ---- claim patterns ------------------------------------------------------
const RANGE_MOST = /\b(?:widest|broadest|wildest|biggest|largest)\s+(?:\w+\s+){0,2}(?:swing|range|band|spread)\b|\brange\s+stole\s+the\s+show\b/i;
const RANGE_LEAST = /\b(?:narrowest|tightest|smallest)\s+(?:\w+\s+){0,2}(?:swing|range|band|spread)\b/i;
const VOLUME_MOST = /\b(?:biggest|largest|heftiest|highest|heaviest|most)\s+(?:\w+\s+){0,2}(?:volume|trade\s+flow|turnover)\b|\bpumped\s+the\s+most\s+volume\b|\bchewing\s+through\s+the\s+most\s+volume\b/i;
const VOLUME_QUOTE = /\b(?:dollar|usdt|quote|notional)\b/i;
const MOVE_MOST = /\b(?:biggest|largest|sharpest)\s+(?:\w+\s+){0,2}move\b/i;
const DROP_MOST = /\b(?:biggest|largest|sharpest|steepest)\s+(?:\w+\s+){0,2}(?:drop|fall|loss|hit|decline)\b|\bdropped\s+the\s+hardest\b|\bfell\s+the\s+hardest\b/i;
const GAIN_MOST = /\b(?:biggest|largest|sharpest)\s+(?:\w+\s+){0,2}(?:gain|jump|rise|rally)\b/i;
const NO_DATA_CLAIMS = /\b(?:trade\s+count|number\s+of\s+trades|trades\s+count)\b/i;
const TIMING_CLAIMS = /\b(?:through(?:out)?\s+the\s+night|overnight|after[-\s]?hours|off[-\s]?hours|outside\s+(?:of\s+)?(?:regular\s+|normal\s+|nyse\s+|market\s+|trading\s+)+hours|after\s+(?:the\s+)?(?:regular\s+)?market\s+close|while\s+(?:regular\s+|us\s+|wall\s+street\s+)?markets?\s+(?:were|are)\s+(?:asleep|closed))\b/i;

const FRACTIONS = [
  [/\ba\s+third\b/i, 1 / 3], [/\btwo\s+thirds\b/i, 2 / 3], [/\ba\s+quarter\b/i, 0.25],
  [/\bhalf\b/i, 0.5], [/\ba\s+fifth\b/i, 0.2], [/\ba\s+tenth\b/i, 0.1],
];
const FRACTION_WORD = "(a\\s+third|two\\s+thirds|a\\s+quarter|half|a\\s+fifth|a\\s+tenth)";
const TIGHTER = new RegExp(`${FRACTION_WORD}\\s+(tighter|narrower|smaller|lower|wider|bigger|larger)\\b`, "i");
const OF_USUAL = new RegExp(`${FRACTION_WORD}\\s+of\\s+(?:its\\s+|the\\s+)?(?:usual|typical|normal|average)`, "i");
const RATIO_TOL = 0.07;

function fractionOf(str) {
  for (const [re, v] of FRACTIONS) if (re.test(str)) return v;
  return null;
}

// ---- checks ---------------------------------------------------------------
function checkSnapshot(text, facts) {
  let current = null; // most recent cashtag seen, carries across sentences
  const problems = [];
  const known = facts.cashtags;

  for (const sentence of sentences(text)) {
    for (const clause of clauses(sentence)) {
      const tags = mentionedAssets(clause, known);
      if (tags.length > 0) current = tags[tags.length - 1];
      const subject = tags.length > 0 ? tags[0] : current;

      if (RANGE_MOST.test(clause) && subject && facts.widestRange) {
        if (Math.abs(facts.rangePct[subject] - facts.widestRange.score) > EPS) {
          problems.push(`${subject} called the widest range, but ${facts.widestRange.cashtag} had it (${facts.widestRange.score.toFixed(2)}% of price)`);
        }
      }
      if (RANGE_LEAST.test(clause) && subject && facts.narrowestRange) {
        if (Math.abs(facts.rangePct[subject] - facts.narrowestRange.score) > EPS) {
          problems.push(`${subject} called the narrowest range, but ${facts.narrowestRange.cashtag} had it`);
        }
      }
      if (VOLUME_MOST.test(clause)) {
        if (!VOLUME_QUOTE.test(clause)) {
          problems.push("volume ranked without a USDT/dollar qualifier (token units are not comparable across assets)");
        } else if (subject && facts.largestQuoteVolume && subject !== facts.largestQuoteVolume.cashtag) {
          problems.push(`${subject} called the largest dollar volume, but ${facts.largestQuoteVolume.cashtag} had it`);
        }
      }
      if (MOVE_MOST.test(clause) && subject && facts.largestAbsMove && subject !== facts.largestAbsMove.cashtag) {
        problems.push(`${subject} called the biggest move, but ${facts.largestAbsMove.cashtag} had it`);
      }
      if (DROP_MOST.test(clause) && subject && facts.biggestDecliner && subject !== facts.biggestDecliner.cashtag) {
        problems.push(`${subject} called the biggest drop, but ${facts.biggestDecliner.cashtag} had it`);
      }
      if (GAIN_MOST.test(clause) && subject && facts.biggestGainer && subject !== facts.biggestGainer.cashtag) {
        problems.push(`${subject} called the biggest gain, but ${facts.biggestGainer.cashtag} had it`);
      }
    }
  }
  return problems;
}

function checkRatio(text, facts) {
  let current = null;
  const problems = [];
  const entries = Object.keys(facts.ratios);

  for (const sentence of sentences(text)) {
    const tags = [...extractCashtags(sentence)].filter((t) => entries.includes(t));
    if (tags.length > 0) current = tags[0];
    const subject = tags.length > 0 ? tags[0] : current;
    if (!subject) continue;
    const ratio = facts.ratios[subject];

    const rel = sentence.match(TIGHTER);
    if (rel) {
      const claimed = fractionOf(rel[1]);
      const wider = /wider|bigger|larger/i.test(rel[2]);
      const actual = wider ? ratio - 1 : 1 - ratio;
      if (claimed !== null && Math.abs(actual - claimed) > RATIO_TOL) {
        problems.push(`${subject}: "${rel[0]}" but the real difference is ${(actual * 100).toFixed(0)}%`);
      }
    }
    const of = sentence.match(OF_USUAL);
    if (of) {
      const claimed = fractionOf(of[1]);
      if (claimed !== null && Math.abs(ratio - claimed) > RATIO_TOL) {
        problems.push(`${subject}: "${of[0]}" but today's range is ${ratio.toFixed(2)}x its usual`);
      }
    }
  }
  return problems;
}

const MARKET = "(?:broader\\s+market|alts?|altcoins?|basket|median)";
const BTC_WORD = "(?:\\$?btc|bitcoin)";
const WIN = "(?:ahead\\s+of|outperform\\w*|beat\\w*|beating|stronger\\s+than|pulling\\s+ahead\\s+of)";
const BTC_AHEAD = new RegExp(`${BTC_WORD}(?:'s)?\\b[^.]{0,30}\\b${WIN}\\b[^.]{0,30}\\b${MARKET}`, "i");
const ALTS_AHEAD = new RegExp(`\\b${MARKET}\\b[^.]{0,30}\\b${WIN}\\b[^.]{0,20}${BTC_WORD}\\b`, "i");

function checkRelative(text, facts) {
  const problems = [];
  for (const sentence of sentences(text)) {
    for (const clause of clauses(sentence)) {
      if (BTC_AHEAD.test(clause) && !facts.btcAheadOfAlts) {
        problems.push("says BTC is ahead of the alts/market, but the median alt is not behind BTC");
      }
      if (ALTS_AHEAD.test(clause) && !facts.altsAheadOfBtc) {
        problems.push("says the alts are ahead of BTC, but the data shows otherwise");
      }
    }
  }
  return problems;
}

const ALT_LED = /\balt[-\s]?led\b/i;
const BTC_LED = /\b(?:btc|bitcoin)[-\s]?led\b/i;
const BROAD_UP = /\b(?:broad|market-?wide|across\s+the\s+board)\s+(?:rally|rebound|gains?|strength|green)\b/i;
const BROAD_DOWN = /\b(?:broad|market-?wide|across\s+the\s+board)\s+(?:sell-?off|decline|losses|weakness|red|drop)\b/i;

function checkRegime(text, facts) {
  const problems = checkRelative(text, facts);
  if (ALT_LED.test(text) && facts.leadership !== "alt-led") problems.push(`calls it alt-led, but leadership is ${facts.leadership}`);
  if (BTC_LED.test(text) && facts.leadership !== "btc-led") problems.push(`calls it BTC-led, but leadership is ${facts.leadership}`);
  if (BROAD_UP.test(text) && facts.direction !== "broad-up") problems.push(`calls it a broad rally, but direction is ${facts.direction} (${facts.breadthUpPct}% of alts up)`);
  if (BROAD_DOWN.test(text) && facts.direction !== "broad-down") problems.push(`calls it a broad sell-off, but direction is ${facts.direction} (${facts.breadthUpPct}% of alts up)`);
  return problems;
}

/**
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkSemantics(text, theme, rawData) {
  const problems = [];

  if (NO_DATA_CLAIMS.test(text)) problems.push("mentions trade counts, which the data does not contain");
  if (theme === "tokenized-stocks" && TIMING_CLAIMS.test(text)) {
    problems.push("claims activity happened overnight/after hours; 24h volume does not show when it happened");
  }

  const facts = buildFacts(theme, rawData);
  if (facts?.kind === "snapshot") problems.push(...checkSnapshot(text, facts));
  if (facts?.kind === "ratio") problems.push(...checkRatio(text, facts));
  if (facts?.kind === "relative") problems.push(...checkRelative(text, facts));
  if (facts?.kind === "regime") problems.push(...checkRegime(text, facts));

  if (problems.length > 0) {
    return { ok: false, reason: [...new Set(problems)].slice(0, 3).join("; ") };
  }
  return { ok: true };
}

export { rangePct };
