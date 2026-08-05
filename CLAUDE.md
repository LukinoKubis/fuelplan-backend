# Fuelplan — Backend

> TypeScript rebuild (was plain-JS `server.js`) — merged to `main` and live.
> Source lives at `src/server.ts`; `dist/` is the gitignored build output.
> Auth was migrated from activation codes to real email/password accounts
> (JWT) on 2026-07-19/23 — see "Auth" section below, this superseded the old
> `validateCode`/activation-code model entirely (removed, not deprecated).

## What this is
Express.js API proxy for the Fuelplan PWA, written in TypeScript.
Deployed to Railway at https://fuelplan-backend-production.up.railway.app

## Hosting
- Platform: Railway, project `strong-stillness`, service `fuelplan-backend`,
  `production` environment. Plan: **Hobby** ($5/mo, upgraded 2026-07-23 —
  the free tier blocks all deploys 8am–8pm Europe/Amsterdam, which bit us
  mid-migration).
- Deploy takes ~30-60 seconds. Has a cold start delay of 10-20s after
  inactivity (first request wakes it).
- Environment variables are set via Railway CLI — never hardcode them.
- **GitHub auto-deploy is unreliable for this project** — pushing to `main`
  has silently failed to trigger a rebuild more than once (confirmed via
  `railway status --json`, which showed the deployed commit hash was days
  stale after a push+wait). **Don't trust a `git push` alone to mean
  production updated.** After pushing, verify with:
  ```
  railway status --json   # check serviceInstances[0].node.latestDeployment.meta.commitHash
  ```
  If it doesn't match your latest commit, force it directly from the local
  checkout instead of waiting on the webhook:
  ```
  railway up --ci -m "description"
  ```
  This uploads and builds whatever's in the current working directory —
  make sure you're on a clean, correct checkout of `main` first.

## Stack
Node.js, Express, TypeScript, Axios, Upstash Redis (REST API — no persistent
connection needed). Single-file source at `src/server.ts`, same structure as
the old `server.js` — this codebase was simple/well-organized enough that a
straight TS port was low-friction, no restructuring needed. `videoExtract.ts`
(recipe video reading) is the one other source file — see its own section
below.

## Local dev
- `npm run dev` — `tsx watch src/server.ts` (no build step needed for dev)
- `npm run build` — `tsc` → `dist/server.js`
- `npm start` — runs the built `dist/server.js` (what Railway runs)

## Auth
Real accounts, not activation codes. bcrypt-hashed passwords, JWT (90-day
expiry, `Bearer` header) signed with `JWT_SECRET`. `requireAuth` middleware
(populates `req.userId`/`req.userEmail`) gates every endpoint that used to
take an `activationCode` in the body — credits, history, tracking, push,
export, checkout, the Claude proxy. `requireAdmin` (separate, `ADMIN_KEY`
header) still gates `/api/admin/*` only.

**`JWT_SECRET` missing on Railway = total auth outage** (signup/login both
503 "Auth not configured") — this actually happened in production after the
migration merge, because the var only ever existed in a local `.env`, never
set via `railway variables`. If auth endpoints start 503ing, this is the
first thing to check: `railway variables --kv | grep JWT_SECRET` (checks
presence only — never print the value to a shared terminal/log, generate a
fresh one if you suspect it's been exposed:
`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`).
Setting/changing it requires a restart (`railway redeploy -y`) to take
effect on the running container.

## Key endpoints
POST /api/auth/signup           — { email, password } → { token, email }
POST /api/auth/login            — { email, password } → { token, email }
GET  /api/auth/me               — requireAuth → { email }
POST /api/auth/forgot-password  — { email } → always { ok: true } (no email enumeration); no-ops without RESEND_API_KEY
POST /api/auth/reset-password   — { token, newPassword } → { ok: true }
POST /api/claude                — requireAuth, decrements credit, proxies to Anthropic
POST /api/claude/generate-plan-v2 — requireAuth, decrements exactly ONE credit for the whole
                                    generation (not per-Anthropic-call). Owns its own bounded
                                    agentic tool-use loop (see "AI plan generation via tool-use"
                                    below) — fuelplan-mobile's primary "Generate My Plan" path as
                                    of 2026-08-05, with a mandatory client-side fallback to its
                                    algorithmic picker on any failure.
