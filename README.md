# Binance Square Auto-Poster

![Workflow Status](https://github.com/acevod/binance-square-autoposter/actions/workflows/square.yml/badge.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

Serverless bot that generates a crypto market post every 6 hours and publishes
it to Binance Square, using GitHub Actions as the scheduler/compute (no
server, nothing that needs to stay running).

```
Cron (GitHub Actions)
  → fetch market data (Binance public spot API, data-api.binance.vision)
  → (optional) fetch headline context (NEWS_CONTEXT=on)
  → compute verified facts in code (who had the widest range, who is ahead, ...)
  → generate post text (Groq, Gemini fallback)
  → sanitize (em dashes, unicode quotes, stablecoin cashtags)
  → validate (length, cashtags, banned patterns, no links, grounding in the
    source data, claims vs data, hype/closing guard, duplicates)
  → publish to Binance Square
  → commit post history back to the repo
  → (optional) Telegram alert if the run failed
```

## How it works

1. **Pick a theme**: one of 9, uniform random (`selectTheme()` in
   `src/generate.mjs`) among the themes that fit the time of day (see "The 9
   themes"), excluding whichever themes appear in the last 4 posts
   (`getRecentThemes()` in `validate.mjs`; posts that failed don't count). If
   that leaves nothing, a recent theme may repeat, but a mistimed one never
   gets picked. This never errors out, even with no history yet.
2. **Fetch data** for that theme (`src/sources/*.mjs`). A theme with no
   qualifying data today is skipped on the spot and another is tried, without
   calling the model.
3. **Generate text** with an LLM (Groq primary, Gemini fallback), using a
   per-theme prompt, shared style rules (casual tone, cashtag format,
   banned hype words and closings, only-use-supplied-data, etc.) and a block
   of **verified comparisons computed in code** (`src/facts.mjs`), so the model
   explains who was widest/largest/ahead instead of deciding it.
4. **Sanitize** the output deterministically (`sanitizeText()` in
   `generate.mjs`), because prompt instructions alone aren't reliable.
5. **Validate** (`src/validate.mjs`): length, banned patterns, **no links or
   web addresses**, cashtag count/presence, **grounding**
   (`src/grounding.mjs`: every `$TICKER` and significant number must exist in
   the data the LLM was given), **semantic checks** (`src/semantic.mjs`: a
   claim such as "widest range" or "BTC is ahead of the alts" must match the
   computed facts), the extreme-mover guard (`src/anomaly.mjs`), the
   hype/closing guard (`src/fatigue.mjs`), headline rules when news is used
   (`src/news-guard.mjs`), and a duplicate check against recent posts.
6. If anything fails, **start over** (up to 3 attempts, `src/run.mjs`). Each
   attempt is a fresh generation and may land on a different theme, it
   doesn't just re-roll the same draft. This covers failed validation,
   transient failures while fetching data or calling the LLMs (with growing
   backoff), and a post that Square definitively rejects. A publish whose
   outcome is unknown (timeout, 502, 504) is **never** retried, because the
   post may be live and publishing again could duplicate it. A 504 ends the
   run with exit code 2, so the run is red and the Telegram alert fires.
7. **Publish** to Binance Square (`src/publish.mjs`). The post is written to
   `data/posts.json` as `pending` *before* the call and updated to its final
   status afterwards, so duplicate protection holds even if the run dies
   mid-publish.
8. The workflow commits the updated `data/posts.json` back to the repo so
   history persists across runs (GitHub Actions runners are ephemeral). A
   `concurrency` lock stops a manual run and the cron run from overlapping.

## Project structure

```
.github/workflows/square.yml   cron + manual trigger, concurrency lock, runs src/run.mjs
.github/dependabot.yml         monthly update PRs for the (SHA-pinned) actions
skills/square-post/            Binance's official posting skill (publishing only)
src/
  sources/
    market.mjs                 Themes 1-5, 7, 8: Binance public market data
    tokenized-stocks.mjs       Theme 6: bStocks (tokenized equities), same API
    news.mjs                   optional headline context (RSS, titles only)
    narrative.mjs              Theme 9: headline vs 24h data verdict
  generate.mjs                 theme picker, prompts, LLM calls, sanitizeText
  facts.mjs                    comparisons computed in code, prompt fact block
  validate.mjs                 pre-publish checks + post history storage
  grounding.mjs                checks tickers/numbers against the source data
  semantic.mjs                 checks claims (widest, ahead, ...) against the facts
  anomaly.mjs                  extreme-mover guard (thin-volume pumps)
  fatigue.mjs                  hype words, stock closings, repeated closings
  news-guard.mjs               link ban, headline copy/quote/cause rules
  cashtags.mjs                 what counts as a $CASHTAG
  http.mjs                     fetch wrapper with timeouts
  publish.mjs                  publishes to Square, tracks status in history
  run.mjs                      entry point: generate → validate → publish (with retry)
test/                          automated tests (node:test), run with `npm test`
data/posts.json                auto-generated post history, don't create manually
package.json                   type: module, engines: node >=22, test/start scripts
CHANGELOG.md                   release notes
.gitignore                     node_modules/, .env, *.log
.env.example                   required env vars for local testing (no values)
README.md                      this file
LICENSE                        MIT
```

## Skills used

| Skill | Role | Auth |
|---|---|---|
| `square-post` | Publishing | `BINANCE_SQUARE_OPENAPI_KEY` |

It's the only skill this repo depends on. All market data comes straight
from Binance's public spot API, with no key and no other skill involved.

## The 9 themes

| # | Theme | Source |
|---|---|---|
| 1 | Morning Market Brief | BTC/ETH/BNB 24h ticker (`market.mjs`) |
| 2 | Leaders & Laggards | Top gainers vs losers in the dynamic basket |
| 3 | Breakout Watch | Past-24h range vs 7-day average daily range (klines); only tokens at 1.3x or more |
| 4 | The Quiet Ones | Same as above, inverted: only tokens at 0.8x or less |
| 5 | Relative Strength Check | ETH/BTC pair + median alt vs BTC (price performance, not capital flow) |
| 6 | Tokenized Stocks Corner | bStocks read as regular spot tickers (`tokenized-stocks.mjs`) |
| 7 | Daily Recap | BTC/ETH/BNB 24h ticker (`market.mjs`) |
| 8 | Market Regime | How broad the 24h move is (share of alts up/down) and whether BTC or the typical alt did better; labels computed in `market.mjs` |
| 9 | Data vs Narrative | One market-wide headline vs the 24h regime, with a supports/contradicts/mixed verdict (`narrative.mjs`); **only when `NEWS_CONTEXT=on`** |

All themes pull exclusively from Binance-listed USDT pairs
(`data-api.binance.vision`), with no DEX/on-chain token data anywhere in the
pipeline (see "Not included" for why). Theme selection is uniform random
(`THEMES` in `src/generate.mjs`) — all themes except Data vs Narrative pull from the same safe
data source, so each gets an equal chance, minus the ones that don't fit the
time of day and whichever were used in the last 4 posts.

Time of day matters for two themes (WIB, UTC+7): *Morning Market Brief* is only
eligible 05:00-12:00 and *Daily Recap* only 18:00-03:00 (`THEME_HOURS_WIB` in
`generate.mjs`). With the 6-hourly cron that means the 07:17 slot can pick the
morning brief, the 19:17 and 01:17 slots can pick the recap, and 13:17 picks
neither. All other themes can run at any time.

Themes 3 and 4 only report genuine anomalies: tokens with fewer than 5 full
days of history are skipped, and if nothing qualifies the theme is skipped
immediately and another is tried (so quiet days produce fewer such posts). Both
compare like with like: hourly candles are cut into consecutive 24h windows
counted back from now, and the latest window is compared with the average of
the 7 before it.

Theme 8 labels are plain thresholds in `market.mjs`: a move is "broad" when at
least 70% of the alts moved the same way (`BROAD_BREADTH_PCT`), and BTC or the
typical alt "did better" when it is ahead by 1 point or more
(`LEADERSHIP_SPREAD_PCT`). They describe the past 24 hours only, not a forecast.

Moves of 30% or more on under $20 M USDT volume are dropped from Leaders &
Laggards (`src/anomaly.mjs`), so the bot never promotes a thin-volume pump.

The basket behind themes 2-5 is dynamic, not a hardcoded list. Every run
fetches all USDT pairs, drops stablecoin pairs and ranks the rest by 24h
quote volume. Stablecoins are caught two ways: a name list (USDC, USD1,
USDE, ...) plus a peg fingerprint (priced within 2 cents of $1 with a
sub-1% daily range), because the name list alone missed USD1 and it showed
up in a real "Quiet Ones" post. Delistings
and new listings are picked up automatically. A leveraged-token filter
(`*UP`/`*DOWN`/`*BULL`/`*BEAR`) is also in place but currently matches
nothing, since Binance discontinued those years ago.

## Setup

### 1. GitHub Secrets

Settings → Secrets and variables → Actions:

| Secret | Where to get it |
|---|---|
| `BINANCE_SQUARE_OPENAPI_KEY` | Binance Square Developer/OpenAPI settings |
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) |
| `GEMINI_API_KEY` | [aistudio.google.com](https://aistudio.google.com) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | *Optional*, see "Failure alerts" below |

Optional **variables** (Settings → Secrets and variables → Actions →
*Variables*, not Secrets):

| Variable | Effect |
|---|---|
| `NEWS_CONTEXT` | `on` lets Leaders & Laggards, Morning Brief and Daily Recap mention one recent headline and enables theme 9. Off by default. Posts name the outlet and never contain links. |
| `BSTOCKS_EXTRA` | Extra bStocks beyond the built-in list, e.g. `AAPLBUSDT=Apple,MSFTBUSDT=Microsoft` (name optional). |

Secrets never carry over to forks or template copies, so anyone reusing
this repo needs their own keys (and their own Square key, otherwise posts
go to *your* account). A fork also needs to:

- open the **Actions** tab and enable workflows (scheduled workflows are
  off in forks by default);
- set Settings → Actions → General → Workflow permissions to **Read and
  write**;
- reset history: delete `data/posts.json`, or set its content to `[]`, so it
  starts with its own history.

The actions in the workflow are pinned to commit SHAs of the official
`actions/*` repos, so forks and copies run the same code without changes.

### 2. Workflow permissions

`.github/workflows/square.yml` needs `permissions: contents: write` (already
set) so it can commit `data/posts.json` back after a successful publish. In a
fork, the repo-level setting above must also allow write access.

### 3. Schedule

Default cron is `17 */6 * * *` (every 6 hours at :17: 00:17/06:17/12:17/18:17
UTC = 07:17/13:17/19:17/01:17 WIB). Cron in GitHub Actions is always UTC. The
minute is deliberately not `:00`: GitHub delays or drops scheduled runs at the
top of the hour when load is high. Adjust to taste.

At 4 runs/day with up to 3 attempts each, worst case is ~12 LLM requests and
roughly 60,000-70,000 tokens/day — comfortably under Groq's free-tier
gpt-oss-120b limits (1,000 requests/day, 200,000 tokens/day) and Square's
100 posts/day cap. The anti-repeat check (see "How it works") matters more at this
frequency: several runs can land within the same rolling-24h data window,
so avoiding a repeated theme is what keeps back-to-back posts from reading
near-identical.

### 4. Failure alerts (optional)

If a run fails (including a publish whose outcome is unknown: a 504 from
Square exits with code 2 on purpose, so check Square before re-running), the last
workflow step can message you on Telegram. Create a bot with @BotFather, get
your chat id (for example from @userinfobot), and add the secrets
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Without both secrets the step is
skipped. The message only contains the repo name and a link to the run.

## Local testing

```bash
cp .env.example .env   # then fill in the keys
node --env-file=.env src/run.mjs
```

Automated tests (no network, no keys needed):

```bash
npm test
```

Optional env vars: `GROUNDING_MODE=warn` logs numbers/tickers that can't be
traced to the source data instead of rejecting the post (useful when rolling
grounding out); `SEMANTIC_MODE=warn` does the same for claims that contradict
the data; `NEWS_CONTEXT=on` and `BSTOCKS_EXTRA` as above; `HTTP_TIMEOUT_MS` overrides every request timeout;
`RETRY_DELAY_MS` overrides the retry backoff base (default 5000).

Test individual sources in isolation:

```bash
node src/sources/market.mjs           # themes 1-5, 7 and 8
node src/sources/tokenized-stocks.mjs # theme 6
```

**Network notes.** Binance's regular endpoints behave differently depending
on where you call them from:

- `api.binance.com` and `fapi.binance.com` return HTTP 451 from US IPs,
  which includes GitHub Actions runners (US Azure). That's why market data
  uses `data-api.binance.vision`, Binance's public market-data mirror.
  Other developers report the block can vary by time of day, so don't
  assume a passing run means the block is gone.
- Some local ISPs reset connections to `www.binance.com` / `web3.binance.com`
  (`ECONNRESET`). That's a local network issue: the same domains worked
  from GitHub Actions, and publishing itself goes through
  `www.binance.com/bapi/...`.

## Known quirks (found by testing against the real API)

These aren't documented anywhere in the skills themselves. They were found
by hitting the real errors during development:

- **Cashtag limit**: Square rejects posts referencing more than 3 distinct
  `$COIN` tickers (error `220095`, undocumented). Enforced in both the
  prompt and `validate.mjs` (`MAX_CASHTAGS`). Stablecoins written as
  cashtags count too, so `$USDT` is stripped to `USDT`.
- **Post length limit is confirmed at 1900 characters**, tested directly
  (the skill itself only documents error `20013` "Content length is
  limited" with no number). Prompts target 1600, `MAX_LENGTH` is 1850 as a
  small margin, since it's unclear whether Square counts raw characters or
  UTF-16 code units.
- **`gpt-oss-120b` is a reasoning model**: it spends part of `max_tokens`
  on internal reasoning before writing the answer, and can return empty or
  truncated text if the budget is too tight. Mitigated with
  `reasoning_effort: "low"`, a larger `max_tokens`, and explicit
  `finish_reason` checks in `generate.mjs`.
- **Em dash**: the LLM ignores "never use em dash" in the prompt often
  enough that a real run failed validation 3 attempts in a row and skipped
  the day's post. Retrying alone isn't reliable, so `generate.mjs` runs a
  deterministic `sanitizeText()` on every output before validation (em dash
  to comma or "to", curly quotes and non-breaking hyphens to ASCII). Once
  em dashes were banned the model switched to spaced en dashes (`–`), which
  are the same tell, so those are handled too. `validate.mjs` still rejects
  both as a safety net.
- **Predictive language**: even with "no predictions" in the prompt, drafts
  said things like "something brewing" and "keep an eye on the squeeze" for
  tokens whose range was only ~30% below normal. Themes 3-4 now tell the
  model to scale its wording to the size of the gap and describe only what
  happened, and `validate.mjs` rejects words like "squeeze", "brewing" and
  "coiled" (also "resistance", "could signal", "watch the next" after a
  published post said "watch the next resistance"). The Morning Brief and
  Daily Recap prompts no longer ask the model for "what to watch next"
  either, since that instruction contradicted the no-predictions rule.
- **Cashtags must match the tradable ticker, not the raw trading-pair
  symbol**: a real post wrote "$MARSCOINUSDT" and "$ZECUSDT" — Square
  actually parsed these fine (only the base asset rendered as a live
  cashtag, "USDT" sat after as plain text) but with no space it read as
  one garbled ticker. bStocks have the same issue in reverse: they trade
  as `NVDAB`, not `NVDA`, so deriving a cashtag from the symbol guesses
  wrong either way. Every `market.mjs` and `tokenized-stocks.mjs` function
  now sends a ready-made `cashtag` field (base asset only, `$` prefix
  included) so the model doesn't have to derive one, plus a rule in
  `STYLE_RULES` telling it to use that field verbatim.
- **`success_without_post_id`**: `square-post`'s publish call can return a
  504 and still have actually posted, with `id`/`shareLink` as `null`.
  `publish.mjs` records this as `status: "unknown"` (not `published`) and the
  run ends with exit code 2 and an error annotation, so it shows red and the
  Telegram alert fires. Timeouts and gateway errors are also
  `unknown`. An `unknown` outcome is **never retried**, since the post may be
  live and publishing again could duplicate it. History statuses: `pending`
  (written before publishing), `published`, `unknown`, `failed` (Square
  rejected it; doesn't count as a used theme).
- **bStocks trade as regular spot pairs**: `NVDABUSDT`, `TSLABUSDT`, etc.
  are readable through the same `ticker/24hr` endpoint as BTC/ETH/BNB, so
  Theme 6 doesn't need the separate RWA API that the
  `binance-tokenized-securities-info` skill documents. Switching also
  removed that skill's extra headers and a second API surface. Trade-off:
  spot tickers carry no stock fundamentals (P/E, dividend yield), so the
  theme leans on the "trades 24/7" angle instead.
- **Rolling 24h vs calendar day**: `ticker/24hr` is a rolling window ending
  now, not "since 00:00 UTC". Prompts say "past 24 hours" rather than
  "today" for that reason. Themes 3-4 compare like with like: hourly candles
  are cut into consecutive 24h windows counted back from now, and the latest
  window is compared with the average of the 7 before it (not with UTC
  calendar-day candles, which are a different window).
- **`data/posts.json` doesn't exist on first run** (or after a
  validation-only failure): a missing file is treated as empty history and
  created on first write, and the workflow's commit step checks the file
  exists before trying to `git add` it. A file that exists but is corrupt,
  empty, or the wrong shape stops the run with a `HistoryError` instead of
  silently resetting history. To reset history, delete the file or set it
  to `[]`.

## Known limitations

Deliberately left as-is for a small personal bot, but worth knowing:

- `BSTOCKS` in `tokenized-stocks.mjs` is a hand-maintained list of 7
  tickers, while Binance keeps adding bStocks. Add new ones without a code
  change through the `BSTOCKS_EXTRA` variable (check Binance's
  announcements for the symbols). A failing symbol is replaced by
  another candidate; if fewer than 2 can be fetched the theme fails and the
  run retries with a different one.
- Duplicate detection is a simple word-overlap ratio (threshold 0.6) against
  the last 30 posts. It can miss paraphrases and occasionally over-reject
  posts that share common words.
- Grounding (`src/grounding.mjs`) checks that tickers and numbers exist in the
  source data, but compares numbers by magnitude only. The relationship
  between real numbers ("widest", "ahead", "a third tighter") is checked by
  `src/semantic.mjs`, which is pattern-based: it only judges claims it can
  attribute to a ticker, and a new phrasing can slip past until a pattern is
  added. Treat it as a safety net, not a guarantee.
- News (`NEWS_CONTEXT=on`): the five feed URLs are not verified to be live (a
  failing feed is logged and skipped, never fatal). Headline direction for
  theme 9 is keyword-based, and its verdict only compares BTC and the median
  alt over 24 hours, not the meaning of the headline.
- If the publish call succeeds but updating its history entry fails, the
  entry stays `pending` (still protects against duplicates) and the run logs
  an error; it does not fail the run.
- Grounding is strict by default, so a post that does its own arithmetic
  (for example "3.5 points ahead") is rejected as untraceable. Set
  `GROUNDING_MODE=warn` in the workflow if that costs too many posts.
- Failure alerts need the optional Telegram secrets; without them a failed
  run is only visible in the Actions tab.

## Not included / out of scope

- **DEX/on-chain skills (`trading-signal`, `crypto-market-rank`, `meme-rush`)
  were removed from this repo entirely**, not just unwired, after a real
  post (via `crypto-market-rank`'s `smart-money-inflow`) referenced a token
  not listed on Binance and got a compliance notice from Square. These
  skills surface whatever's active on BSC/Solana DEXs with no guarantee of
  a Binance listing: fine for manual research, not safe for unattended
  auto-posting. All themes now come from Binance's own listed pairs only.
- No fallback beyond Groq → Gemini (OpenRouter, etc.). At a handful of
  posts a day a dual-provider outage is unlikely enough that it's not
  worth the added complexity yet.
