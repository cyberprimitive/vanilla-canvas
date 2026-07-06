# Deployment & Operations

Everything needed to deploy, verify, roll back, and troubleshoot Vanilla Canvas. Target time from zero to a verified production
deploy: ~20 minutes.

**Contents**

- Understand: [1. Architecture](#1-architecture-at-a-glance) · [2. Prerequisites](#2-prerequisites)
- Deploy: [3. Provision Supabase](#3-provision-supabase) · [4. Deploy to Vercel](#4-deploy-to-vercel)
- Operate: [5. Verification](#5-post-deploy-verification-smoke-test-3-min) · [6. Rollback](#6-rollback) · [7. Troubleshooting](#7-troubleshooting) · [8. Cost profile](#8-cost-profile)

## 1. Architecture at a glance

One Vercel project serves both the frontend and the API routes. Supabase provides Postgres (+pgvector), and Storage.
State while editing lives entirely in the browser; the database is only
touched on save, generate, and search.

| Component | Where | Notes |
|---|---|---|
| Frontend + API routes | Vercel (`web/`) | Serverless, deploys from git |
| Database + vector search | Supabase Postgres | Schema in `supabase/schema.sql` |
| Sticker files | Supabase Storage | Public bucket `canvas-images` |
| Image-generation keys | User's browser only | BYOK — never stored server-side |

## 2. Prerequisites

- GitHub repo (fork or clone of this one)
- Supabase account
- Vercel account
- Optional: a Google Gemini API key (semantic sticker search only; the app
  works without it — search degrades to literal matching)

## 3. Provision Supabase

1. Create a project at https://supabase.com.
2. Open **SQL Editor**, paste the full contents of `supabase/schema.sql`, run it.
   The script is **idempotent** — running it again is always safe, including on
   an existing production database (it only creates missing objects).
3. Verify: **Table Editor** shows `canvases` and `images`; **Storage** shows a
   public bucket `canvas-images`.
4. From **Settings → API Keys**, record:
   - Project URL (`https://<ref>.supabase.co`)
   - Publishable key (`sb_publishable_...`) — safe for the browser
   - Secret key (`sb_secret_...`) — server-only, treat as a secret

## 4. Deploy to Vercel

1. Import the GitHub repo at https://vercel.com/new.
2. **Set Root Directory to `web`** — the most common setup mistake; without it
   the build fails immediately.
3. Add environment variables (all environments):

| Variable | Value | Exposure |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL | Browser (public) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Publishable key | Browser (public) |
| `SUPABASE_SECRET_KEY` | Secret key | Server only |
| `GEMINI_API_KEY` | Gemini key (optional) | Server only |

   Server-only variables deliberately have no `NEXT_PUBLIC_` prefix — Next.js
   statically guarantees they never reach the client bundle. Never rename them
   with the prefix.

4. Deploy. Subsequent pushes to `main` auto-deploy; PRs get preview URLs with
   the same env vars.

## 5. Post-deploy verification (smoke test, ~3 min)

Run through this after every first deploy and any infra-level change:

1. **Page loads** — canvas renders, no console errors.
2. **Generation** — open menu ☰ → Image generation API, configure any provider
   key, click the canvas, generate a sticker. Confirms: `/api/generate`,
   provider adapter, background-removal pipeline, Storage upload.
3. **Search reuse** — type a word related to the sticker you just made in the
   prompt box; it should appear as a suggestion. Confirms: `/api/search`,
   embeddings, pgvector. (Skipped gracefully if `GEMINI_API_KEY` is unset.)
4. **Save & share** — click Save, open the copied link in a private window.
   Confirms: `canvases` insert + select under RLS.
5. **Print** — add a paper, type a heading, Ctrl/Cmd+P: the print preview must
   match the canvas.

If step 1 works but 2–4 fail, the problem is almost always env vars or
Supabase grants — see Troubleshooting.

## 6. Rollback

- **Application code**: Vercel → Deployments → previous deployment → *Promote
  to Production*. Instant, no rebuild. Because the app is stateless and the
  schema only ever gains objects (idempotent, additive script), old code always
  runs against the current database.
- **Database**: schema changes are additive-only by policy (see the upgrade
  path comments in `schema.sql`). Never `drop` in production; add columns and
  keep back-compat, as done for `kind` on canvas elements and `embedding` on
  images.
- **Data**: `canvases` rows are immutable by construction (RLS allows only
  select/insert) — there is no destructive write path to roll back.

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Build fails on Vercel immediately | Root Directory not set to `web` | Project Settings → Root Directory |
| "permission denied for table" | Table-level grants lost after manual drop/recreate | Re-run `schema.sql` (idempotent) |
| Save fails / snapshots won't load | RLS policies missing | Re-run `schema.sql` |
| Stickers generate but don't persist | `SUPABASE_SECRET_KEY` missing/wrong | Check Vercel env vars, redeploy |
| Search suggestions never appear | `GEMINI_API_KEY` unset or invalid | Optional feature; set the key or ignore — literal matching still works |
| Sticker has a white box instead of transparency | Background-removal failed; raw image fallback kicked in | Expected behavior, not an outage; retry the generation |
| Custom endpoint rejected | URL failed validation (non-HTTPS or private address) | Intentional SSRF guard; use a public HTTPS endpoint |

## 8. Cost profile

Designed to run at $0 fixed cost: Vercel Hobby + Supabase free tier.
Image-generation spend is entirely the user's (BYOK). The only server-side
metered call is one embedding request per generated sticker and per debounced
search query (`GEMINI_API_KEY`); sticker reuse via search exists specifically
to avoid repeat generation cost. A client-side semaphore caps concurrent
generations at 3 per user.

