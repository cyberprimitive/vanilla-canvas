# Vanilla Canvas

A journal-style web canvas where AI-generated stickers and printable markdown papers live together. Click anywhere and describe something — an AI model draws it as a hand-drawn journal sticker with a die-cut white edge, placed right where you clicked. Add a paper (a real A4/A5/A3/Letter sheet on the canvas), write on it in markdown, decorate it with stickers, and print the result exactly as it looks on screen. Share any canvas as an immutable snapshot under a 6-character code.

Built with Next.js 15 (App Router, TypeScript) and Supabase (Postgres + pgvector + Storage), deployed as a single Vercel app — no separate backend.

**Every line of code in this repo was written by AI coding agents — none by hand.** The feature set, architecture, UX behavior, and the trade-offs are my decisions; the agents implemented them under iterative direction, review, and testing.

https://github.com/user-attachments/assets/3972bd3b-e4a8-46b1-822f-a4a085a20c10

## Features

### Stickers

- **Click-to-generate.** Click any spot, type a prompt, and the image appears there — in one consistent hand-drawn journal-sticker style with automatic background removal and a white die-cut edge, no matter which model generated it.
- **Bring your own key.** In-app presets for Google Gemini, OpenAI (`gpt-image-1`), xAI Grok, and OpenRouter, plus a custom-endpoint option (any OpenAI-/Gemini-/OpenRouter-compatible API). Keys live only in the user's browser and are passed through per request; the server never stores them.
- **Sticker library with semantic search.** Every generated sticker is indexed with a multimodal embedding of the image itself (not just its prompt). While you type, existing stickers are ranked by meaning — click one to place it instantly, no generation call, no API cost.
- **Direct manipulation.** Drag, aspect-locked resize, duplicate, delete, and one-click PNG download for any sticker.

### Papers

- **Printable sheets on the canvas.** "Add paper" drops a true-to-size page (A4, A5, A3, or Letter) modeled in millimetres. Markdown documents can't position stickers freely — so instead, the paper brings the document onto the canvas.
- **Markdown editing** in a split-pane editor (source + live preview) with a formatting toolbar: headings, bold/italic/strikethrough, lists, task lists, quotes, code, and more.
- **WYSIWYG printing.** The canvas view, the editor preview, and the printed page share one markdown renderer and the same font metrics — what you see is what prints. Stickers overlapping a paper are printed with it, exactly where you placed them.
- **Multi-page aware.** Long content shows a stacked-sheet hint on the canvas (clipped at the last whole line — never mid-line) and flows across as many physical pages as needed when printed.
- **One-click download** of the paper as a `.md` file, named after its first heading.

### Canvas

- **Save & Share.** One click freezes the canvas as an immutable snapshot under a 6-character code (IKEA-planner-style) and copies the link. Opening a code loads a fresh working copy; old codes keep working forever.
- **Undo / redo** — gesture-granular (a whole drag is one step), up to 100 steps.
- **Zoom to cursor**, light/dark paper themes (vanilla ivory / kraft — grain and vignette are pure CSS, zero image assets), responsive layout down to phone widths, and touch support.

## Architecture

```
Browser (React state = the working canvas; nothing touches the DB while editing)
  │  prompt + user's API config (localStorage)
  ▼
Next.js API routes (deployed with the frontend on Vercel)
  ├─ /api/generate → provider adapter → background-removal pipeline (sharp) → Supabase Storage
  └─ /api/search   → gemini-embedding-2 → pgvector cosine nearest-neighbor
  ▼
Supabase: canvases (immutable snapshots) · images (sticker library + embeddings) · canvas-images bucket
```

```
vanilla-canvas/
├── web/        # Next.js app: frontend + API routes
└── supabase/   # Database schema (idempotent SQL script)
```

## Engineering highlights

**A uniform sticker style from models that can't do transparency.** No mainstream image model reliably outputs an alpha channel, so all providers share one pipeline: a style suffix forces a single object on a pure white background, then the server flood-fills near-white pixels *from the image borders* to transparent (interior whites survive), trims the margins, normalizes to a fixed width, and dilates the alpha to add a white die-cut edge. Normalizing width *before* adding the fixed border is what makes edge thickness visually uniform across stickers. Post-processing failures fall back to the raw image rather than failing the generation.

**Multimodal search that matches the picture, not the caption.** Each sticker's embedding aggregates the image with its prompt in a shared text-image space, so a text query finds what's actually drawn. The UI layers two rankings: instant literal substring/token matching, plus a debounced server-side vector search whose results only *add* to the list (deduplicated, never reordering) — so suggestions never flash or jump while typing. An absolute similarity floor plus a relative band below the best hit keeps junk queries empty, and everything degrades gracefully to literal matching if embeddings are unavailable.

**True WYSIWYG print.** Papers are modeled in millimetres (2 px/mm design scale) with a fixed physical body-font size, so the canvas, the editor preview, and the printed page render identically — a smaller paper simply fits fewer characters per line, like real paper. Printing uses a hidden iframe with `@page` sizing: the markdown is real reflowing HTML (never a raster screenshot), the browser breaks between whole lines across pages, and overlapping stickers are positioned by their offset from the page origin, each cropped individually to the printable window so stray boxes can't trigger shrink-to-fit or phantom pages.

**Immutable snapshots by construction.** Saving inserts one row: a random 6-char code plus the entire canvas state as JSONB. Row-level security allows only `select` and `insert` — no update or delete is possible with the public key, so shared snapshots can't be tampered with. Editing is purely client-side state; a `beforeunload` warning fires only when there's actual unsaved work.

**BYOK without the security foot-guns.** User keys never leave the browser except per-request in flight; server-side keys have no `NEXT_PUBLIC_` prefix so Next.js keeps them out of the bundle; custom base URLs are validated (public HTTPS only) so the API route can't be used to probe internal networks.

**Interaction details that don't regress.** Zoom-to-cursor with element controls counter-scaled to constant screen size; a two-zone hover model (image body triggers, body + controls sustains, with an invisible hover bridge) so hidden buttons occupy no space and canvas clicks pass through; touch taps replace hover with a ghost-click guard; a client-side FIFO semaphore caps concurrent generations at 3 and queues the rest silently.

## Setup

> Full production guide — smoke-test checklist, rollback procedure, troubleshooting: **[DEPLOYMENT.md](DEPLOYMENT.md)**.

### 1. Supabase

1. Create a project at https://supabase.com (free tier is fine).
2. Run `supabase/schema.sql` in the SQL Editor — it creates the `canvases` and `images` tables, insert-only RLS policies, pgvector index, and the public `canvas-images` storage bucket. The script is idempotent.
3. From **Settings → API Keys**, note the Project URL, the publishable key (`sb_publishable_...`), and the secret key (`sb_secret_...`, server-only).

### 2. Image generation keys (BYOK)

Users configure their own key in-app (menu ☰ → **Image generation API**).

### 3. Local development

```bash
cd web
npm install
cp .env.local.example .env.local   # fill in the four values below
npm run dev                        # http://localhost:3000
```

| Env var | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL (`https://<ref>.supabase.co`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Publishable key (browser) |
| `SUPABASE_SECRET_KEY` | Secret key (server-only) |
| `GEMINI_API_KEY` | Embedding search only (server-only) |

### 4. Deploy to Vercel

Import the repo at https://vercel.com (free Hobby plan suffices), **set Root Directory to `web`**, add the same four environment variables, and deploy. Frontend and API routes ship together — no CORS setup needed.
