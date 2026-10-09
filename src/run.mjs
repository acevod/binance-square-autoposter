// src/run.mjs
// Entry point called by the GitHub Actions workflow.
// generate -> validate -> publish, with retries where a retry is SAFE.
//
// What gets retried (each costs one of MAX_ATTEMPTS):
//   - invalid text (validation failure)       -> regenerate
//   - transient generate failure (network,    -> back off, regenerate
//     LLM outage, thin source data)
//   - Square definitively rejected the post   -> regenerate (nothing was posted)
// What is NEVER retried:
//   - publish outcome unknown (timeout, 502, 504): the post may be live, and
//     publishing again could duplicate it
//   - HistoryError (corrupt posts.json): regenerating cannot fix it

import { generatePost } from "./generate.mjs";
import { validatePost, HistoryError } from "./validate.mjs";
import { publishPost } from "./publish.mjs";
import { createHash } from "node:crypto";

export const VALIDATOR_VERSION = "2.0";

// Audit trail stored with each history entry: lets a published number be
// traced back to the exact source data and settings that produced it.
export function buildMeta(draft) {
  const json = JSON.stringify(draft.rawData ?? null);
  return {
    sourceHash: createHash("sha256").update(json).digest("hex").slice(0, 16),
    sourceSnapshot: json.length <= 4000 ? draft.rawData : undefined,
    sourceFetchedAt: draft.fetchedAt,
    promptVersion: draft.promptVersion,
    provider: draft.provider,
    model: draft.model,
    validatorVersion: VALIDATOR_VERSION,
  };
}

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 5_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs the pipeline. Returns { exitCode, result? }; never throws for
 * expected failures. Dependencies are injectable for tests.
 */
export async function run({
  generate = generatePost,
  validate = validatePost,
  publish = publishPost,
  sleep = defaultSleep,
  maxAttempts = MAX_ATTEMPTS,
  baseDelayMs = Number(process.env.RETRY_DELAY_MS ?? BASE_DELAY_MS),
} = {}) {
  let lastFailure = "unknown";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`--- Attempt ${attempt}/${maxAttempts} ---`);
    const isLast = attempt === maxAttempts;

    // 1. generate (can fail transiently: Binance, Groq+Gemini, thin data)
    let draft;
    try {
      draft = await generate();
    } catch (err) {
      lastFailure = `generate failed: ${err.message}`;
      console.error(lastFailure);
      if (!isLast) {
        const delay = baseDelayMs * attempt;
        console.error(`Retrying in ${delay}ms...\n`);
        await sleep(delay);
      }
      continue;
    }

    const { theme, themeLabel, text, rawData } = draft;
    console.log(`Theme: ${themeLabel} (${theme})`);
    console.log(`Draft:\n${text}\n`);

    // 2. validate (HistoryError propagates: it's infrastructure, not text)
    const validation = await validate(text, theme, rawData);
    if (!validation.valid) {
      lastFailure = `validation failed: ${validation.reason}`;
      console.error(`Validation failed: ${validation.reason}`);
      if (!isLast) console.error("Regenerating...\n");
      continue;
    }

    // 3. publish
    try {
      const result = await publish({ theme, text, meta: buildMeta(draft) });
      console.log(`Published on attempt ${attempt}. status=${result.status} id=${result.id ?? "n/a"} link=${result.shareLink ?? "n/a"}`);
      if (result.status === "unknown") {
        // Non-zero on purpose: the run must not look green. The post is probably
        // live (so we never retry), but it is unconfirmed and a human must check.
        console.error("::error::Square returned 504: post probably went through but is NOT confirmed. Check Square manually.");
        return { exitCode: 2, result };
      }
      return { exitCode: 0, result };
    } catch (err) {
      if (err instanceof HistoryError) throw err;
      if (err.publishOutcome === "failed") {
        // Square said no (e.g. 220095). Nothing was posted: safe to try a new draft.
        lastFailure = `Square rejected the post: ${err.message}`;
        console.error(lastFailure);
        if (!isLast) console.error("Regenerating...\n");
        continue;
      }
      // Outcome unknown: do NOT publish again.
      console.error(`::error::Publish outcome unknown (${err.message}). Not retrying, to avoid a duplicate post. Check Square manually.`);
      return { exitCode: 1 };
    }
  }

  console.error(`All ${maxAttempts} attempts failed (last: ${lastFailure}). Nothing published this run.`);
  return { exitCode: 1 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run()
    .then(({ exitCode }) => {
      process.exitCode = exitCode; // non-zero so the Actions run shows as failed/flagged
    })
    .catch((err) => {
      console.error(`Run failed: ${err.stack ?? err.message}`);
      process.exitCode = 1;
    });
}
