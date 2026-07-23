# Fuelplan Backend

Express + TypeScript API that proxies Claude for AI meal/training generation,
authenticates users (email/password + JWT) and tracks credits, and stores
user data (accounts, history, tracking) in Upstash Redis. Deployed to
Railway.

> Rebuild complete and live on `main`. See the root project's `PLAN.md` for
> phase history. Auth was migrated from activation codes to real accounts
> on 2026-07-19 — see `CLAUDE.md`'s "Auth" section for the current model.

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
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Almost everything — accounts, credits, history, tracking |
| `ADMIN_KEY` | `/admin` dashboard and any `/api/admin/*` route |
| `JWT_SECRET` | Every auth endpoint (signup/login) and every `requireAuth`-gated route — missing this takes down the whole app, not just auth (see `CLAUDE.md`) |

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

Railway is *supposed* to auto-deploy on push to `main`, but the GitHub
webhook has failed silently on this project before (push succeeds, Railway
just never rebuilds). Always verify after pushing:

```bash
git push origin main
railway status --json   # check the deployed commitHash matches your push
```

If it doesn't match, force it from your local checkout:

```bash
railway up --ci -m "description"   # builds + deploys whatever's checked out locally
```

Plan is Hobby ($5/mo) — the free tier blocks all deploys 8am–8pm
Europe/Amsterdam, which is worth knowing if a deploy mysteriously refuses to
start.

If a deploy breaks the backend: `git log --oneline`, `git revert HEAD`,
`git push origin main`, then verify/force-deploy as above.

## More detail

`CLAUDE.md` is the deeper reference (full endpoint list, Redis key
structure, admin dashboard, debugging steps) — written for AI-agent-driven
development on this repo, but equally useful for a human picking it up.
