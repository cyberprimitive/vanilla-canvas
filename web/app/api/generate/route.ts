import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import crypto from 'crypto';
import { embedSticker } from '@/lib/embedding';

export const runtime = 'nodejs';
export const maxDuration = 60; // image generation can take 10-20s

const BUCKET = 'canvas-images';

// Preset providers resolve baseUrl/format server-side; only 'custom' uses a
// client-supplied base URL. Generation is strictly BYOK: the server's
// GEMINI_API_KEY env var is for embeddings only (lib/embedding.ts), never a
// generation fallback.
const PROVIDER_DEFAULTS: Record<
  string,
  { baseUrl: string; format: 'gemini' | 'openai' | 'openrouter'; model: string }
> = {
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com',
    format: 'gemini',
    model: 'gemini-3.1-flash-lite-image',
  },
  openai: { baseUrl: 'https://api.openai.com', format: 'openai', model: 'gpt-image-1' },
  xai: { baseUrl: 'https://api.x.ai', format: 'openai', model: 'grok-imagine-image-quality' },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api',
    format: 'openrouter',
    model: 'google/gemini-2.5-flash-image',
  },
};

// Unified journal-sticker style so cutouts look natural on the canvas.
const STYLE_SUFFIX =
  '. Rendered as a cute hand-drawn journal sticker (junk journal / planner sticker style): ' +
  'a single isolated object, centered, flat pastel colors, clean bold outline, ' +
  'slightly whimsical hand-drawn look, no background scenery, no other objects, no text, ' +
  'no white halo or glow around the object, the colored outline is the outermost edge';

// All providers use the same pipeline: force a white background via the prompt,
// then key it out server-side. (OpenAI's native background:'transparent' exists
// but its output quality is inconsistent, so we don't rely on it.)
const WHITE_BG_SUFFIX = ', on a pure solid white background (#ffffff), no shadow, no reflection.';

const WHITE_THRESHOLD = 235;

// After trimming, every sticker is normalized to this pixel width (height
// follows the aspect ratio, bounded for extreme shapes), THEN a fixed-width
// die-cut edge is added. Same border ÷ width for every sticker means the
// edge renders identically thick on the canvas, no matter how large the
// object happened to be in the generated image.
const STICKER_WIDTH = 800;
const STICKER_MAX_HEIGHT = 1600;
const STICKER_BORDER = 32;

type GenerateBody = {
  prompt?: string;
  provider?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  format?: 'gemini' | 'openai' | 'openrouter';
};

// ---------- helpers ----------

// Basic SSRF guard for user-supplied base URLs.
function sanitizeBaseUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return null;
    const h = u.hostname;
    if (
      h === 'localhost' ||
      /^127\./.test(h) ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      /^169\.254\./.test(h) ||
      h.endsWith('.internal') ||
      h.endsWith('.local')
    ) {
      return null;
    }
    return (u.origin + u.pathname).replace(/\/+$/, '');
  } catch {
    return null;
  }
}

async function hasTransparency(buffer: Buffer): Promise<boolean> {
  const stats = await sharp(buffer).ensureAlpha().stats();
  const alpha = stats.channels[3];
  return alpha !== undefined && alpha.min < 250;
}

