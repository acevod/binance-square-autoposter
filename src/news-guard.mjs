// src/news-guard.mjs
// Post-level checks around links and headlines.

import { extractSignificantNumbers } from "./grounding.mjs";
import { newsHeadlines } from "./sources/news.mjs";

const URL_IN_POST = /https?:\/\/|www\.|\b[a-z0-9][a-z0-9-]*\.(?:com|io|co|org|net|xyz|app|info|ai|me|gg|fi|trade|news|link|site|online|finance|exchange)\b/i;

/** Links are never allowed in a post, with or without news context. */
export function checkNoUrls(text) {
  const m = text.match(URL_IN_POST);
  return m ? { ok: false, reason: `Contains a link or web address ("${m[0]}"), not allowed` } : { ok: true };
}

const words = (s) => s.toLowerCase().replace(/[^a-z0-9$%.\s]/g, " ").split(/\s+/).filter(Boolean);

export const MAX_COPIED_WORDS = 10; // a post may not contain 10+ words in a row from a headline
export const MAX_QUOTE_WORDS = 12;

const CAUSAL = /\b(?:because|due\s+to|driven\s+by|thanks\s+to|caused\s+by|triggered\s+by|on\s+the\s+back\s+of|after\s+(?:the\s+)?(?:news|report|headline))\b/i;

/**
 * @param {string} text
 * @param {{ byToken: object } | null | undefined} news
 */
export function checkNews(text, news) {
  const headlines = newsHeadlines(news);
  if (headlines.length === 0) return { ok: true };

  // 1. copying: long word-for-word runs from a headline
  const tw = words(text);
  for (const h of headlines) {
    const hw = words(h.title);
    for (let i = 0; i + MAX_COPIED_WORDS <= hw.length; i++) {
      const run = hw.slice(i, i + MAX_COPIED_WORDS).join(" ");
      for (let j = 0; j + MAX_COPIED_WORDS <= tw.length; j++) {
        if (tw.slice(j, j + MAX_COPIED_WORDS).join(" ") === run) {
          return { ok: false, reason: `Copies ${MAX_COPIED_WORDS}+ words from a ${h.source} headline` };
        }
      }
    }
  }

  // 2. long quotes
  for (const m of text.matchAll(/"([^"]+)"|\u201c([^\u201d]+)\u201d/g)) {
    const n = words(m[1] ?? m[2]).length;
    if (n > MAX_QUOTE_WORDS) return { ok: false, reason: `Quotes ${n} words, the limit is ${MAX_QUOTE_WORDS}` };
  }

  // 3. causal wording next to a headline mention
  const outlets = [...new Set(headlines.map((h) => h.source))];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const cites = outlets.some((o) => sentence.includes(o)) || /\b(?:headline|reported|according\s+to)\b/i.test(sentence);
    if (cites && CAUSAL.test(sentence)) {
      return { ok: false, reason: "Presents a headline as the cause of a move; only timing is known" };
    }
  }
  return { ok: true };
}

/** Numbers written in the headlines, as grounding sources. */
export function headlineNumberSources(news) {
  const out = [];
  for (const h of newsHeadlines(news)) {
    for (const n of extractSignificantNumbers(h.title)) out.push({ value: n.value });
  }
  return out;
}
