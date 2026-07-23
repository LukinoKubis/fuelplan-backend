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
straight TS port was low-friction, no restructuring needed.

## Local dev
- `npm run dev` — `tsx watch src/server.ts` (no build step needed for dev)
- `npm run build` — `tsc` → `dist/server.js`
- `npm start` — runs the built `dist/server.js` (what Railway/Nixpacks runs)

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
fuelplan:push:USERID         — web push subscription
fuelplan:note:USERID         — admin-set note (shown in admin dashboard)
fuelplan:orders:*            — LemonSqueezy order records

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