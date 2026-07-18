# Fuelplan — Backend

> **Rebuild in progress (branch `rebuild/v2`)**: converted to TypeScript as
> part of the frontend rewrite (see `PLAN.md` in the project root). Source
> now lives at `src/server.ts`; `dist/` is the gitignored build output.
> `main` still runs the old plain-JS `server.js` until this is reviewed.

## What this is
Express.js API proxy for the Fuelplan PWA, written in TypeScript.
Deployed to Railway at https://fuelplan-backend-production.up.railway.app

## Hosting
- Platform: Railway (persistent Node.js server, no timeout ceiling)
- Auto-deploys on push to main branch of this repo — Railway's Nixpacks
  builder auto-detects the `build` script (`tsc`) and runs it before
  `start` (`node dist/server.js`), no railway.toml needed
- Deploy takes ~30-60 seconds
- Has a cold start delay of 10-20s after inactivity (first request wakes it)
- Environment variables are set via Railway CLI — never hardcode them

## Stack
Node.js, Express, TypeScript, Axios, Upstash Redis (REST API — no persistent
connection needed). Single-file source at `src/server.ts`, same structure as
the old `server.js` — this codebase was simple/well-organized enough that a
straight TS port was low-friction, no restructuring needed.

## Local dev
- `npm run dev` — `tsx watch src/server.ts` (no build step needed for dev)
- `npm run build` — `tsc` → `dist/server.js`
- `npm start` — runs the built `dist/server.js` (what Railway/Nixpacks runs)

## Key endpoints
POST /api/claude               — validates code, decrements credit, proxies to Anthropic
POST /api/usage                — returns remaining credits for a code
POST /api/history/save         — saves plan to Redis (max 5 per code, newest first)
POST /api/history/get          — returns metadata list (id, savedAt, planName, macros)
POST /api/history/restore      — returns full plan JSON for a given planId
POST /api/history/delete       — removes a plan from history
POST /api/account/link-email   — links activation code to email (SHA-256 hashed)
POST /api/account/recover      — sends activation code to email if linked (rate: 3/hour)

## Redis key structure
fuelplan:codes              — Set of valid activation codes
fuelplan:remaining:CODE     — remaining generations (integer string)
fuelplan:history:CODE       — JSON array, max 5 entries, newest first
fuelplan:email:EMAIL_HASH   — activation code linked to this email hash
fuelplan:email_of:CODE      — email hash for a given code (reverse lookup)

## Environment variables (managed via Railway CLI, not hardcoded)
ANTHROPIC_API_KEY          — Anthropic API key
UPSTASH_REDIS_REST_URL     — Upstash REST endpoint
UPSTASH_REDIS_REST_TOKEN   — Upstash auth token
ADMIN_KEY                  — key required for /api/admin/* endpoints
DEFAULT_PLAN_LIMIT         — how many generations a new code gets (e.g. 10)
FRONTEND_URL               — https://fuelplan.fit (used in CORS allowlist)
RESEND_API_KEY             — Resend.com API key (free tier: 3000 emails/month)
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
- If env var is missing: railway variables — check it exists, set it if not
- If deploy failed: railway status — check the deploy log for build errors

## Adding new endpoints
Follow the existing pattern in server.js:
1. Validate activationCode from req.body
2. Call validateCode(code) — returns true/false
3. Do Redis operations via redisCommand(command, ...args)
4. Return JSON response
All admin endpoints must call requireAdmin(req, res, next) middleware.

## Deploy process
git add -A
git commit -m "feat: description"
git push origin main

## If a deploy breaks the backend
git log --oneline        — find the last working commit
git revert HEAD          — revert the broken commit
git push origin main     — Railway auto-deploys the revert

## Upstash Redis
- Managed at https://console.upstash.com — no CLI available
- Credentials (UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN) 
  are already set as Railway environment variables
- All Redis operations go through the redisCommand() helper in server.js
- Never query Upstash directly — always add new operations via server.js endpoints
- To inspect Redis data manually, use the Upstash console (requires browser login)