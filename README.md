# Story & Learning — self-hosted

A private, kid-safe story-and-learning app for one child. Front end is a
Vite/React app; two serverless functions keep your Anthropic key server-side
and give the app one shared memory across devices.

- `src/` — the app (App.jsx is the whole thing; behavior is in SYSTEM_PROMPT).
- `api/chat.js` — proxy to Anthropic. Your API key lives here, never in the browser.
- `api/storage.js` — read/write memory in Upstash Redis, keyed to the child.
- `public/manifest.webmanifest` + icons — makes it installable to the home screen.

## What you'll need (all free tiers)
1. A GitHub account.
2. A Vercel account (hosting + the serverless functions).
3. An Anthropic API key — console.anthropic.com → API Keys.
4. An Upstash account — upstash.com (the shared database).

## Step 1 — Create the database (Upstash)
1. upstash.com → sign in → Create Database → Redis. Pick a region near you.
2. Open the database → REST API section. Copy the two values:
   `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.

## Step 2 — Put the code on GitHub
From this folder:
```
git init
git add .
git commit -m "Story & Learning"
```
Create a new empty repo on GitHub, then:
```
git remote add origin https://github.com/YOU/story-learn.git
git branch -M main
git push -u origin main
```

## Step 3 — Deploy on Vercel
1. vercel.com → Add New → Project → import your repo.
2. Framework preset: Vite (auto-detected). Leave build settings default.
3. Before deploying, open Environment Variables and add:
   - `ANTHROPIC_API_KEY` = your Anthropic key
   - `UPSTASH_REDIS_REST_URL` = from Upstash
   - `UPSTASH_REDIS_REST_TOKEN` = from Upstash
   - (optional) `CLAUDE_MODEL` = claude-sonnet-5  (or claude-haiku-4-5-20251001 for lower cost)
   - (optional) `CHILD_ID` = sterling
4. Deploy. You'll get a URL like https://story-learn-xxxx.vercel.app

Tip: confirm the current model names at docs.claude.com/en/docs/about-claude/models
if you want to change CLAUDE_MODEL later.

## Step 4 — Put it on the tablet's home screen
Open the Vercel URL on the device, then:
- iPad (Safari): Share → Add to Home Screen.
- Android (Chrome): ⋮ menu → Add to Home screen / Install app.
It launches full-screen with its own icon, like a normal app. The same URL on
the iPad and the Android share one memory, because both read the same database.

## Step 5 — Set the parent PIN first
Open the app once yourself and tap the "Story & Learning" title in the top bar.
Set the 4-digit PIN before your son uses it, so the parent report stays hidden.

## Local development (optional)
```
cp .env.example .env   # fill in real values
npm install
npm run dev            # app on http://localhost:5173
```
Note: the /api functions run on Vercel. For full local testing of the functions,
use `npx vercel dev` instead of `npm run dev` (requires the Vercel CLI + login).

## Notes
- Cost is Anthropic API usage per message (usage-based, small for one child) plus
  free hosting and database tiers.
- The PIN is a light lock to keep a curious kid out, not hardened security.
- To wipe memory, delete the keys in the Upstash console (or the whole database).
