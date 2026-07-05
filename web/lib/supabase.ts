import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// Elements on the canvas. They live in client state while editing and are
// persisted only inside a saved snapshot's JSONB column.

type ElementBase = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

// AI-generated sticker. `kind` is optional for back-compat with snapshots
// saved before paper elements existed (absent kind = image).
export type ImageElement = ElementBase & {
  kind?: 'image';
  image_url: string;
  prompt: string;
};

// Printable paper sheet with markdown content. On the canvas it renders as a
// single page: content beyond the first page is clipped from view but kept in
// full in `content` (editable, and printed in full across physical pages).
export type PaperElement = ElementBase & {
  kind: 'paper';
  sizeId: string;
  wMM: number;
  hMM: number;
  content: string;
};

export type CanvasElement = ImageElement | PaperElement;

export function isPaper(el: CanvasElement): el is PaperElement {
  return el.kind === 'paper';
}

// A saved, immutable canvas snapshot.
export type SavedCanvas = {
  code: string;
  background_color: string;
  elements: CanvasElement[];
  created_at: string;
};
