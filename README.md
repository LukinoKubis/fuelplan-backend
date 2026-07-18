# Fuelplan Backend

Express + TypeScript API that proxies Claude for AI meal/training generation,
validates activation codes and credits, and stores user data (accounts,
history, tracking) in Upstash Redis. Deployed to Railway.

> Currently mid-rebuild on branch `rebuild/v2` (see the root project's
> `PLAN.md`). This README describes the TypeScript version — `main` has
> already been merged to it as of the Phase 0/1/2 rebuild.

## Stack

Node.js 18+, Express, TypeScript, Axios, Upstash Redis (REST API), web-push
(VAPID), LemonSqueezy (payments).

## Setup

```bash
npm install
cp .env.example .env
# fill in .env — see below for what's required vs optional
npm run dev
```

`npm run dev` runs `tsx watch src/server.ts` — no build step needed for local
development, just edit and save.

Verify it's running:

```bash
curl http://localhost:3000/
# {"status":"ok","service":"fuelplan-backend"}
```

## Environment variables

See `.env.example` for the full list with descriptions. Minimum to run
anything useful:

| Variable | Required for |
|---|---|
| `ANTHROPIC_API_KEY` | Meal/plan generation (`/api/claude`) |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Almost everything — activation codes, credits, history, tracking |
| `ADMIN_KEY` | `/admin` dashboard and any `/api/admin/*` route |

Everything else (email recovery, push notifications, LemonSqueezy payments)
degrades gracefully — those endpoints return early or no-op without their
env vars set, rather than crashing the server.

## Scripts

```bash
npm run dev     # tsx watch src/server.ts — local dev, no build step
npm run build   # tsc -> dist/server.js
npm start       # node dist/server.js — what Railway/Nixpacks runs in production
```

## Project structure

Single-file backend by design — `src/server.ts` has every route, in the
order: LemonSqueezy webhook (needs raw body, must run before the JSON
parser) → CORS middleware → routes, grouped by area (Claude proxy, history,
tracking, push, admin, account/email recovery, checkout) → Redis/helper
functions at the bottom. See `CLAUDE.md` for the full endpoint list and
"adding a new endpoint" pattern.

## Deploying

Railway auto-deploys on push to `main`. Its Nixpacks builder auto-detects
the `build` script and runs it before `start` — no `railway.toml` needed.

```bash
git push origin main   # Railway builds + deploys automatically, ~30-60s
railway logs            # tail logs if something looks wrong
```

If a deploy breaks the backend: `git log --oneline`, `git revert HEAD`,
`git push origin main` — Railway redeploys the revert within the same window.

## More detail

`CLAUDE.md` is the deeper reference (full endpoint list, Redis key
structure, admin dashboard, debugging steps) — written for AI-agent-driven
development on this repo, but equally useful for a human picking it up.
