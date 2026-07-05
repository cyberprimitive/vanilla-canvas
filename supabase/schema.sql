-- Vanilla Canvas — Supabase schema
-- Run this entire script once in Supabase Dashboard → SQL Editor.

-- If you ran a previous version of this schema, drop the old tables first
-- by uncommenting these lines:
-- drop table if exists public.canvas_elements;
-- drop table if exists public.canvas_settings;
-- drop table if exists public.canvases;

-- ============ Table ============

-- Each saved canvas is an IMMUTABLE snapshot identified by a short shareable
-- code (IKEA-style). Editing happens client-side only; clicking Save always
-- creates a new row with a new code. Elements are stored inline as JSONB:
-- [{ "id", "image_url", "prompt", "x", "y", "width", "height" }, ...]
-- background_color holds the paper theme: 'light' (warm vanilla ivory)
-- or 'dark' (its dark sepia counterpart).
create table if not exists public.canvases (
  code text primary key,
  background_color text not null default 'light',
  elements jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

-- ============ Grants + RLS ============

-- Table-level grants (usually automatic, but can be lost after manual
-- drop/recreate — "permission denied for table" means these are missing).
grant usage on schema public to anon, authenticated;
grant select, insert on public.canvases to anon, authenticated;

alter table public.canvases enable row level security;

-- select + insert only: no update/delete policies means snapshots are
-- immutable at the database level, even with the anon key.
drop policy if exists "anon read canvases" on public.canvases;
drop policy if exists "anon insert canvases" on public.canvases;
create policy "anon read canvases"   on public.canvases for select using (true);
create policy "anon insert canvases" on public.canvases for insert with check (true);

-- ============ Image library (with semantic search) ============

-- Every generated image is recorded here (prompt ↔ image, one row each),
-- powering the "reuse an existing sticker" suggestions in the prompt box.
-- Rows are inserted server-side by the API route using the secret key.
-- The embedding column holds a gemini-embedding-2 multimodal vector (768 dims)
-- of the sticker image aggregated with its prompt, enabling semantic matching
-- against the image content itself ("bike" finds a picture of a bicycle).
create extension if not exists vector;

create table if not exists public.images (
  id uuid primary key default gen_random_uuid(),
  prompt text not null,
  image_url text not null,
  embedding vector(768),
  created_at timestamptz not null default now()
);

-- Upgrade path: if the table predates semantic search, add the column.
alter table public.images add column if not exists embedding vector(768);

create index if not exists images_embedding_idx
  on public.images using hnsw (embedding vector_cosine_ops);

grant select on public.images to anon, authenticated;
grant select, insert on public.images to service_role;

alter table public.images enable row level security;

drop policy if exists "anon read images" on public.images;
create policy "anon read images" on public.images for select using (true);

-- Nearest-neighbor search over prompts, called from the /api/search route.
create or replace function public.match_images(
  query_embedding vector(768),
  match_count int default 8
)
returns table (prompt text, image_url text, similarity float)
language sql stable
as $$
  select i.prompt, i.image_url, 1 - (i.embedding <=> query_embedding) as similarity
  from public.images i
  where i.embedding is not null
  order by i.embedding <=> query_embedding
  limit match_count;
$$;

grant execute on function public.match_images to anon, authenticated, service_role;

-- ============ Storage: public bucket for generated images ============

insert into storage.buckets (id, name, public)
values ('canvas-images', 'canvas-images', true)
on conflict (id) do nothing;

-- Uploads are done by the Next.js API route using the secret key (bypasses RLS).
-- The bucket is public, so the frontend reads images via public URLs — no extra policy needed.
