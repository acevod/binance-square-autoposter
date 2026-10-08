// src/generate.mjs
// Picks a theme, fetches its data, calls the LLM (Groq primary, Gemini fallback),
// returns the generated Square post text.

import {
  getMarketSnapshot,
  getLeadersLaggards,
  getBreakoutWatch,
  getQuietMovers,
  getRelativeStrength,
} from "./sources/market.mjs";
import { getTokenizedStocksSnapshot } from "./sources/tokenized-stocks.mjs";
import { getRecentThemes } from "./validate.mjs";
import { fetchWithTimeout, TIMEOUTS } from "./http.mjs";
import { factsPromptBlock } from "./facts.mjs";

export const PROMPT_VERSION = "2.0";

// NOTE: trading-signal, crypto-market-rank, and meme-rush skills are
// intentionally NOT imported here anymore. They surface tokens from
// BSC/Solana DEX activity with no guarantee those tokens are listed on
// Binance — one of those posts (via crypto-market-rank's smart-money-inflow)
// got a real compliance notice from Square for referencing a non-Binance-
// listed token. Every theme below is now built only from Binance's own
// listed USDT pairs (data-api.binance.vision), which structurally rules
// that out. The three skills are still in skills/ and still valid to use
// for manual research — just not wired into the auto-post pipeline.

// ---------------------------------------------------------------------------
// Theme registry — uniform random pick among themes that fit the time of day
// (see THEME_HOURS_WIB) and weren't used in the last few posts. All 7 themes
// pull from the same safe, Binance-listed data source, so there's no reason
// to favor some over others.
// ---------------------------------------------------------------------------
const THEMES = [
  { id: "morning-brief", fetch: () => getMarketSnapshot(), label: "Morning Market Brief" },
  { id: "leaders-laggards", fetch: () => getLeadersLaggards(), label: "Leaders & Laggards" },
  { id: "breakout-watch", fetch: () => getBreakoutWatch(), label: "Breakout Watch" },
  { id: "quiet-movers", fetch: () => getQuietMovers(), label: "The Quiet Ones" },
  { id: "relative-strength", fetch: () => getRelativeStrength(), label: "Relative Strength Check" },
  { id: "tokenized-stocks", fetch: () => getTokenizedStocksSnapshot(), label: "Tokenized Stocks Corner" },
  { id: "daily-recap", fetch: () => getMarketSnapshot(), label: "Daily Recap" },
];

const RECENT_THEMES_TO_AVOID = 4;

/**
 * Uniform random pick, excluding any theme used in the last
 * RECENT_THEMES_TO_AVOID posts. With 7 themes and at most 4 excluded,
 * there are always at least 3 left to pick from, so this never has to
 * handle an empty pool. If history is short (fresh repo) or missing
 * (recordPost never ran, or a fork that deleted data/posts.json),
 * getRecentThemes just returns fewer entries to avoid — never an error,
 * and never fewer choices than "no history at all" would give.
 */
// Themes whose wording only makes sense at certain times. Hours are WIB
// (UTC+7), start inclusive / end exclusive; a window may wrap past midnight.
// With the 6-hourly cron (07:17, 13:17, 19:17, 01:17 WIB) the morning brief
// can only go out in the morning slot and the recap only in the evening/night
// slots, and the windows are wide enough to survive GitHub's start delays.
// Themes not listed here can run at any time.
const THEME_HOURS_WIB = {
  "morning-brief": { from: 5, to: 12 },
  "daily-recap": { from: 18, to: 3 },
};

/** Does `themeId` make sense at time `now`? */
export function themeFitsTime(themeId, now = new Date()) {
  const window = THEME_HOURS_WIB[themeId];
  if (!window) return true;
  const hour = (now.getUTCHours() + 7) % 24;
  return window.from < window.to
    ? hour >= window.from && hour < window.to
    : hour >= window.from || hour < window.to;
}

/**
 * Pure selection: time-appropriate themes, minus the recently used ones.
 * If that leaves nothing, repetition is allowed before a time-inappropriate
 * theme is.
 */
export function selectTheme(recent, now = new Date(), random = Math.random) {
  const fitting = THEMES.filter((t) => themeFitsTime(t.id, now));
  const fresh = fitting.filter((t) => !recent.includes(t.id));
  const pool = fresh.length > 0 ? fresh : fitting;
  return pool[Math.floor(random() * pool.length)];
}

async function pickTheme() {
  const recent = await getRecentThemes(RECENT_THEMES_TO_AVOID);
  return selectTheme(recent);
}

