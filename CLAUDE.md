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
POST /api/usage                 — requireAuth → remaining credits for the authed user
POST /api/history/save          — requireAuth, saves plan to Redis (max 5, newest first)
POST /api/history/get           — requireAuth, metadata list (id, savedAt, planName, macros)
POST /api/history/restore       — requireAuth, full plan JSON for a given planId
POST /api/history/delete        — requireAuth, removes a plan from history
POST /api/history/archive       — requireAuth, archives instead of hard-deleting
POST /api/recipes/save          — requireAuth, upserts a recipe (replaces by id if present, else assigns one and unshifts); 400 if the box is full (MAX_RECIPES = 300) rather than silently evicting a user-curated save
POST /api/recipes/list          — requireAuth, full array of the user's saved recipes
POST /api/recipes/delete        — requireAuth, { recipeId } → removes one recipe, 404 if not found

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
                                 evicting, unlike history's auto-archive)

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

### Railway migrated its default builder from Nixpacks to Railpack
Discovered the hard way adding this feature: a `nixpacks.toml` with
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

## Adding new endpoints
Follow the existing pattern in `src/server.ts`:
1. Add `requireAuth` middleware (populates `req.userId`/`req.userEmail`) for
   anything user-scoped, or `requireAdmin` for `/api/admin/*`
2. Do Redis operations via `redisCommand(command, ...args)`, keyed by `userId`
3. Return JSON response

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