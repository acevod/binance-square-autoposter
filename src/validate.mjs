// src/validate.mjs
// Validates LLM-generated text before it's allowed anywhere near publish.mjs,
// and owns the post history file (data/posts.json).
//
// Square's exact character cap isn't documented anywhere official (only
// error code 20013 "Content length is limited"), but it's been confirmed
// empirically at 1900 characters. MAX_LENGTH below sits under that with a
// small safety margin, since it's unclear whether Square counts raw
// characters or something like UTF-16 code units (which would differ for
// any surrogate-pair characters, e.g. some emoji).

import { readFile, mkdir, rename, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { extractCashtags } from "./cashtags.mjs";
import { checkSemantics } from "./semantic.mjs";
import { checkFatigue } from "./fatigue.mjs";
import { checkGrounding } from "./grounding.mjs";

const MAX_LENGTH = 1850; // confirmed limit is 1900; prompts target 1600
const MIN_LENGTH = 40; // catches empty/near-empty LLM output
// Square rejects posts with too many distinct cashtags (error 220095,
// undocumented in the skill — discovered via a real failed post referencing
// $BTC/$ETH/$BNB/$USDT). 3 is confirmed safe; not confirmed as the exact
// ceiling, so treat this as a conservative cap, not a verified max.
const MAX_CASHTAGS = 3;
const HISTORY_KEEP = 30; // how many past posts to compare against for duplicates
const DUPLICATE_SIMILARITY_THRESHOLD = 0.6; // word-overlap ratio

// HISTORY_PATH (env) lets tests point at a temp file. Resolved lazily and
// relative to this module, so the result doesn't depend on the cwd.
function historyPath() {
  return process.env.HISTORY_PATH ?? fileURLToPath(new URL("../data/posts.json", import.meta.url));
}

// Phrases that indicate the LLM broke character (refusals, meta-commentary,
// disclaimers) instead of returning a clean post.
const BREAK_CHARACTER_PATTERNS = [
  /\bas an ai\b/i, // word boundaries: "as an airdrop" is legitimate crypto talk
  /i cannot/i,
  /i'm unable to/i,
  /language model/i,
  /^note:/im,
  /^disclaimer:/im,
  /here('s| is) (a|the) post/i, // LLM prefacing instead of just returning the post
  /\bno fluff\b/i, // echoing the style prompt back as text
  /\bjust the numbers\b/i,
];

function normalizeForComparison(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s$]/g, "")
    .split(/\s+/)
    .filter(Boolean);
}

function wordOverlapRatio(a, b) {
  const setA = new Set(normalizeForComparison(a));
  const setB = new Set(normalizeForComparison(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const word of setA) if (setB.has(word)) shared++;
  return shared / Math.min(setA.size, setB.size);
}

// ---------------------------------------------------------------------------
// History storage
// ---------------------------------------------------------------------------

/** Thrown when posts.json exists but can't be trusted. Never swallowed. */
export class HistoryError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "HistoryError";
  }
}

function assertHistoryShape(history) {
  if (!Array.isArray(history)) {
    throw new HistoryError("posts.json must contain a JSON array");
  }
  history.forEach((entry, i) => {
    if (!entry || typeof entry.theme !== "string" || typeof entry.text !== "string") {
      throw new HistoryError(`posts.json entry ${i} is malformed (needs string "theme" and "text")`);
    }
  });
}

/**
 * Missing file = first run = empty history. Anything else (unreadable file,
 * invalid JSON, wrong shape) is a hard error: silently treating a corrupt
 * file as "no history" would disable duplicate protection and let the next
 * write overwrite every past entry.
 */