// ---------------------------------------------------------------------------
// Shared style rules — anti-"AI-sounding" instructions, cashtag format, etc.
// Appended to every theme's system prompt so they don't have to repeat it.
// ---------------------------------------------------------------------------
const TONE_EXAMPLE = `
Voice to match (casual, like texting a friend an update). Style only, never
reuse its wording:

"BTC's at $84K after tapping $85.2K and sliding back to $83.1K. ETH barely
moved around $2.7K. BNB's the one giving ground, down over half a percent."

Notes: contractions, plain words, no clinical listing of every stat. End on a
concrete fact from the data, not on a mood phrase. Write a different ending
every time; stock closings are rejected by the validator.
`.trim();

const STYLE_RULES = `
Style rules (must follow):
- Tone: write like you're texting a trader friend a quick update, not
  filing a market report. Use contractions (it's, didn't, that's, BTC's).
  Casual word choices over formal ones (e.g. "dropped" not "declined",
  "barely moved" not "exhibited minimal movement").
- Skip intros like "Today the market..." — start directly from the point.
- No hedging filler ("might", "could potentially", "it's worth noting").
- No generic adjectives ("significant", "notable", "interesting").
- Vary sentence length — mix short punchy lines with longer ones.
- If mentioning multiple tokens, do NOT repeat the same sentence template
  for each one (e.g. "$X does A on B; C keeps it going" three times in a
  row with different words). Give each token a distinct structure and
  angle — one can be a short fragment, another a longer sentence, another
  can lead with the number instead of the ticker.
- Cut generic narrative filler at the end of clauses — phrases like "fuels
  the surge", "keeps momentum alive", "steady hands push it forward",
  "traders snapping up every dip". State the number and stop; don't editorialize
  around it with stock trading-blog phrasing.
- Never use an em dash (—) anywhere in the post, under any circumstance.
  Use a period, comma, or semicolon instead.
- Reference coin/token tickers using cashtag format (e.g. $BTC, $ETH, $BNB) —
  never write the coin name without the $ prefix. This is required for
  Binance Square's chart auto-detection.
- If a data entry has a "cashtag" field, use that value EXACTLY as given.
  Do NOT build a cashtag yourself from a "symbol" field (e.g. "ZECUSDT") —
  that's the raw trading pair, and writing "$ZECUSDT" glues the quote
  asset onto the ticker, which reads as one garbled word. If you need to
  mention the quote currency, write "USDT" as plain text with a space
  before it, never stuck directly after a cashtag with no space.
- Use AT MOST 3 different cashtags in the whole post. Square rejects posts
  referencing more than 3 coins. Pick the 3 most relevant and mention any
  others (if truly necessary) by plain name without the $ prefix.
- Use only the data provided below. Do not invent numbers. Do not give
  financial advice or tell people to buy/sell.
- Only mention metrics that appear in the supplied data. Do NOT bring in
  open interest, funding rates, liquidations, on-chain flows, or anything
  else that isn't in the JSON above, even as a "thing to watch".
- No predictions or directional calls ("short squeeze brewing", "reversal
  incoming", "likely to break out"). Describe what already happened.
- Never echo these style instructions inside the post (no "just the
  numbers, no fluff" or similar asides).
- No em dashes, no bullet points in the post body.
- Return ONLY the final post text, nothing else.

${TONE_EXAMPLE}
`.trim();