POST /api/usage                 — requireAuth → remaining credits for the authed user
POST /api/history/save          — requireAuth, saves plan to Redis (max 5, newest first)
POST /api/history/get           — requireAuth, metadata list (id, savedAt, planName, macros)
POST /api/history/restore       — requireAuth, full plan JSON for a given planId
POST /api/history/delete        — requireAuth, removes a plan from history
POST /api/history/archive       — requireAuth, archives instead of hard-deleting
POST /api/recipes/save          — requireAuth, upserts a recipe (replaces by id if present, else assigns one and unshifts); 400 if the box is full (MAX_RECIPES = 300) rather than silently evicting a user-curated save
POST /api/recipes/list          — requireAuth, full array of the user's saved recipes
POST /api/recipes/delete        — requireAuth, { recipeId } → removes one recipe, 404 if not found
POST /api/claude/suggest        — requireAuth, does NOT decrement a credit, 1200-token cap; for
                                    lightweight one-shot suggestions (fuelplan-mobile's "Get AI
                                    Advice") — prefer this over /api/claude for anything that
                                    shouldn't cost a full generation credit
POST /api/claude/prep-and-shopping — requireAuth, does NOT decrement a credit, rate-limited
                                    (8/hour per user) instead, 6500-token cap. Same idea as
                                    /api/claude/suggest but sized for a bigger free payload
                                    (fuelplan-mobile's Custom Plan prep/shopping generation,
                                    ~6000 tokens — too big for /suggest's 1200 cap). Free "for
                                    now" per an explicit product call, pending a freemium
                                    monetization rework — revisit whether this should decrement
POST /api/admin/update-library-macros — requireAdmin, { corrections: [{id, macros}] } → writes
                                    straight to Redis, NO Anthropic call at all (see "The
                                    ANTHROPIC_API_KEY is for real app users" below for why).
                                    Used for the 2026-07-26 library-wide macro-accuracy fix.
POST /api/account/delete        — requireAuth, deletes every per-user Redis key (user record,
                                    remaining credits, history, archive, tracking, push tokens,
                                    admin note, recipes, favorites) — keeps order/payment records
                                    for accounting/legal reasons. Required for App Store
                                    compliance (self-serve account deletion), not just a nicety.
POST /api/feedback/submit       — requireAuth, rate-limited 5/hour, stores to
                                    fuelplan:feedback:all (max 500, newest first), best-effort
                                    emails FEEDBACK_NOTIFY_EMAIL via Resend if configured

Removed in the auth migration (do not re-add): `/api/register-code`,
`/api/account/link-email`, `/api/account/recover`, the `ACTIVATION_CODES`
env fallback, `validateCode()`.

## Redis key structure
fuelplan:users               — Set of all userIds (registry)
fuelplan:user:USERID         — JSON user record (id, email, passwordHash, createdAt)
fuelplan:user:email:EMAIL    — userId lookup by email (login/signup dedup)
fuelplan:resetToken:TOKEN    — userId, 1h TTL, single-use (deleted on reset)
fuelplan:remaining:USERID    — remaining generations (integer string)
fuelplan:history:USERID      — JSON array, max 5 entries, newest first
fuelplan:archive:USERID      — archived plans, same shape as history
fuelplan:tracking:USERID     — calendar/weights/notes sync payload
fuelplan:push:USERID         — JSON array of Expo push token strings (up to 3 devices),
                                 e.g. ["ExponentPushToken[xxxx]", ...] — NOT a browser
                                 PushSubscription object anymore, see "Push notifications" below
fuelplan:note:USERID         — admin-set note (shown in admin dashboard)
fuelplan:orders:*            — LemonSqueezy order records
fuelplan:recipes:USERID      — JSON array of RecipeRecord, max 300 (user's
                                 personal recipe box — imported via share/paste
                                 or saved manually; 400s when full instead of
                                 evicting, unlike history's auto-archive).
                                 Each record carries an optional `tags: string[]`
                                 — free-form user-created labels, plain passthrough
                                 field on /api/recipes/save, no server-side validation
fuelplan:feedback:all        — JSON array of feedback submissions, max 500,
                                 newest first (see POST /api/feedback/submit above)

Old activation-code-era keys (`fuelplan:codes`, `fuelplan:remaining:CODE`,
`fuelplan:email:*`) are left untouched in Redis from before the migration —
unreachable now, nothing reads them, never migrated (codes were retired
outright, not converted to accounts).

## Environment variables (managed via Railway CLI, not hardcoded)
ANTHROPIC_API_KEY          — Anthropic API key
UPSTASH_REDIS_REST_URL     — Upstash REST endpoint
UPSTASH_REDIS_REST_TOKEN   — Upstash auth token
ADMIN_KEY                  — key required for /api/admin/* endpoints
JWT_SECRET                 — signs auth tokens; missing = signup/login 503 (see "Auth" above)
DEFAULT_PLAN_LIMIT         — how many generations a new account starts with
FRONTEND_URL               — https://fuelplan.fit (used in CORS allowlist)
RESEND_API_KEY             — Resend.com API key (free tier: 3000 emails/month), powers forgot-password emails
FROM_EMAIL                 — sender address, e.g. "Fuelplan <noreply@fuelplan.fit>"
EXPO_ACCESS_TOKEN          — optional, only for Expo's enhanced push security feature; push
                              sending works without it. See "Push notifications" below.
SUPABASE_URL                — Supabase project URL, e.g. https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY   — service role key (server-side only, bypasses RLS) — used to upload
                              recipe cover photos. Optional: missing/unset just means photo saves
                              keep the base64 fallback instead of uploading. See "Recipe cover
                              photo" below.

## Push notifications
Swapped from Web Push/VAPID to Expo's push service on 2026-07-24, as part
of the `fuelplan-mobile` (React Native) migration — the web app's
`fuelplan-frontend` never used this itself. Uses `expo-server-sdk`
(`new Expo({ accessToken: process.env.EXPO_ACCESS_TOKEN })`), not
`web-push` — that package and its VAPID env vars (`VAPID_PUBLIC_KEY`/
`VAPID_PRIVATE_KEY`/`VAPID_EMAIL`) were removed entirely, not deprecated.
- `POST /api/push/subscribe` / `/unsubscribe` — body is `{ token }`, an
  Expo push token string obtained client-side via
  `expo-notifications`' `getExpoPushTokenAsync()`, validated with
  `Expo.isExpoPushToken()`. No more `/api/push/vapid-key` endpoint — native
  push doesn't need a public-key handshake the way browser subscriptions do.
- `sendExpoPush()` (helper, near the endpoints) chunks tokens+messages
  together (not messages alone) specifically so a delivery receipt can
  always be traced back to the token that sent it, even if an earlier
  chunk's send call fails — chunking only the messages and relying on
  positional index alignment against the token list breaks the moment any
  chunk errors out.
- Stale-token cleanup uses Expo's receipt API (`DeviceNotRegistered`
  error), the equivalent of the old web-push 410/404 status check —
  Expo's send-time ticket response alone doesn't surface this, only a
  follow-up receipt fetch does.
- **Android delivery needs FCM v1 credentials configured in EAS**
  (`eas credentials`, requires a Firebase project — this is mobile-app-side
  setup, not something this backend reads or stores) — sending will
  silently fail for Android tokens without it. iOS needs an APNs push key,
  same EAS credentials flow, requires the Apple Developer Program
  enrollment.
- **Incident, 2026-07-24**: the `expo-server-sdk` swap took production down
  immediately (502 on every request) — Railway's Node runtime resolved to
  18.20.8 (the oldest version satisfying the then-current
  `engines.node: >=18.0.0`), which doesn't expose `File` as a global the
  way Node 20+ does; `expo-server-sdk` pulls in `undici`, which crashes at
  require-time without it. Fixed by `src/polyfills.ts` (a `node:buffer`
  `File` polyfill, imported first in `server.ts` — **must** be a separate
  module, not an inline statement above the `expo-server-sdk` import: ES
  module imports execute in source order on first encounter regardless of
  textual position relative to non-import statements, so an inline
  polyfill wouldn't actually run first) and bumping `engines.node` to
  `>=20.0.0`. Lesson: this dev environment's local Node (24.x) is newer
  than what Railway actually deploys on — a clean local `npm run build` +
  run is not sufficient proof a new dependency won't break production;
  check what Node version Railway is actually resolving
  (`railway status --json`) before trusting a deploy, especially after
  adding a new dependency.

## Recipe video reading (`videoExtract.ts`) — real scraping, not an API
`POST /api/recipes/extract-video` (TikTok only) reads spoken audio and
on-screen text overlays a video's caption doesn't cover, for the mobile
app's recipe import. There is no official transcript API for either
platform — this downloads the actual video and processes it:

- **Getting the video file requires a real headless browser, not a plain
  fetch.** TikTok's video CDN 403s a bare server-side `fetch()` (Akamai
  edge, confirmed live — likely blocking datacenter IPs/missing session
  context regardless of headers), but a real Playwright/Chromium page
  load succeeds and lets us intercept the actual video response. Every
  call spins up a full browser — real latency (8-14s end to end) and real
  CPU/memory cost, not a cheap API hit.
- **Genuinely flaky, by nature of scraping.** A ~600-byte non-video
  response can share the exact same `/video/tos/` URL path as the real
  multi-MB video and arrive first — `downloadTikTokVideo`'s
  `page.waitForResponse()` predicate checks response *size*, not just URL
  pattern, specifically because of this. One retry (fresh browser) before
  giving up. Verified 3/3 reliable after that fix, both locally and
  against the live Railway deploy.
- **Audio → text**: ffmpeg-static (bundles its own binary — no system
  ffmpeg package needed, unlike Chromium) pulls the audio track, sent to
  OpenAI Whisper (`OPENAI_API_KEY`, a service-account key). Soft-optional:
  no key configured just means an empty transcript plus a warning, not a
  thrown error — on-screen text and the caption are still useful without it.
- **On-screen text → text**: 1 frame every 3s (up to 6, so ~18s of video —
  a real v1 limitation for longer clips) sent to Claude's vision API,
  reusing the existing `ANTHROPIC_API_KEY` — no new provider needed for
  this half.
- **Instagram is NOT supported.** Its post pages don't expose a directly
  fetchable video URL the way TikTok's do; doing it reliably would need a
  logged-in session, a materially bigger lift not attempted. The endpoint
  rejects non-TikTok URLs outright.
- Gated by `requireAuth` + a `remaining > 0` check (abuse prevention) but
  does **not** itself decrement a credit — the recipe-extraction call that
  follows (through `/api/claude`) already does.

## Instagram caption reading (`instagramExtract.ts`)
`POST /api/recipes/extract-instagram-caption` — Instagram's oEmbed and
public API don't expose captions without Meta App Review, but a post's
`og:description` meta tag carries the caption verbatim (format: `N likes,
N comments - username on <date>: "<caption>".`), confirmed live. That tag
is injected client-side by Instagram's own React app (a plain `fetch()`
finds nothing in the raw HTML), so this needs the same
real-headless-Chromium approach as `videoExtract.ts` — but the extraction
itself is much simpler and faster: no video/audio/ffmpeg at all, just
navigate and read one meta tag (~2-5s vs 8-14s for TikTok's video read).

**Only works for genuinely public posts** — private accounts,
age-restricted content, and some posts under load still show a login wall
(no caption meta tag at all), which surfaces as a clean error, not a bug.
Same `requireAuth` + `remaining > 0` gate as `extract-video`, no decrement.

**Real bug hit and fixed**: Instagram sprinkles invisible Unicode
direction-mark characters into the `og:description` string (one sits
right at the very end) — silently broke a naive `$`-anchored regex trying
to strip the `"N likes, ... : "..."."` wrapper down to just the caption
(the trailing mark isn't `\s`, so the anchor never matched, and the whole
unstripped wrapper text got returned instead). Fixed by filtering
characters by **codepoint** (a `Set` of the specific invisible-mark
codepoints) rather than embedding invisible characters directly in source
or writing a regex with `\u` escape sequences — both of those got mangled
by the editing tooling along the way (turned into more invisible
characters, or had backslashes silently stripped). If a future scrape
needs to strip Unicode formatting marks again, use the codepoint-`Set`
pattern in `unwrapCaption()`, not a character class regex.

## Recipe cover photo (`recipePhotoStorage.ts`)
`Recipe`/`RecipeRecord`'s optional `photo` field arrives from the client
(`fuelplan-mobile`'s `recipePhoto.ts`) as a base64 data URI, already
resized/compressed (max 640px wide, JPEG quality 0.6). Originally stored
inline on the Redis JSON record; moved to Supabase Storage on 2026-07-24
because storing the full image on every record both bloated Redis storage
and meant `/api/recipes/list` re-downloaded every photo in full on every
single load, not just when a recipe's detail screen was actually opened.

`POST /api/recipes/save` uploads any `photo` that's still a base64 data
URI to Supabase Storage (bucket `recipe-photos`, deterministic key
`userId/recipeId.jpeg` — re-saving a new photo for the same recipe
overwrites the old object automatically, no orphan cleanup needed for the
common case) and re-saves the record with just the public URL. Deleting a
recipe best-effort deletes the matching storage object too. Soft-disabled
if `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` aren't set — save just keeps
the base64 inline instead, so a missing/misconfigured Supabase project
never breaks the feature, just leaves new saves on the heavier path.

**No backfill migration** — recipes saved before this change keep their
inline base64 `photo` until the user edits that recipe's photo again
(which re-triggers the upload path via the same save endpoint). Fine at
the current scale; revisit if that stops being true.

**Bucket setup** (one-time, in the Supabase dashboard): create a bucket
named `recipe-photos`, set it **public** (cover photos aren't sensitive —
public read access means the public URL works directly, no signed URLs
needed). The service role/secret key is required for the upload/delete
calls to bypass Storage's row-level-security policies from the server.

**Real bug hit and fixed at launch**: the first version used the
`@supabase/supabase-js` package. Its `createClient()` unconditionally
constructs a Realtime client, which requires a native `WebSocket` global —
only present in Node 22+. Railway resolves Node 20.20.2 for this project
(`package.json`'s `engines.node` only requires `>=20.0.0`), so every
upload threw `Node.js detected but native WebSocket not found` at
runtime — silently caught by the save endpoint's soft-fail, so it looked
like a working "no-op" rather than an error until a debug log surfaced
the real exception. Same failure class as the earlier
`expo-server-sdk`/Node-version incident (see "Push notifications" above).
Fixed by dropping the SDK entirely and talking to Supabase Storage's REST
API directly via `axios` (`POST /storage/v1/object/{bucket}/{path}` with
an `x-upsert: true` header, public URL is just
`{SUPABASE_URL}/storage/v1/object/public/{bucket}/{path}`) — we only ever
needed Storage, not Realtime, so this sidesteps the Node-version gap
instead of bumping the whole project's `engines.node`. If a future
Supabase (or any other) SDK addition breaks the build the same way, check
what Node version Railway actually resolves before assuming the code is
wrong.

## Railway migrated its default builder from Nixpacks to Railpack
Relevant to both scraping features above (`videoExtract.ts` and
`instagramExtract.ts`), since both need Chromium to actually launch at
runtime. Discovered the hard way adding video reading: a `nixpacks.toml` with
Chromium's required apt packages + a custom install command was **silently
ignored** — confirmed from the actual build log (`[railpack] merge
$packages:apt:runtime, ...` lines; only Railpack's own auto-detected
`libatomic1` got installed, nothing from the file). Railway's build system
is Railpack now, and it doesn't read `nixpacks.toml` — check the build log
for `[railpack]` vs `[nixpacks]` lines before assuming which one is active,
rather than trusting a filename that used to work.

What Railpack actually reads:
- **`postinstall` script in `package.json`** (`playwright install
  chromium`) — runs automatically via `npm ci`'s lifecycle hooks
  regardless of which builder Railway uses. More portable than fighting a
  builder-specific custom-step config format — prefer this over a
  builder-specific file when a package-manager lifecycle hook can do the
  same job.
- **`RAILPACK_DEPLOY_APT_PACKAGES`** (Railway env var, not a committed
  file) for system packages needed at *runtime* (Chromium launching, not
  just downloading) — Playwright's documented Debian 12 dependency list
  for Chromium. Prefixed with `...` so it *extends* Railpack's own
  auto-detected packages instead of replacing them (omitting `...`
  replaces the whole list, which would drop packages Railpack needs for
  its own purposes).
- There's also a `RAILPACK_BUILD_APT_PACKAGES` (build-time-only packages)
  and a `railpack.json` config file for more complex cases (custom build
  steps, etc.) — not needed here since `postinstall` covered it.

## Railway CLI — use this instead of the dashboard

# Check current environment variables
railway variables

# Set a new environment variable
railway variables set KEY=value

# View live logs (useful for debugging a failed deploy)
railway logs

# Check deploy status
railway status

# Redeploy without a code change
railway redeploy

## How to test the backend is running
curl https://fuelplan-backend-production.up.railway.app/
Should return: {"status":"ok","service":"fuelplan-backend"}

## How to debug backend issues
- Cold start: first request after inactivity takes 10-20s — not a bug, just wait
- If logs show a crash: railway logs — read the error and fix the code
- If env var is missing: railway variables --kv — check it exists (names only;
  don't print secret values to a shared terminal), set it if not
- If deploy failed: railway status — check the deploy log for build errors
- **Auth endpoints all 503 "Auth not configured"**: `JWT_SECRET` isn't set on
  Railway — see "Auth" section above
- **Production doesn't reflect a recent push**: check the deployed commit
  hash (see "Hosting" above) — the GitHub webhook has failed silently before;
  use `railway up` to force a deploy from your local checkout

## redisCommand() fails silently — a bad local .env looks like a data bug
`redisCommand()` catches every error (network, DNS, auth) and returns
`null` rather than throwing. That's the right call for production (one
bad Redis call shouldn't 500 the whole request), but it means a stale or
wrong `UPSTASH_REDIS_REST_URL`/`TOKEN` in a **local** `.env` doesn't fail
loudly — every read returns "empty" and every write silently no-ops, while
endpoints still report `{ ok: true }` with plausible-looking data (e.g. a
freshly generated id) because the code never sees an error to react to.
**Real bug hit during Recipe M1**: local `.env` still had an old Upstash
project's URL (`known-ladybird-88688.upstash.io`, DNS `ENOTFOUND` — the
database had been recreated at some point and Railway's env got updated
but the local `.env` never did) while Railway had the current one
(`stirring-rabbit-183167.upstash.io`). Every save/list/delete against the
local dev server "worked" but list always came back empty. If local
Redis-backed endpoints behave like data isn't persisting (saves succeed,
reads come back empty), **check DNS resolves for `UPSTASH_REDIS_REST_URL`
before suspecting the endpoint code** — `railway variables --kv | grep
UPSTASH` to compare against local `.env` is the fastest way to confirm.

## /api/claude's shared message sanitizer has a length cap — check it before adding a new caller
`sanitizeUserContent()` (near `/api/claude`) silently truncates any message
content over `MAX_MESSAGE_CONTENT_LENGTH` before forwarding to Anthropic,
applied unconditionally to every `/api/claude` call regardless of which
feature is calling it. It was originally sized (3000 chars) for the
original callers — single free-text fields like dietary restrictions —
where that's plenty and also caps genuinely oversized pastes.

**Real bug hit and fixed**: `fuelplan-mobile`'s Library M5 algorithmic
plan generation added a new caller (`prepAndShoppingPrompt.ts`) that
legitimately sends a full 7-day, 28-meal ingredient list through this same
endpoint — routinely 11-12k characters, nowhere near "user free text" in
size. It got silently truncated mid-meal-list before reaching Anthropic;
Claude correctly noticed the cut ("your message was cut off at Wednesday
Lunch...") and replied asking for the rest instead of returning JSON,
which surfaced client-side as "Got invalid JSON back. Please try again."
on **every single generation** — confirmed live, reproduced twice
identically before being traced here. Diagnosed by generating the exact
request body standalone (complete and correct, no truncation) and
comparing against this function's logic, not by suspecting the client.
Fixed by raising the cap to 20000 — comfortable headroom for this payload
shape while still bounding genuinely oversized free-text pastes in the
original fields.

**Lesson**: if a new feature adds another caller to `/api/claude` with a
message shape unlike the existing ones (especially anything long or
structured, not a short free-text answer), check `MAX_MESSAGE_CONTENT_LENGTH`
before assuming a JSON-parse failure is a prompt-compliance problem —
verify what request actually left the client isn't already the truncated
version.

## AI plan generation via tool-use (`POST /api/claude/generate-plan-v2`)
Added 2026-08-05 (fuelplan-backend#1) as fuelplan-mobile's third
generation of plan generation: full-AI (invented meals, abandoned) →
Library M5 (deterministic algorithmic picker, zero AI) → this. See
`fuelplan-mobile/CLAUDE.md`'s "Plan generation (M1-M3, AI tool-use)"
section for the full picture including live-verification results —
this section covers the backend implementation specifics.

**Why this is a separate endpoint, not a `/api/claude` caller**:
`/api/claude` decrements one credit PER HTTP call. A single plan
generation here legitimately needs several internal Anthropic round
trips (the agentic tool-use loop below) — reusing `/api/claude` would
over-charge credits per generation. This endpoint owns the whole loop
server-side and decrements exactly ONE credit for the whole thing,
regardless of how many internal Anthropic calls it took.

**Design**: gives Claude a `search_recipes` tool (Anthropic
tool-use/function-calling) backed by the real shared library (`getLibrary()`,
same data `/api/library/list` serves) instead of asking it to invent
~28 meals of raw JSON in one response — the earlier full-AI approach's
actual failure mode (see the mobile repo's postmortem). Claude can only
ever reference a recipe id that came from an actual tool result; the
final response (`{days:[{day, meals:[{slot, recipeId, servings}]}]}`) is
validated server-side (`validateGeneratedPlan` — every recipeId real AND
category-matched, all 7 days/4 slots present, no dupes) before returning
200. On one validation failure the model gets a single bounded
self-correction turn before falling back to `502 {error: 'Could not
assemble a valid plan, try again'}`.

**Bounded agentic loop**: `MAX_TOOL_CALLS = 20`, `MAX_TURNS = 12` —
bounds worst-case cost/latency per generation on a shared,
budget-conscious Anthropic account (see "The ANTHROPIC_API_KEY is for
real app users" below). Per-call `max_tokens: 6000`, `timeout: 90000`
(both raised from initial values of 4096/60000 during M3 live
verification — see below). Tool-call/turn counts are logged to stdout
per generation (`generate-plan-v2: user=... turn=... stop_reason=...
toolCallsThisTurn=... toolCallsTotal=...`) for cost/behavior visibility —
check `railway logs` after a live test to see the actual shape of a run.

**`search_recipes`'s dietary filtering is structural, not prompted**:
disliked ingredients (`genConflictsWithDislikes`, same keyword-match
spirit as `planAssembly.ts`'s client-side version) are filtered out
INSIDE the tool implementation before results ever reach the model — a
disliked recipe can never even appear in a tool result, let alone get
picked. Verified live (M3): 0 dietary violations across a 4-profile test
matrix including a dedicated restrictions+dislikes profile, matching the
expectation that this is more reliable than the old free-AI approach's
post-hoc "please avoid this" prompting.

**Real bug hit and fixed, M3 live verification (2026-08-05): systematic
protein overshoot.** `search_recipes` originally sorted every result by
protein density (highest first) — the model was always shown the most
protein-dense options at the top of its search results regardless of
whether it asked for a protein floor via `minProtein`, and consistently
picked from that biased top slice. Confirmed live across a 3-profile
matrix: daily protein landed 30-100g over target (vs the algorithmic
picker's single-digit-gram accuracy on the same profiles/library).
`minProtein` already lets the model set an explicit floor when it wants
one — ranking on top of that double-counts protein. Fixed by sorting on
closeness to the middle of the requested kcal range instead (a neutral
"typical option for this search" ordering) when a range was given,
otherwise leaving library order as-is, PLUS tightening the system
prompt's macro guidance from an open-ended "undershooting protein matters
more than overshooting" to explicit numeric target bands (kcal within
~5%, protein within ~10-15g, with overshooting by 30g+ called out as
equally wrong as undershooting by that much). Re-verified on the
aggressive-cut profile after the fix: protein overshoot dropped from
+33g to +8g. **Lesson**: when a tool returns a ranked/sorted subset to an
LLM, the ranking criterion itself is an implicit instruction the model
will over-index on — don't rank by the same metric you're trying to hit
a target on, or you bias the model toward extremizing it.

**Real, still-open reliability gap found live, same verification pass**:
on a "bulk"/high-macro test profile specifically (needs more
meals/servings math, more tool calls), a single loop turn twice took
long enough to exceed even the raised 90s per-call timeout, surfacing as
a client-facing 504 after ~11 accumulated tool calls. Not fully solved —
raising `max_tokens`/`timeout` and fixing a related bug (see next
paragraph) helped but didn't eliminate it on this specific profile
shape. Fully covered by fuelplan-mobile's mandatory fallback (verified
separately via deterministic network-interception testing that the
fallback triggers cleanly and produces a normal plan), so not user-facing
data loss, just an occasional silent downgrade to the algorithmic picker
on complex profiles. See fuelplan-mobile#31 for follow-up ideas
(fewer/broader tool calls per turn, smaller tool-result payloads,
streaming to detect a stalled turn earlier).

**Related real bug hit and fixed in the same pass**: the tool-use branch
of the loop originally only triggered on `stop_reason === 'tool_use'`
exactly. A turn that hit `stop_reason: 'max_tokens'` (the model's
reasoning-before-tool-calls text got cut off) still contained earlier,
complete `tool_use` blocks — Anthropic only ever truncates the LAST
content block — but the strict string check sent it down the
text-parsing branch instead, wasting a whole turn. Fixed by triggering
on the presence of any `tool_use` blocks in the response, regardless of
the exact `stop_reason` string.

## Adding new endpoints
Follow the existing pattern in `src/server.ts`:
1. Add `requireAuth` middleware (populates `req.userId`/`req.userEmail`) for
   anything user-scoped, or `requireAdmin` for `/api/admin/*`
2. Do Redis operations via `redisCommand(command, ...args)`, keyed by `userId`
3. Return JSON response

## The ANTHROPIC_API_KEY is for real app users, not for developer/maintenance work
Real incident: a library-wide macro-accuracy fix (see `/api/admin/update-library-macros`
below) was originally built as an AI-calling endpoint that re-sent each
recipe through Claude to recompute its macros — burned through the
account's entire Anthropic credit balance mid-migration (only the
developer was using the app at the time, no real user traffic yet) and
took down every AI feature (Generate, Custom Plan, AI Advice, recipe
import) for actual users until it was topped up. Explicit direction
afterward: **never spend the app's Anthropic key/credit balance on
internal maintenance, migrations, or admin tooling** — that budget is for
real end users. `/api/admin/update-library-macros` was rewritten to be a
plain data-write endpoint (`{ corrections: [{id, macros}] }` → validates
+ writes straight to Redis, zero Anthropic calls) — the actual macro
values for a bulk fix like that should be computed by the developer
(by hand, or by an assistant working from its own knowledge/subscription,
not through this app's paid key) and POSTed in as plain data. If a future
admin/maintenance task seems to need an AI call, stop and ask first
rather than defaulting to routing it through `ANTHROPIC_API_KEY`.

## Deploy process
```
git add -A
git commit -m "feat: description"
git push origin main
railway status --json   # confirm the deployed commitHash actually matches —
                         # don't assume the push alone triggered a rebuild
railway up --ci -m "description"   # if it didn't
```

## If a deploy breaks the backend
git log --oneline        — find the last working commit
git revert HEAD          — revert the broken commit
git push origin main && railway up --ci -m "revert"   — don't rely on
                                                          auto-deploy alone

## Upstash Redis
- Managed at https://console.upstash.com — no CLI available
- Credentials (UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN) 
  are already set as Railway environment variables
- All Redis operations go through the redisCommand() helper in server.js
- Never query Upstash directly — always add new operations via server.js endpoints
- To inspect Redis data manually, use the Upstash console (requires browser login)