export async function loadHistory() {
  let raw;
  try {
    raw = await readFile(historyPath(), "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw new HistoryError(`Cannot read posts.json: ${err.message}`, { cause: err });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new HistoryError(`posts.json is not valid JSON, refusing to continue: ${err.message}`, { cause: err });
  }
  assertHistoryShape(parsed);
  return parsed;
}

/** Atomic write: temp file + fsync + rename, so a crash can't leave a half-written file. */
async function saveHistory(history) {
  const file = historyPath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(`${JSON.stringify(history, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

/**
 * Theme ids from the N most recent posts (newest first in storage).
 * Posts known to have failed are skipped: they never reached Square, so the
 * theme isn't "used". Returns fewer than N (down to an empty array) if
 * history is short or missing.
 */
export async function getRecentThemes(n = 4) {
  const history = await loadHistory();
  return history
    .filter((entry) => entry.status !== "failed")
    .slice(0, n)
    .map((entry) => entry.theme);
}

/**
 * Validate generated text. Returns { valid: true } or
 * { valid: false, reason: string } for anything wrong with the TEXT.
 * It still throws HistoryError if posts.json is corrupt, on purpose: that's
 * an infrastructure problem, not something a regeneration can fix.
 *
 * `rawData` is the source data the LLM was given. When supplied, every
 * cashtag and significant number must trace back to it (see grounding.mjs).
 * GROUNDING_MODE=warn logs grounding failures instead of rejecting, useful
 * while rolling this out.
 */
export async function validatePost(text, theme, rawData) {
  if (!text || typeof text !== "string") {
    return { valid: false, reason: "Empty or non-string output from LLM" };
  }

  const trimmed = text.trim();

  if (trimmed.length < MIN_LENGTH) {
    return { valid: false, reason: `Too short (${trimmed.length} chars)` };
  }

  if (trimmed.length > MAX_LENGTH) {
    return { valid: false, reason: `Too long (${trimmed.length} chars, max ${MAX_LENGTH})` };
  }

  for (const pattern of BREAK_CHARACTER_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { valid: false, reason: `Broke character, matched pattern: ${pattern}` };
    }
  }

  // Em dash is explicitly forbidden in the prompt but the LLM has ignored
  // it in a real published post — enforce it here instead of trusting it.
  if (/—/.test(trimmed) || /\s–\s/.test(trimmed)) {
    return { valid: false, reason: "Contains an em/en dash used as a separator, forbidden by style rules" };
  }

  // Directional/predictive wording that reads like a call, even when framed
  // as "watching". Real drafts said "something brewing", "keep an eye on the
  // squeeze", and (published) "watch the next resistance" / "could signal".
  const predictive = trimmed.match(
    /\b(squeeze|brewing|coiled|resistance|about to (?:break|move|explode|pump|dump)|set to (?:break|move|explode)|imminent|(?:could|may|might) signal|watch the next)\b/i
  );
  if (predictive) {
    return { valid: false, reason: `Predictive language ("${predictive[0]}"), not allowed` };
  }

  // Cashtag check: any theme discussing tokens should reference at least
  // one $TICKER — catches the LLM writing "Bitcoin" instead of "$BTC", or
  // a downstream step accidentally stripping the $ prefix.
  const cashtagThemes = [
    "morning-brief",
    "leaders-laggards",
    "breakout-watch",
    "quiet-movers",
    "relative-strength",
    "tokenized-stocks",
    "daily-recap",
  ];
  const cashtags = extractCashtags(trimmed);

  if (cashtagThemes.includes(theme) && cashtags.size === 0) {
    return { valid: false, reason: "No $CASHTAG found in output" };
  }

  if (cashtags.size > MAX_CASHTAGS) {
    return {
      valid: false,
      reason: `Too many cashtags (${cashtags.size}: ${[...cashtags].join(", ")}), Square rejects over ${MAX_CASHTAGS}`,
    };
  }

  if (rawData !== undefined) {
    const grounding = checkGrounding(trimmed, theme, rawData);
    if (!grounding.ok) {
      if (process.env.GROUNDING_MODE === "warn") {
        console.warn(`[grounding:warn] ${grounding.reason}`);
      } else {
        return { valid: false, reason: `Not grounded in source data: ${grounding.reason}` };
      }
    }
  }

  if (rawData !== undefined) {
    const semantic = checkSemantics(trimmed, theme, rawData);
    if (!semantic.ok) {
      if (process.env.SEMANTIC_MODE === "warn") {
        console.warn(`[semantic:warn] ${semantic.reason}`);
      } else {
        return { valid: false, reason: `Contradicts source data: ${semantic.reason}` };
      }
    }
  }

  const history = await loadHistory();

  for (const past of history) {
    const similarity = wordOverlapRatio(trimmed, past.text);
    if (similarity >= DUPLICATE_SIMILARITY_THRESHOLD) {
      return {
        valid: false,
        reason: `Too similar (${Math.round(similarity * 100)}%) to a post from ${past.date}`,
      };
    }
  }

  const fatigue = checkFatigue(trimmed, history);
  if (!fatigue.ok) {
    return { valid: false, reason: fatigue.reason };
  }

  return { valid: true };
}

/**
 * Add a post to history and return the stored entry (with its `id`).
 * status: "pending" (about to publish) | "published" | "unknown" | "failed".
 */
export async function recordPost({ theme, text, postId, shareLink, status = "published", meta }) {
  const history = await loadHistory();
  const entry = {
    id: randomUUID(),
    date: new Date().toISOString(),
    theme,
    text,
    status,
    postId: postId ?? null,
    shareLink: shareLink ?? null,
    ...(meta ? { meta } : {}),
  };
  history.unshift(entry);
  await saveHistory(history.slice(0, HISTORY_KEEP));
  return entry;
}

/** Patch an existing entry by id (e.g. pending -> published). */
export async function updatePost(id, patch) {
  const history = await loadHistory();
  const entry = history.find((e) => e.id === id);
  if (!entry) throw new HistoryError(`History entry ${id} not found`);
  Object.assign(entry, patch);
  await saveHistory(history);
  return entry;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sample = process.argv[2] ?? "test $BTC post under length";
  const result = await validatePost(sample, "morning-brief");
  console.log(JSON.stringify(result, null, 2));
}