const THEME_PROMPTS = {
  "morning-brief": (data) => `
You are a Binance Square crypto analyst. Write a short morning market brief
using ONLY this data:
${JSON.stringify(data, null, 2)}

Cover price action for BTC, ETH, BNB over the past 24 hours: what changed
and what stood out (biggest move, widest range, heaviest volume). Describe
what happened only, nothing about what comes next. Keep it under 1600
characters.
${STYLE_RULES}`,

  "leaders-laggards": (data) => `
You are a Binance Square crypto analyst. Write a post contrasting the past
24 hours' leaders and laggards using ONLY this data:
${JSON.stringify(data, null, 2)}

"leaders" are the top gainers, "laggards" are the top losers over the past
24 hours, both drawn from the same basket of actively-traded Binance-listed
pairs. Frame
it as a contrast — who's pulling ahead vs who's falling behind — not two
separate lists. Mention AT MOST 3 tickers total combined across both sides
(e.g. 2 leaders + 1 laggard, or 1 and 2) — never more than 3 tickers in the
whole post. Keep it under 1600 characters.
${STYLE_RULES}`,

  "breakout-watch": (data) => `
You are a Binance Square crypto analyst. Write a post about tokens whose
price range has been wider than usual over the past 24 hours, using ONLY
this data:
${JSON.stringify(data, null, 2)}

Each entry has "last24hRangePct" vs "avgRangePct" (its typical daily range
over the past week). "ratio" is the first divided by the second; over 1
means a wider range than normal.
- Say it in plain language ("swung about twice its usual daily range"),
  never use the word "ratio" or any field name.
- Match the wording to the size of the gap: 1.0-1.3 is basically normal,
  don't call it a breakout; 1.3-2 is "noticeably wider"; over 2 is "much
  wider".
- Describe what happened only. No predictions, no "something's stirring",
  no hint of what comes next, no advice.
- Pick 2-3 standouts. Keep it under 1600 characters.
${STYLE_RULES}`,

  "quiet-movers": (data) => `
You are a Binance Square crypto analyst. Write a post about tokens whose
price range has been tighter than usual over the past 24 hours, using ONLY
this data:
${JSON.stringify(data, null, 2)}

Each entry has "last24hRangePct" vs "avgRangePct" (its typical daily range
over the past week). "ratio" is the first divided by the second; under 1
means a tighter range than normal.
- Say it in plain language ("about a third tighter than its usual daily
  swing"), never use the word "ratio" or any field name.
- Match the wording to the size of the gap: 0.8-1.0 is basically normal,
  don't call it quiet; 0.5-0.8 is "somewhat tighter"; under 0.5 is "much
  tighter".
- Describe what happened only. Do not say it is "coiled", "compressing",
  "brewing", or hint at a squeeze, breakout, or what comes next. No
  predictions, no advice.
- Pick 2-3 standouts. Keep it under 1600 characters.
${STYLE_RULES}`,

  "relative-strength": (data) => `
You are a Binance Square crypto analyst. Write a post comparing relative
performance across the market using ONLY this data:
${JSON.stringify(data, null, 2)}

"ethBtcChangePercent" shows whether ETH is gaining or losing ground against
BTC directly (priced in BTC, not USD). "btcChangePercent" vs
"altsMedianChangePercent" shows whether the typical (median) alt in the
most-traded basket is outperforming or underperforming BTC over the past
24 hours; "altsCount" is how many alts that median covers.
IMPORTANT: this is price performance, not capital flow data — do not say
"money is flowing into X" or "rotating into Y", since that implies volume/
flow data this doesn't measure. Say "BTC is outperforming the basket" or
"ETH is gaining relative strength against BTC" instead — describe which is
doing better, not where money is supposedly moving. Keep it under 1600
characters.
${STYLE_RULES}`,

  "tokenized-stocks": (data) => `
You are a Binance Square crypto analyst covering bStocks, Binance's tokenized
US equities that trade 24/7 as spot pairs, the same way crypto does. Write a
post using ONLY this data:
${JSON.stringify(data, null, 2)}

Rules for this theme:
- Refer to each token by its "cashtag" value EXACTLY as given (e.g. $NVDAB,
  never $NVDA). The trailing B matters: it's the tradable bStock, and only
  the exact ticker links to the right chart.
- "name" is the company it tracks; use it, don't guess company names.
- These are tokenized versions, not the shares themselves. Say "tokenized
  stock" or "bStock", never "shares", "contracts", or "the stock itself".
- Prices and volumes are in USDT; write USDT as plain text, never $USDT.
- You may say these trade 24/7 as a fact about the product. Do NOT claim the
  given move or volume happened overnight, after hours, or while US markets
  were closed: the data is a 24h total and does not show when it happened.
- Cover 2-3 tokens. Keep it under 1600 characters.
${STYLE_RULES}`,

  "daily-recap": (data) => `
You are a Binance Square crypto analyst. Write a closing daily recap using
ONLY this data:
${JSON.stringify(data, null, 2)}

Summarize what happened over the past 24 hours for BTC/ETH/BNB and name the
one thing that stood out most (biggest move, widest range, or heaviest
volume). Describe what happened only, nothing about what comes next. Keep
it under 1600 characters.
${STYLE_RULES}`,
};

