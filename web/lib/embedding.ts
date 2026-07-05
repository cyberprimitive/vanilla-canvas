// Server-only helpers: multimodal embeddings via gemini-embedding-2 using the
// site's GEMINI_API_KEY env var. Stickers are embedded as image + prompt text
// (one aggregated vector); search queries are text. Both land in the same
// embedding space, so a text query can match image content directly.
// Never import this from client components.

const EMBEDDING_MODEL = 'gemini-embedding-2';
export const EMBEDDING_DIMS = 768; // auto-normalized by the model

type Part = { text: string } | { inline_data: { mime_type: string; data: string } };

// Returns null when no server key is configured or the call fails — callers
// treat embeddings as an optional enhancement, never a hard dependency.
async function embedParts(parts: Part[]): Promise<number[] | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          content: { parts },
          output_dimensionality: EMBEDDING_DIMS,
        }),
      }
    );
    if (!res.ok) {
      console.error('Embedding failed:', res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const data = await res.json();
    const values: number[] | undefined =
      data?.embedding?.values ?? data?.embeddings?.[0]?.values;
    return Array.isArray(values) && values.length === EMBEDDING_DIMS ? values : null;
  } catch (err) {
    console.error('Embedding failed:', err);
    return null;
  }
}

// One aggregated embedding for a sticker: its image plus its prompt, following
// the recommended document format for retrieval.
export async function embedSticker(
  pngBase64: string,
  prompt: string
): Promise<number[] | null> {
  return embedParts([
    { text: `title: none | text: ${prompt}` },
    { inline_data: { mime_type: 'image/png', data: pngBase64 } },
  ]);
}

// Search-query embedding, using the recommended asymmetric retrieval prefix
// (gemini-embedding-2 takes task instructions in the prompt, not task_type).
export async function embedQuery(query: string): Promise<number[] | null> {
  return embedParts([{ text: `task: search result | query: ${query}` }]);
}
