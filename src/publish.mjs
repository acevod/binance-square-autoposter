// src/publish.mjs
// Publishes validated text to Binance Square. Imports square-post's lib.mjs
// directly (it exports its internals, same as the data-fetching skills) —
// no subprocess needed.
//
// History is written in two phases so Square and posts.json can't silently
// diverge:
//   1. BEFORE publishing: an entry with status "pending" (duplicate
//      protection already covers the post, even if the process dies mid-call).
//   2. AFTER: the entry becomes "published", "unknown", or "failed".

import { publish, resolveApiKey } from "../skills/square-post/scripts/lib.mjs";
import { recordPost, updatePost } from "./validate.mjs";

// Errors thrown by lib.mjs api() for a definitive Square rejection look like
// "API error [220095]: ...". Everything else (timeout, network error,
// non-JSON gateway page) means we cannot know whether the post landed.
function isDefinitiveRejection(err) {
  return /^API error \[/.test(err?.message ?? "");
}

/**
 * Publish a validated post. Caller is responsible for having already run
 * validatePost() — this function does not re-validate.
 *
 * Returns { id, shareLink, publishStatus, status } where `status` is
 * "published" (confirmed) or "unknown" (HTTP 504: probably posted, not
 * confirmed; id/shareLink are null). Throws if Square definitively rejected
 * the post or the outcome can't be determined; the error carries
 * `publishOutcome` = "failed" (safe to retry) or "unknown" (do not retry).
 */
export async function publishPost({ theme, text, meta }) {
  const apiKey = resolveApiKey(); // reads BINANCE_SQUARE_OPENAPI_KEY from env

  const entry = await recordPost({ theme, text, status: "pending", meta });

  let result;
  try {
    result = await publish(apiKey, {
      contentType: 1, // 1 = short post (no title -> not an article)
      bodyTextOnly: text,
    });
  } catch (err) {
    const status = isDefinitiveRejection(err) ? "failed" : "unknown";
    err.publishOutcome = status; // run.mjs: "failed" is safe to retry, "unknown" is not
    await updatePost(entry.id, { status, error: String(err.message).slice(0, 200) }).catch((e) =>
      console.error(`Could not update history entry after publish error: ${e.message}`)
    );
    throw err;
  }

  const status = result.publishStatus === "success_without_post_id" ? "unknown" : "published";
  try {
    await updatePost(entry.id, {
      status,
      postId: result.id ?? null,
      shareLink: result.shareLink ?? null,
    });
  } catch (err) {
    // The post is live. Don't fail the run over bookkeeping: the "pending"
    // entry already written keeps duplicate protection in place.
    console.error(`::error::Published but history update failed (entry ${entry.id} stays "pending"): ${err.message}`);
  }

  return { ...result, status };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = process.argv[2];
  if (!text) {
    console.error("Usage: node src/publish.mjs '<post text>'");
    process.exit(1);
  }
  const result = await publishPost({ theme: "manual-test", text });
  console.log(JSON.stringify(result, null, 2));
}