// Border-connected flood fill: turns near-white pixels reachable from the image
// edges transparent, without punching holes in white areas inside the object.
async function removeWhiteBackground(inputBuffer: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(inputBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const isWhite = (i: number) =>
    data[i] >= WHITE_THRESHOLD &&
    data[i + 1] >= WHITE_THRESHOLD &&
    data[i + 2] >= WHITE_THRESHOLD;

  const visited = new Uint8Array(width * height);
  const stack: number[] = [];

  for (let x = 0; x < width; x++) {
    stack.push(x, (height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    stack.push(y * width, y * width + width - 1);
  }

  while (stack.length) {
    const p = stack.pop()!;
    if (visited[p]) continue;
    visited[p] = 1;
    const i = p * channels;
    if (!isWhite(i)) continue;
    data[i + 3] = 0; // transparent

    const x = p % width;
    const y = (p / width) | 0;
    if (x > 0) stack.push(p - 1);
    if (x < width - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - width);
    if (y < height - 1) stack.push(p + width);
  }

  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

async function trimMargins(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer).trim().png().toBuffer();
}

// Sticker die-cut edge: dilate the object's silhouette by ~`border` px, fill
// it white, and composite the object on top. Also hides any keying fringe.
async function addStickerBorder(input: Buffer, border: number): Promise<Buffer> {
  // Pad first so the edge isn't clipped at the image bounds.
  const padded = await sharp(input)
    .extend({
      top: border,
      bottom: border,
      left: border,
      right: border,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  const meta = await sharp(padded).metadata();

  // Dilate: blur the alpha channel outward, then harden it with a threshold.
  const mask = await sharp(padded)
    .extractChannel('alpha')
    .blur(border / 2)
    .threshold(10)
    .toBuffer();

  // White silhouette with the dilated mask as its alpha.
  const whiteBase = await sharp({
    create: {
      width: meta.width!,
      height: meta.height!,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .joinChannel(mask)
    .png()
    .toBuffer();

  return sharp(whiteBase).composite([{ input: padded }]).png().toBuffer();
}

// ---------- provider adapters ----------

async function generateGemini(
  baseUrl: string,
  model: string,
  apiKey: string,
  prompt: string
): Promise<Buffer> {
  const res = await fetch(`${baseUrl}/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    }),
  });
  if (!res.ok) {
    throw new UpstreamError(res.status, await res.text());
  }
  const data = await res.json();
  const parts: Array<{ inlineData?: { data: string } }> =
    data?.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((p) => p.inlineData?.data);
  if (!imagePart?.inlineData) {
    throw new UpstreamError(502, `Model returned no image: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return Buffer.from(imagePart.inlineData.data, 'base64');
}

async function generateOpenAI(
  baseUrl: string,
  model: string,
  apiKey: string,
  prompt: string
): Promise<Buffer> {
  const body: Record<string, unknown> = { model, prompt, n: 1 };
  // gpt-image-* returns b64 by default and rejects response_format; other
  // OpenAI-compatible providers (xAI, proxies) return URLs unless asked.
  if (!model.startsWith('gpt-image')) {
    body.response_format = 'b64_json';
  }
  const res = await fetch(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new UpstreamError(res.status, await res.text());
  }
  const data = await res.json();
  const item = data?.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
  // Fallback: some providers ignore response_format and return a temporary URL.
  if (typeof item?.url === 'string' && item.url.startsWith('https://')) {
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) throw new UpstreamError(502, `Failed to download image: ${imgRes.status}`);
    return Buffer.from(await imgRes.arrayBuffer());
  }
  throw new UpstreamError(502, `Model returned no image: ${JSON.stringify(data).slice(0, 300)}`);
}

// OpenRouter routes image generation through chat completions; images come
// back as data URIs on the message.
async function generateOpenRouter(
  baseUrl: string,
  model: string,
  apiKey: string,
  prompt: string
): Promise<Buffer> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      modalities: ['image', 'text'],
    }),
  });
  if (!res.ok) {
    throw new UpstreamError(res.status, await res.text());
  }
  const data = await res.json();
  const dataUri: string | undefined = data?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!dataUri?.startsWith('data:image/')) {
    throw new UpstreamError(502, `Model returned no image: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64');
}

class UpstreamError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------- route ----------

export async function POST(request: Request) {
  let body: GenerateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const prompt = body.prompt?.trim();
  if (!prompt) {
    return NextResponse.json({ error: 'Missing "prompt"' }, { status: 400 });
  }

  // Resolve provider config. Preset providers use server-side defaults; only
  // 'custom' trusts a client-supplied base URL (after sanitizing).
  const provider = body.provider ?? 'gemini';
  let apiKey = body.apiKey?.trim() ?? '';
  let model = body.model?.trim() ?? '';
  let baseUrl: string | null;
  let format: 'gemini' | 'openai' | 'openrouter';

  if (provider === 'custom') {
    format = body.format ?? 'openai';
    baseUrl = sanitizeBaseUrl(body.baseUrl ?? '');
    if (!baseUrl) {
      return NextResponse.json(
        { error: 'Invalid custom base URL (must be a public https:// endpoint)' },
        { status: 400 }
      );
    }
    if (!model) {
      return NextResponse.json({ error: 'Missing model for custom endpoint' }, { status: 400 });
    }
  } else {
    const preset = PROVIDER_DEFAULTS[provider];
    if (!preset) {
      return NextResponse.json({ error: `Unknown provider "${provider}"` }, { status: 400 });
    }
    format = preset.format;
    baseUrl = preset.baseUrl;
    model = model || preset.model;
  }

  if (!apiKey) {
    return NextResponse.json(
      { error: 'No API key configured. Open API settings and add your key.' },
      { status: 401 }
    );
  }

  const fullPrompt = prompt + STYLE_SUFFIX + WHITE_BG_SUFFIX;

  try {
    // 1. Generate
    let rawBuffer: Buffer;
    if (format === 'openai') {
      rawBuffer = await generateOpenAI(baseUrl, model, apiKey, fullPrompt);
    } else if (format === 'openrouter') {
      rawBuffer = await generateOpenRouter(baseUrl, model, apiKey, fullPrompt);
    } else {
      rawBuffer = await generateGemini(baseUrl, model, apiKey, fullPrompt);
    }

    // 2. Post-process → keyed, trimmed PNG with a white sticker edge
    let buffer: Buffer;
    try {
      const keyed = (await hasTransparency(rawBuffer))
        ? rawBuffer
        : await removeWhiteBackground(rawBuffer);
      const trimmed = await trimMargins(keyed);
      const normalized = await sharp(trimmed)
        .resize(STICKER_WIDTH, STICKER_MAX_HEIGHT, { fit: 'inside' })
        .png()
        .toBuffer();
      buffer = await addStickerBorder(normalized, STICKER_BORDER);
    } catch (err) {
      console.error('Post-processing failed, uploading original:', err);
      buffer = rawBuffer;
    }

    // 3. Upload to Supabase Storage (secret key is server-only, bypasses RLS)
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!
    );
    const filePath = `${Date.now()}-${crypto.randomUUID()}.png`;
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(filePath, buffer, { contentType: 'image/png' });

    if (uploadError) {
      console.error('Supabase upload error:', uploadError);
      return NextResponse.json({ error: 'Image upload failed' }, { status: 500 });
    }

    // 4. Record prompt ↔ image in the library, with a multimodal embedding
    //    (image + prompt) for semantic search (both non-fatal if they fail)
    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(filePath);
    const embedding = await embedSticker(buffer.toString('base64'), prompt);
    const { error: libError } = await supabase
      .from('images')
      .insert({ prompt, image_url: urlData.publicUrl, embedding });
    if (libError) console.error('Image library insert failed:', libError);

    // 5. Return public URL
    return NextResponse.json({ imageUrl: urlData.publicUrl });
  } catch (err) {
    if (err instanceof UpstreamError) {
      console.error('Upstream error:', err.status, err.message.slice(0, 500));
      // Pass through auth/quota errors so the frontend can show a useful message.
      const status = err.status === 401 || err.status === 403 || err.status === 429 ? err.status : 502;
      const hint =
        status === 429
          ? 'API quota exceeded — check your plan/billing.'
          : status === 401 || status === 403
            ? 'API key rejected — check it in API settings.'
            : 'Image generation failed.';
      return NextResponse.json({ error: hint }, { status });
    }
    console.error('Unexpected error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
