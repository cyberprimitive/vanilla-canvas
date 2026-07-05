import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { embedQuery } from '@/lib/embedding';

export const runtime = 'nodejs';

// Match filtering, two layers:
// - MIN_SIMILARITY: absolute floor — queries unrelated to anything in the
//   library must return NOTHING (not the nearest junk). Raise it if unrelated
//   stickers still appear; lower it if real matches get dropped.
// - TOP_GAP: relative band — among passing results, keep only those close to
//   the best hit, so one strong match doesn't drag in weak tail results.
const MIN_SIMILARITY = 0.5;
const TOP_GAP = 0.08;

// Semantic sticker search: embed the query, nearest-neighbor over prompt
// embeddings in Postgres (pgvector). Returns 503 when embeddings aren't
// available so the client can fall back to literal matching.
export async function POST(request: Request) {
  let query: unknown;
  try {
    ({ query } = await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!query || typeof query !== 'string' || !query.trim()) {
    return NextResponse.json({ error: 'Missing "query"' }, { status: 400 });
  }

  const embedding = await embedQuery(query.trim());
  if (!embedding) {
    return NextResponse.json({ error: 'Semantic search unavailable' }, { status: 503 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!
  );
  const { data, error } = await supabase.rpc('match_images', {
    query_embedding: embedding,
    match_count: 24,
  });

  if (error) {
    console.error('match_images failed:', error);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }

  type Match = { prompt: string; image_url: string; similarity: number };
  const all = (data as Match[]) ?? [];
  const top = all[0]?.similarity ?? 0;
  const results = all.filter(
    (r) => r.similarity >= MIN_SIMILARITY && r.similarity >= top - TOP_GAP
  );
  return NextResponse.json({ results });
}