// ---------------------------------------------------------------------------
// LLM calls — Groq primary, Gemini fallback.
// ---------------------------------------------------------------------------
async function callGroq(prompt) {
  const res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages: [{ role: "user", content: prompt }],
      // gpt-oss-120b always reasons — it can't be turned off — and
      // reasoning tokens share the same max_tokens budget as the final
      // answer. reasoning_effort:"low" keeps more of that budget free
      // for the actual post instead of internal chain-of-thought.
      reasoning_effort: "low",
      // Real headroom beyond the ~500-char post itself, since reasoning
      // still eats into this even at "low" effort.
      max_tokens: 4000,
      temperature: 0.5,
    }),
  }, TIMEOUTS.llm);

  if (!res.ok) throw new Error(`Groq error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const choice = json.choices?.[0];
  const content = choice?.message?.content?.trim();

  if (choice?.finish_reason === "length") {
    // Hit max_tokens before finishing — content (if any) is truncated
    // mid-sentence. Treat as a failure rather than publishing a cut-off
    // post; let the caller fall back to Gemini instead.
    console.error("Groq output truncated (finish_reason=length). Raw response:", JSON.stringify(json));
    throw new Error("Groq output truncated (hit max_tokens)");
  }

  if (!content) {
    // Log the raw response once so a future empty-output case is debuggable
    // instead of silently falling through with nothing to show for it.
    console.error("Groq returned no content. Raw response:", JSON.stringify(json));
    throw new Error("Groq returned empty content");
  }

  return content;
}

async function callGemini(prompt) {
  // API key goes in a header, not the URL, so it can never end up in logs.
  const res = await fetchWithTimeout(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 2400, temperature: 0.5 },
      }),
    },
    TIMEOUTS.llm
  );

  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const candidate = json.candidates?.[0];
  const content = candidate?.content?.parts?.[0]?.text?.trim();

  if (candidate?.finishReason === "MAX_TOKENS") {
    console.error("Gemini output truncated (finishReason=MAX_TOKENS). Raw response:", JSON.stringify(json));
    throw new Error("Gemini output truncated (hit maxOutputTokens)");
  }

  if (!content) {
    console.error("Gemini returned no content. Raw response:", JSON.stringify(json));
    throw new Error("Gemini returned empty content");
  }

  return content;
}

async function callLLM(prompt) {
  try {
    return await callGroq(prompt);
  } catch (err) {
    console.error(`Groq failed, falling back to Gemini: ${err.message}`);
    return await callGemini(prompt);
  }
}

// Deterministic cleanup applied to every LLM output BEFORE validation.
// Retrying alone wasn't enough: in a real run gpt-oss-120b used an em dash
// in 3 of 3 attempts despite the prompt banning it, so the whole day's post
// got skipped. Prompt instructions are a request, this is the guarantee.
// validate.mjs still rejects em dashes as a last-resort safety net, but
// after this step it should essentially never fire.
function sanitizeText(text) {
  return text
    // typographic characters LLMs like to emit -> plain ASCII
    .replace(/[\u2010\u2011]/g, "-") // unicode / non-breaking hyphens
    .replace(/[\u2018\u2019]/g, "'") // curly single quotes
    .replace(/[\u201C\u201D]/g, '"') // curly double quotes
    // en dash is the same AI tell as an em dash when used as a separator
    // ("average – ratio"); the model switched to it once em dashes got banned
    .replace(/(\d)\s*\u2013\s*(\$?\d)/g, "$1 to $2") // numeric range
    .replace(/\s+\u2013\s+/g, ", ")
    // em dash between two numbers is a range: "$768.34—$771.52" -> "to"
    .replace(/(\d)\s*\u2014\s*(\$?\d)/g, "$1 to $2")
    // em dash opening a line is a tacked-on aside: drop the dash itself
    .replace(/^[ \t]*\u2014[ \t]*/gm, "")
    // any other em dash reads fine as a comma
    .replace(/[ \t]*\u2014[ \t]*/g, ", ")
    // tidy punctuation the replacements can leave behind
    .replace(/,\s*,/g, ",")
    .replace(/,\s*([.!?])/g, "$1")
    // stablecoins aren't worth a cashtag and would eat into Square's
    // 3-cashtag limit (a real draft used $USDT as one of its cashtags)
    .replace(/\$(USDT|USDC|FDUSD|BUSD)\b/g, "$1")
    // trailing spaces the LLM leaves at line ends
    .replace(/[ \t]+$/gm, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------------
export async function generatePost() {
  const theme = await pickTheme();
  const data = await theme.fetch();
  if (Array.isArray(data) && data.length === 0) {
    throw new Error(`No source data for theme "${theme.id}"`);
  }
  const fetchedAt = new Date().toISOString();
  const prompt = THEME_PROMPTS[theme.id](data) + factsPromptBlock(theme.id, data);
  const text = sanitizeText(await callLLM(prompt));

  return {
    theme: theme.id,
    themeLabel: theme.label,
    text,
    rawData: data,
    fetchedAt,
    promptVersion: PROMPT_VERSION,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await generatePost();
  console.log(JSON.stringify(result, null, 2));
}
