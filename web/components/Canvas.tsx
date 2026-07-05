'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  supabase,
  isPaper,
  type CanvasElement,
  type ImageElement,
  type PaperElement,
  type SavedCanvas,
} from '@/lib/supabase';
import { PAPER_SIZES, PX_PER_MM, pageMarginMM, pagePad, PRINT_FONT_MM, STACK_OFFSET } from '@/lib/paper';
import PaperPages from '@/components/Paper';
import { renderMarkdown } from '@/lib/markdown';
import {
  PRESETS,
  loadApiConfig,
  saveApiConfig,
  type ApiConfig,
  type ApiFormat,
  type ApiProvider,
} from '@/lib/apiConfig';

const API_URL = '/api/generate';
const DEFAULT_SIZE = 128;

// Zoom limits. For an "infinite" canvas feel, widen these and add drag-panning;
// the transform math stays identical.
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;
// Horizontal wheel-scrolling is FINITE: the viewport can't travel further
// than this many world px from the origin in either direction.
const PAN_LIMIT = 2000;

// Loading effect: a wave traveling outward through the background dot grid.
const WAVE_RADIUS_CELLS = 3; // how many grid cells the wave reaches
const WAVE_PERIOD_S = 2.5; // seconds per wave cycle
const WAVE_SPEED = 70; // world px/s the crest travels

// Cap on simultaneous generations, to stay clear of provider rate limits.
const MAX_CONCURRENT_GENERATIONS = 3;
// Wheel sensitivity: zoom factor = exp(-deltaY * sensitivity). One mouse-wheel
// notch (deltaY ≈ 100) changes zoom by ~10%; lower = slower.
const ZOOM_SENSITIVITY = 0.001;

// Wait this long after the user stops typing before hitting /api/search.
const SEARCH_DEBOUNCE_MS = 800;

// How many library stickers to show under the prompt input (the grid is
// capped at ~2.5 rows tall and scrolls).
const LIBRARY_MAX = 24;
const DOT_GRID = 24; // world-space spacing of the bullet-journal dot grid

// Shareable canvas code (IKEA-style). Alphabet avoids ambiguous characters.
const CODE_LENGTH = 6;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// crypto.randomUUID only exists in secure contexts (https / localhost).
// Opening the dev server from a phone via the machine's LAN IP is plain
// http, where calling it throws — the reason adding images "errors" on
// mobile. Fall back to a hand-rolled v4 UUID there.
const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

// Markdown marks for the editor's left rail. `wrap` surrounds the selection
// (or a placeholder), `line` prefixes every selected line, `block` inserts a
// standalone snippet on its own line.
type EditorMark = {
  title: string;
  icon: React.ReactNode;
  wrap?: [string, string];
  line?: (i: number) => string;
  block?: string;
  placeholder?: string;
};

const markIcon = (paths: React.ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {paths}
  </svg>
);

// Paginated editor preview: renders the draft as REAL pages (same sheet,
// margin and font as the canvas/print), breaking between whole lines exactly
// like the print flow. Line bottoms are measured on a hidden copy — the same
// trick Paper.tsx uses for its one-page clip — then each page shows a slice
// of the full document via a negative top margin inside a clipping window.
function PreviewPages({
  paper,
  html,
  objects,
  zoom,
}: {
  paper: PaperElement;
  html: string;
  objects: ImageElement[];
  zoom: number;
}) {
  const dW = paper.wMM * PX_PER_MM;
  const dH = paper.hMM * PX_PER_MM;
  const pad = pagePad(paper.wMM, paper.hMM);
  const innerW = dW - pad * 2;
  const innerH = dH - pad * 2;
  const fontSize = PRINT_FONT_MM * PX_PER_MM;
  const pScale = paper.width / dW; // world px per design px

  const measureRef = useRef<HTMLDivElement>(null);
  // Page slices as [start, end) offsets into the flowed document (design px).
  // `end` is the page's own cut line: clipping there — not at the full page
  // capacity — is what keeps a line that straddles the boundary from showing
  // its top half at the bottom of the page.
  const [pages, setPages] = useState<{ start: number; end: number }[]>([{ start: 0, end: 0 }]);
  useLayoutEffect(() => {
    const c = measureRef.current;
    if (!c) return;
    const full = c.scrollHeight;
    const box = c.getBoundingClientRect();
    const sc = box.height / full || 1; // undo any ancestor scaling
    const top = box.top;
    const bottoms: number[] = [];
    const walk = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let node: Node | null;
    while ((node = walk.nextNode())) {
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      range.selectNodeContents(node);
      for (const r of Array.from(range.getClientRects())) {
        if (r.height > 0) bottoms.push((r.bottom - top) / sc);
      }
    }
    c.querySelectorAll('img, hr, tr, pre, blockquote, input').forEach((n) =>
      bottoms.push((n.getBoundingClientRect().bottom - top) / sc)
    );
    bottoms.sort((x, y) => x - y);
    // Greedy pagination: each page ends at the last whole line that fits.
    const next: { start: number; end: number }[] = [];
    let s = 0;
    for (;;) {
      if (full - s <= innerH + 0.5) {
        next.push({ start: s, end: full });
        break;
      }
      let best = 0;
      for (const b of bottoms) {
        if (b > s + 0.5 && b <= s + innerH) best = b;
      }
      const cut = best > 0 ? best : s + innerH; // oversize block: hard cut
      if (cut <= s + 1) {
        next.push({ start: s, end: full });
        break; // safety against infinite loops
      }
      next.push({ start: s, end: cut });
      s = cut;
    }
    setPages(next);
  }, [html, innerH]);

  return (
    <>
      {/* Hidden measurer at design metrics (unzoomed, so rects are 1:1). */}
      <div
        ref={measureRef}
        className="md-body editor-measure"
        style={{ width: innerW, fontSize }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {pages.map(({ start, end }, i) => (
        <div key={i} className="editor-page" style={{ width: dW, height: dH, zoom }}>
          <div
            className="editor-page-clip"
            style={{ top: pad, left: pad, width: innerW, height: Math.min(innerH, end - start) }}
          >
            <div
              className="md-body"
              style={{ width: innerW, fontSize, marginTop: -start }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
          {i === 0 && (
            /* Objects overlapping the paper, exactly as they print: pinned to
               the page corner, clipped before the right/bottom margins, and
               only on the first page. */
            <div className="editor-stickers" style={{ width: dW - pad, height: dH - pad }}>
              {objects.map((e) => (
                <img
                  key={e.id}
                  src={e.image_url}
                  alt={e.prompt}
                  style={{
                    left: (e.x - paper.x) / pScale,
                    top: (e.y - paper.y) / pScale,
                    width: e.width / pScale,
                    height: e.height / pScale,
                  }}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

const EDITOR_MARKS: EditorMark[] = [
  {
    title: 'Heading 1',
    line: () => '# ',
    icon: markIcon(
      <>
        <path d="M4 12h8" />
        <path d="M4 18V6" />
        <path d="M12 18V6" />
        <path d="m17 12 3-2v8" />
      </>
    ),
  },
  {
    title: 'Heading 2',
    line: () => '## ',
    icon: markIcon(
      <>
        <path d="M4 12h8" />
        <path d="M4 18V6" />
        <path d="M12 18V6" />
        <path d="M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1" />
      </>
    ),
  },
  {
    title: 'Heading 3',
    line: () => '### ',
    icon: markIcon(
      <>
        <path d="M4 12h8" />
        <path d="M4 18V6" />
        <path d="M12 18V6" />
        <path d="M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2" />
        <path d="M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2" />
      </>
    ),
  },
  {
    title: 'Bold',
    wrap: ['**', '**'],
    icon: markIcon(
      <>
        <path d="M14 12a4 4 0 0 0 0-8H6v8" />
        <path d="M15 20a4 4 0 0 0 0-8H6v8Z" />
      </>
    ),
  },
  {
    title: 'Italic',
    wrap: ['*', '*'],
    icon: markIcon(
      <>
        <line x1="19" x2="10" y1="4" y2="4" />
        <line x1="14" x2="5" y1="20" y2="20" />
        <line x1="15" x2="9" y1="4" y2="20" />
      </>
    ),
  },
  {
    title: 'Strikethrough',
    wrap: ['~~', '~~'],
    icon: markIcon(
      <>
        <path d="M16 4H9a3 3 0 0 0-2.83 4" />
        <path d="M14 12a4 4 0 0 1 0 8H6" />
        <line x1="4" x2="20" y1="12" y2="12" />
      </>
    ),
  },
  {
    title: 'Bulleted list',
    line: () => '- ',
    icon: markIcon(
      <>
        <path d="M3 6h.01" />
        <path d="M3 12h.01" />
        <path d="M3 18h.01" />
        <path d="M8 6h13" />
        <path d="M8 12h13" />
        <path d="M8 18h13" />
      </>
    ),
  },
  {
    title: 'Numbered list',
    line: (i) => `${i + 1}. `,
    icon: markIcon(
      <>
        <path d="M10 6h11" />
        <path d="M10 12h11" />
        <path d="M10 18h11" />
        <path d="M4 6h1v4" />
        <path d="M4 10h2" />
        <path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />
      </>
    ),
  },
  {
    title: 'Task list',
    line: () => '- [ ] ',
    icon: markIcon(
      <>
        <rect x="3" y="5" width="6" height="6" rx="1" />
        <path d="m3 17 2 2 4-4" />
        <path d="M13 6h8" />
        <path d="M13 12h8" />
        <path d="M13 18h8" />
      </>
    ),
  },
  {
    title: 'Quote',
    line: () => '> ',
    icon: markIcon(
      <>
        <path d="M17 6H3" />
        <path d="M21 12H8" />
        <path d="M21 18H8" />
        <path d="M3 12v6" />
      </>
    ),
  },
  {
    title: 'Code',
    wrap: ['`', '`'],
    placeholder: 'code',
    icon: markIcon(
      <>
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </>
    ),
  },
  {
    title: 'Link',
    wrap: ['[', '](url)'],
    placeholder: 'link text',
    icon: markIcon(
      <>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </>
    ),
  },
  {
    title: 'Table',
    block: '| A | B |\n| --- | --- |\n|  |  |\n',
    icon: markIcon(
      <>
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="M3 9h18" />
        <path d="M3 15h18" />
        <path d="M12 3v18" />
      </>
    ),
  },
];

// Lattice points of the background dot grid around a world point (wx, wy),
// with a per-dot animation delay so the wave radiates from the center.
// Background dots sit at the center of each DOT_GRID tile: (n + 0.5) * DOT_GRID.
function waveDots(wx: number, wy: number) {
  const dots: { ox: number; oy: number; delay: number }[] = [];
  const radius = WAVE_RADIUS_CELLS * DOT_GRID;
  const ci = Math.round(wx / DOT_GRID - 0.5);
  const cj = Math.round(wy / DOT_GRID - 0.5);
  for (let i = ci - WAVE_RADIUS_CELLS; i <= ci + WAVE_RADIUS_CELLS; i++) {
    for (let j = cj - WAVE_RADIUS_CELLS; j <= cj + WAVE_RADIUS_CELLS; j++) {
      const px = (i + 0.5) * DOT_GRID;
      const py = (j + 0.5) * DOT_GRID;
      const d = Math.hypot(px - wx, py - wy);
      if (d > radius) continue;
      // Negative delay = start mid-cycle, so the wave is already running.
      const delay = ((d / WAVE_SPEED) % WAVE_PERIOD_S) - WAVE_PERIOD_S;
      dots.push({ ox: px - wx, oy: py - wy, delay });
    }
  }
  return dots;
}

type LibraryImage = { prompt: string; image_url: string };

// Rank a library prompt against the user's current query: whole-phrase
// containment scores highest, then per-token hits.
function scoreMatch(query: string, prompt: string): number {
  const p = prompt.toLowerCase();
  let score = 0;
  if (p.includes(query)) score += 100;
  for (const t of query.split(/\s+/).filter(Boolean)) {
    if (p.includes(t)) score += 10;
  }
  return score;
}

function generateCode(): string {
  let code = '';
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

// Screen coords (sx/sy) position the input popup; world coords (wx/wy) are
// where the generated element lands on the canvas.
type PromptBox = { sx: number; sy: number; wx: number; wy: number };
type LoadingSpot = { key: string; x: number; y: number }; // world coords

// Two paper themes: warm vanilla ivory, and its dark sepia counterpart.
// Stored in the snapshot's background_color column as 'light' | 'dark'.
type Theme = 'light' | 'dark';

function toTheme(value: string | null | undefined): Theme {
  return value === 'dark' ? 'dark' : 'light';
}

export default function Canvas() {
  // The working canvas lives ONLY in client state. Nothing is persisted until
  // the user clicks Save, which freezes the current state under a new code.
  const [elements, setElements] = useState<Record<string, CanvasElement>>({});
  const [theme, setTheme] = useState<Theme>('light');
  const [currentCode, setCurrentCode] = useState<string | null>(null); // code of the canvas on screen
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Hover is TRIGGERED only by the image body; once active, the whole
  // container (buttons included) sustains it. CSS :hover can't express
  // "trigger area ≠ sustain area", hence explicit pointer tracking.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // Papers whose content overflows one page (reported by PaperPages) — their
  // hover box grows to enclose the decoy sheet stacked behind them.
  const [multiPageIds, setMultiPageIds] = useState<Set<string>>(new Set());
  const reportMultiPage = useCallback((id: string, multi: boolean) => {
    setMultiPageIds((prev) => {
      if (prev.has(id) === multi) return prev;
      const next = new Set(prev);
      if (multi) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const [promptBox, setPromptBox] = useState<PromptBox | null>(null);
  const [promptText, setPromptText] = useState('');
  const [loadingSpots, setLoadingSpots] = useState<LoadingSpot[]>([]);
  const [library, setLibrary] = useState<LibraryImage[]>([]);
  // Results from /api/search (semantic); null = unavailable, use literal fallback.
  const [semanticMatches, setSemanticMatches] = useState<LibraryImage[] | null>(null);
  const [openCode, setOpenCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [shareMsg, setShareMsg] = useState<string | null>(null);

  // Generation semaphore: at most MAX_CONCURRENT_GENERATIONS requests in
  // flight; excess submissions queue up and start as slots free (FIFO).
  const activeGenerationsRef = useRef(0);
  const generationWaitersRef = useRef<(() => void)[]>([]);

  const acquireGenerationSlot = useCallback(async () => {
    if (activeGenerationsRef.current < MAX_CONCURRENT_GENERATIONS) {
      activeGenerationsRef.current++;
      return;
    }
    await new Promise<void>((resolve) => generationWaitersRef.current.push(resolve));
    activeGenerationsRef.current++;
  }, []);

  const releaseGenerationSlot = useCallback(() => {
    activeGenerationsRef.current--;
    generationWaitersRef.current.shift()?.();
  }, []);
  const [apiConfig, setApiConfig] = useState<ApiConfig | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showMenu, setShowMenu] = useState(false);

  // Paper elements: size picker menu, custom-size inputs, markdown editor.
  const [showPaperMenu, setShowPaperMenu] = useState(false);
  const [customW, setCustomW] = useState('210');
  const [customH, setCustomH] = useState('297');
  const [editingPaperId, setEditingPaperId] = useState<string | null>(null);
  const [editorDraft, setEditorDraft] = useState('');
  // In-app save/discard dialog shown when closing the editor with changes.
  const [confirmClose, setConfirmClose] = useState(false);
  // Paper-size picker opened from the hamburger menu (renders as a submenu
  // beside the panel) rather than from the toolbar button.
  const [paperSubmenu, setPaperSubmenu] = useState(false);
  // Small-screen "Open canvas" dialog (the code input lives in the menu then).
  const [showOpenDialog, setShowOpenDialog] = useState(false);
  const [draft, setDraft] = useState<ApiConfig>({
    provider: 'gemini',
    apiKey: '',
    model: PRESETS.gemini.defaultModel,
    baseUrl: '',
    format: 'gemini',
  });

  const inputRef = useRef<HTMLInputElement>(null);
  const promptBoxRef = useRef<HTMLDivElement>(null);
  const dirtyRef = useRef(false);
  // A blank canvas has nothing worth a "discard changes?" warning.
  const elementCountRef = useRef(0);
  // Guards against the browser quirk where a drag (e.g. selecting text in an
  // input) that ends outside the element fires a click on the common ancestor.
  const overlayDownRef = useRef(false);
  const canvasDownRef = useRef(false);

  // ---------- view transform (zoom around a screen point) ----------

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const canvasRef = useRef<HTMLDivElement>(null);

  const zoomAt = useCallback((cx: number, cy: number, nextZoom: number) => {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
    const prev = zoomRef.current;
    if (z === prev) return;
    // Keep the world point under (cx, cy) fixed on screen.
    const p = panRef.current;
    const next = { x: cx - ((cx - p.x) * z) / prev, y: cy - ((cy - p.y) * z) / prev };
    zoomRef.current = z;
    panRef.current = next;
    setZoom(z);
    setPan(next);
  }, []);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    // React's onWheel is passive; we need preventDefault to stop page zoom.
    const onWheel = (e: WheelEvent) => {
      // Over UI panels (prompt box / library grid, toolbar, settings), let the
      // wheel scroll them natively instead of zooming the canvas.
      if (
        e.target instanceof Element &&
        e.target.closest('.prompt-box, .toolbar, .settings-modal, .editor-overlay')
      ) {
        return;
      }
      e.preventDefault();
      // Horizontal scrolling (trackpad swipe or shift+wheel, which browsers
      // report as deltaX) pans the canvas sideways — handy on small screens.
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const z = zoomRef.current;
        // Clamp so the visible world stays within ±PAN_LIMIT of the origin.
        const minX = window.innerWidth - PAN_LIMIT * z;
        const maxX = PAN_LIMIT * z;
        const x = Math.min(maxX, Math.max(minX, panRef.current.x - e.deltaX));
        const next = { x, y: panRef.current.y };
        panRef.current = next;
        setPan(next);
        return;
      }
      // Proportional to scroll amount → smooth on trackpads, gentle on wheels.
      const factor = Math.exp(-e.deltaY * ZOOM_SENSITIVITY);
      zoomAt(e.clientX, e.clientY, zoomRef.current * factor);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setDirty(true);
  }, []);

  // ---------- undo / redo ----------

  // Whole-`elements` snapshots. One is pushed right BEFORE each discrete
  // mutation (add, delete, duplicate, content edit, drag/resize — the latter
  // once per gesture, on the first movement), so undo rewinds whole gestures,
  // never individual pointermove ticks. Theme/pan/zoom are not part of it.
  const UNDO_LIMIT = 100;
  const pastRef = useRef<Record<string, CanvasElement>[]>([]);
  const futureRef = useRef<Record<string, CanvasElement>[]>([]);
  // Bumped on every history change purely to refresh the buttons' disabled state.
  const [, setHistoryVersion] = useState(0);
  const elementsRef = useRef(elements);
  useEffect(() => {
    elementsRef.current = elements;
  }, [elements]);

  const pushHistory = useCallback((snapshot?: Record<string, CanvasElement>) => {
    pastRef.current.push(snapshot ?? elementsRef.current);
    if (pastRef.current.length > UNDO_LIMIT) pastRef.current.shift();
    futureRef.current = []; // a new action invalidates the redo branch
    setHistoryVersion((v) => v + 1);
  }, []);

  const undo = useCallback(() => {
    const prev = pastRef.current.pop();
    if (!prev) return;
    futureRef.current.push(elementsRef.current);
    setElements(prev);
    markDirty();
    setHistoryVersion((v) => v + 1);
  }, [markDirty]);

  const redo = useCallback(() => {
    const next = futureRef.current.pop();
    if (!next) return;
    pastRef.current.push(elementsRef.current);
    setElements(next);
    markDirty();
    setHistoryVersion((v) => v + 1);
  }, [markDirty]);

  // ---------- snapshot loading (no page reloads) ----------

  const applySnapshot = useCallback((snapshot: SavedCanvas) => {
    setCurrentCode(snapshot.code);
    setOpenCode(''); // the code input stays a blank input, not a code display
    setCodeError(null);
    setTheme(toTheme(snapshot.background_color));
    setElements(Object.fromEntries((snapshot.elements ?? []).map((e) => [e.id, e])));
    // A different canvas starts a fresh undo history.
    pastRef.current = [];
    futureRef.current = [];
    setHistoryVersion((v) => v + 1);
    dirtyRef.current = false;
    setDirty(false);
    const url = new URL(window.location.href);
    url.searchParams.set('c', snapshot.code);
    window.history.replaceState(null, '', url.toString());
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('c')?.toUpperCase().trim();
    if (!code) return; // blank new canvas

    (async () => {
      const { data } = await supabase
        .from('canvases')
        .select('*')
        .eq('code', code)
        .maybeSingle();

      if (!data) {
        setCodeError(`Canvas "${code}" not found — starting blank.`);
        window.history.replaceState(null, '', window.location.pathname);
        return;
      }
      applySnapshot(data as SavedCanvas);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- warn before losing unsaved work ----------

  useEffect(() => {
    elementCountRef.current = Object.keys(elements).length;
  }, [elements]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current && elementCountRef.current > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  useEffect(() => {
    if (promptBox) inputRef.current?.focus();
  }, [promptBox]);

  const loadLibrary = useCallback(() => {
    supabase
      .from('images')
      .select('prompt,image_url')
      .order('created_at', { ascending: false })
      // The grid shows at most LIBRARY_MAX images, so that's all we fetch —
      // note the prompt filtering/search then only ranks within this pool.
      .limit(LIBRARY_MAX)
      .then(({ data }) => setLibrary((data as LibraryImage[]) ?? []));
  }, []);

  // Load the sticker library at page load (so the first prompt box opens
  // already full-sized, instead of growing when the data arrives)…
  useEffect(() => {
    loadLibrary();
  }, [loadLibrary]);

  // …and refresh it each time the prompt box opens, to pick up new images.
  useEffect(() => {
    if (promptBox) loadLibrary();
  }, [promptBox, loadLibrary]);

  // Semantic search, debounced. On failure (no server key, quota, etc.) the
  // state stays null and the literal fallback below takes over.
  useEffect(() => {
    if (!promptBox) return;
    const q = promptText.trim();
    setSemanticMatches(null);
    if (!q) return;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q }),
        });
        if (!res.ok) return;
        const { results } = await res.json();
        if (Array.isArray(results)) setSemanticMatches(results);
      } catch {
        /* keep literal fallback */
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [promptText, promptBox]);

  // Literal search runs SERVER-side (Postgres ILIKE via Supabase): the whole
  // phrase and each token get their own query, and only the merged candidate
  // set (≤ LIBRARY_MAX rows per pattern — more than the grid can show anyway)
  // comes back for scoreMatch to rank. Nothing
  // big is ever downloaded, and typing stays cheap locally. Until results
  // arrive, the small preloaded pool fills in.
  const [literalMatches, setLiteralMatches] = useState<LibraryImage[] | null>(null);
  useEffect(() => {
    const q = promptText.toLowerCase().trim();
    setLiteralMatches(null);
    if (!promptBox || !q) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const pats = Array.from(new Set([q, ...q.split(/\s+/).filter(Boolean)])).slice(0, 4);
      const results = await Promise.all(
        pats.map((pat) =>
          supabase
            .from('images')
            .select('prompt,image_url')
            .ilike('prompt', `%${pat.replace(/[%_]/g, '\\$&')}%`)
            .order('created_at', { ascending: false })
            .limit(LIBRARY_MAX)
            .then(({ data }) => (data as LibraryImage[]) ?? [])
        )
      );
      if (cancelled) return;
      const seen = new Set<string>();
      const merged: LibraryImage[] = [];
      for (const r of results.flat()) {
        if (!seen.has(r.image_url)) {
          seen.add(r.image_url);
          merged.push(r);
        }
      }
      setLiteralMatches(merged);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [promptBox, promptText]);

  // Stickers shown under the input: recent-first when empty; literal matches
  // appear instantly, and semantic results (arriving later) only ADD to the
  // list — never remove or reorder what's already visible, so nothing flashes.
  const libraryMatches = useMemo(() => {
    const q = promptText.toLowerCase().trim();
    // Empty query browses the recent pool; a query ranks the server-fetched
    // candidates (falling back to the recent pool until they arrive).
    const pool = q && literalMatches ? literalMatches : library;
    const scored = pool.map((img, i) => ({
      img,
      score: q ? scoreMatch(q, img.prompt) : 0,
      i,
    }));
    const literal = (q ? scored.filter((s) => s.score > 0) : scored)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((s) => s.img);

    if (q && semanticMatches) {
      const seen = new Set(literal.map((img) => img.image_url));
      const extra = semanticMatches.filter((m) => !seen.has(m.image_url));
      return [...literal, ...extra].slice(0, LIBRARY_MAX);
    }
    return literal.slice(0, LIBRARY_MAX);
  }, [library, literalMatches, promptText, semanticMatches]);

  // Position the popup ONCE when it opens: a corner sits exactly at the click
  // point (top-left by default, flipping per axis near the viewport's
  // right/bottom edge), measured from the real rendered size and applied
  // before paint. Later height changes (library grid loading/filtering) keep
  // the top edge fixed and only grow/shrink downward — no vertical jumping —
  // EXCEPT when growth would push the box past the bottom edge (the library
  // arrives async on a fresh page, so the very first open near the bottom
  // used to overflow the viewport): then it's pulled up just enough to fit.
  useLayoutEffect(() => {
    const el = promptBoxRef.current;
    if (!promptBox || !el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const left =
      promptBox.sx + w > window.innerWidth ? Math.max(8, promptBox.sx - w) : promptBox.sx;
    const top =
      promptBox.sy + h > window.innerHeight ? Math.max(8, promptBox.sy - h) : promptBox.sy;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [promptBox]);

  useEffect(() => {
    const cfg = loadApiConfig();
    if (cfg) {
      setApiConfig(cfg);
      setDraft(cfg);
    }
  }, []);

  const selectDraftProvider = useCallback((provider: ApiProvider) => {
    setDraft((prev) => ({
      ...prev,
      provider,
      // Each provider gets its own default; custom starts empty on purpose.
      model: PRESETS[provider].defaultModel,
      format: PRESETS[provider].format,
    }));
  }, []);

  const saveSettings = useCallback(() => {
    saveApiConfig(draft);
    setApiConfig(draft);
    setShowSettings(false);
  }, [draft]);

  // ---------- place an image element (from generation or the library) ----------

  const placeImage = useCallback(
    async (imageUrl: string, prompt: string, x: number, y: number) => {
      // Size the element to the image's real aspect ratio so the box hugs
      // the sticker (resize keeps this ratio locked).
      const natural = await new Promise<{ w: number; h: number }>((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
        img.onerror = () => resolve({ w: 1, h: 1 });
        img.src = imageUrl;
      });
      const width = DEFAULT_SIZE;
      const height = (DEFAULT_SIZE * natural.h) / natural.w;

      // Center the element on the click point (the wave's origin).
      const el: CanvasElement = {
        id: newId(),
        image_url: imageUrl,
        prompt,
        x: x - width / 2,
        y: y - height / 2,
        width,
        height,
      };
      pushHistory();
      setElements((prev) => ({ ...prev, [el.id]: el }));
      markDirty();
    },
    [markDirty, pushHistory]
  );

  // The library grid re-rendered on EVERY pan/zoom state update (it lives in
  // this component), which made panning stutter once two dozen images were on
  // screen. Memoizing the subtree lets React skip it unless the matches
  // themselves change; lazy loading/decoding keeps image work off the tap.
  const libraryGrid = useMemo(
    () =>
      libraryMatches.length > 0 && (
        <div className="library-grid">
          {libraryMatches.map((m) => (
            <img
              key={m.image_url}
              src={m.image_url}
              alt={m.prompt}
              title={m.prompt}
              loading="lazy"
              decoding="async"
              draggable={false}
              onClick={() => useLibraryImageRef.current(m)}
            />
          ))}
        </div>
      ),
    [libraryMatches]
  );

  // Element action buttons act on pointerup for touch: mobile browsers'
  // synthesized click after a tap proved unreliable here (leaving "dead"
  // delete taps), so touch acts immediately and the trailing click — when it
  // does arrive — is swallowed by the timestamp guard.
  const touchTapRef = useRef(0);
  const press = useCallback((fn: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onPointerUp: (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      e.stopPropagation();
      touchTapRef.current = Date.now();
      // Deferred past the gesture: unmounting DOM in the middle of an active
      // touch is what makes iOS strand the element's composited layers
      // (outline/action bar kept rendering with the element long gone).
      setTimeout(fn, 0);
    },
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      if (Date.now() - touchTapRef.current < 500) return; // handled on touch
      touchTapRef.current = Date.now(); // mouse actions stamp the guard too
      fn();
    },
  }), []);

  const useLibraryImage = useCallback(
    (img: LibraryImage) => {
      if (!promptBox) return;
      const { wx, wy } = promptBox;
      setPromptBox(null);
      setPromptText('');
      void placeImage(img.image_url, img.prompt, wx, wy);
    },
    [promptBox, placeImage]
  );
  const useLibraryImageRef = useRef(useLibraryImage);
  useEffect(() => {
    useLibraryImageRef.current = useLibraryImage;
  }, [useLibraryImage]);

  // ---------- generate ----------

  const submitPrompt = useCallback(async () => {
    if (!promptBox || !promptText.trim()) return;
    const { wx: x, wy: y } = promptBox;
    const prompt = promptText.trim();
    const key = `${Date.now()}-${Math.random()}`;

    // Generation is strictly BYOK — without a stored key the request can
    // only 401. Go straight to the settings dialog, with NO loading ripple.
    if (!apiConfig?.apiKey?.trim()) {
      setPromptBox(null);
      setPromptText('');
      setShowSettings(true);
      alert('No API key configured. Open API settings and add your key.');
      return;
    }

    setPromptBox(null);
    setPromptText('');
    setLoadingSpots((prev) => [...prev, { key, x, y }]);

    try {
      // Queue if too many generations are already running.
      await acquireGenerationSlot();
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, ...(apiConfig ?? {}) }),
      });
      if (res.status === 401) {
        // Kill the ripple right away — the rest of the handler shouldn't
        // keep it on screen for a request that never had a valid key.
        setLoadingSpots((prev) => prev.filter((s) => s.key !== key));
        setShowSettings(true);
        throw new Error('No API key configured');
      }
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: `API ${res.status}` }));
        throw new Error(error || `API ${res.status}`);
      }
      const { imageUrl } = await res.json();
      await placeImage(imageUrl, prompt, x, y);
    } catch (err) {
      console.error('Generation failed:', err);
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'No API key configured') {
        // Already opened settings above; just tell the user why.
        alert('No API key configured. Open API settings and add your key.');
      } else {
        // Any other failure (network, provider, upload) is NOT a
        // missing-key problem — show the real error, don't blame the key.
        alert(msg || 'Image generation failed. Please try again.');
      }
    } finally {
      releaseGenerationSlot();
      setLoadingSpots((prev) => prev.filter((s) => s.key !== key));
    }
  }, [promptBox, promptText, apiConfig, placeImage, acquireGenerationSlot, releaseGenerationSlot]);

  // ---------- element interactions (all local) ----------

  // Element interactions stop propagation, so the canvas click handler never
  // sees them — close the prompt box explicitly.
  const closePromptBox = useCallback(() => {
    setPromptBox(null);
    setPromptText('');
  }, []);

  // ANY button click anywhere (toolbar, element actions, menus…) dismisses
  // the prompt box — not just the menu/paper buttons. Capture phase, because
  // many buttons stop propagation; buttons inside the prompt box itself are
  // exempt (they operate it).
  useEffect(() => {
    const onAnyClick = (e: MouseEvent) => {
      const t = e.target as Element | null;
      const btn = t?.closest('button');
      if (btn && !btn.closest('.prompt-box')) closePromptBox();
    };
    document.addEventListener('click', onAnyClick, true);
    return () => document.removeEventListener('click', onAnyClick, true);
  }, [closePromptBox]);


  const startDrag = useCallback(
    (e: React.PointerEvent, el: CanvasElement) => {
      e.preventDefault();
      e.stopPropagation();
      // Touch replaces hover with taps: an explicit finger-down on the
      // element is the ONLY thing that opens its action bar.
      if (e.pointerType === 'touch') setHoveredId(el.id);
      closePromptBox();
      const startX = e.clientX;
      const startY = e.clientY;
      const origX = el.x;
      const origY = el.y;
      // Undo snapshot, pushed once on the first actual movement (a plain
      // click must not pollute the history).
      const before = elementsRef.current;
      let moved = false;

      const onMove = (ev: PointerEvent) => {
        if (!moved) {
          moved = true;
          pushHistory(before);
        }
        const z = zoomRef.current; // pointer deltas are screen px → world px
        setElements((prev) => ({
          ...prev,
          [el.id]: {
            ...prev[el.id],
            x: origX + (ev.clientX - startX) / z,
            y: origY + (ev.clientY - startY) / z,
          },
        }));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        markDirty();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [markDirty, closePromptBox, pushHistory]
  );

  const startResize = useCallback(
    (e: React.PointerEvent, el: CanvasElement) => {
      e.preventDefault();
      e.stopPropagation();
      closePromptBox();
      const startX = e.clientX;
      const startY = e.clientY;
      const origW = el.width;
      const origH = el.height;

      const ratio = origW / origH;
      // Undo snapshot, pushed once on the first actual movement.
      const before = elementsRef.current;
      let moved = false;
      const onMove = (ev: PointerEvent) => {
        if (!moved) {
          moved = true;
          pushHistory(before);
        }
        const z = zoomRef.current;
        const dx = (ev.clientX - startX) / z;
        const dy = (ev.clientY - startY) / z;
        // Aspect ratio is locked; the axis dragged further drives the size.
        let width =
          Math.abs(dx) >= Math.abs(dy) * ratio ? origW + dx : (origH + dy) * ratio;
        width = Math.max(24, width);
        setElements((prev) => ({
          ...prev,
          [el.id]: { ...prev[el.id], width, height: width / ratio },
        }));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        markDirty();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [markDirty, closePromptBox, pushHistory]
  );

  const deleteElement = useCallback(
    (id: string) => {
      closePromptBox();
      setHoveredId((cur) => (cur === id ? null : cur));
      pushHistory();
      setElements((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      markDirty();
      // Belt and braces for touch: whichever synthesized event some engine
      // still sneaks past the pointer-type/timestamp guards, wipe any hover
      // it managed to set once the post-tap event storm has settled.
      setTimeout(() => setHoveredId(null), 250);
      // iOS compositor nudge: state provably updates (n drops, hover clears)
      // yet the deleted element's outline/action-bar LAYERS can stay on
      // screen. Toggling a transform on the root forces the layer tree to
      // rebuild, sweeping any stranded layers away.
      requestAnimationFrame(() => {
        const c = canvasRef.current;
        if (!c) return;
        c.style.transform = 'translateZ(0)';
        requestAnimationFrame(() => {
          c.style.transform = '';
        });
      });
    },
    [markDirty, closePromptBox, pushHistory]
  );

  const duplicateElement = useCallback(
    (el: CanvasElement) => {
      closePromptBox();
      const copy: CanvasElement = { ...el, id: newId(), x: el.x + 16, y: el.y + 16 };
      pushHistory();
      setElements((prev) => ({ ...prev, [copy.id]: copy }));
      markDirty();
    },
    [markDirty, closePromptBox, pushHistory]
  );

  // Download an object's image. Fetch → blob keeps the browser from just
  // navigating to the (cross-origin) URL; falls back to opening it.
  const downloadImage = useCallback(async (el: ImageElement) => {
    try {
      const res = await fetch(el.image_url);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      a.download = `${(el.prompt || 'image').slice(0, 40)}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      window.open(el.image_url, '_blank');
    }
  }, []);

  // Download a paper's markdown source, named after its first heading.
  const downloadMarkdown = useCallback((el: PaperElement) => {
    const blob = new Blob([el.content || ''], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const m = (el.content || '').match(/^#{1,6}\s+(.+)$/m);
    a.download = `${(m ? m[1].trim() : 'paper').slice(0, 40)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  // ---------- paper elements ----------

  const addPaper = useCallback(
    (sizeId: string, wMM: number, hMM: number) => {
      if (!(wMM > 0) || !(hMM > 0)) return;
      const width = wMM * PX_PER_MM;
      const height = hMM * PX_PER_MM;
      // Centered in the current viewport, in world coordinates.
      const cx = (window.innerWidth / 2 - panRef.current.x) / zoomRef.current;
      const cy = (window.innerHeight / 2 - panRef.current.y) / zoomRef.current;
      const el: PaperElement = {
        id: newId(),
        kind: 'paper',
        sizeId,
        wMM,
        hMM,
        content: '',
        x: cx - width / 2,
        y: cy - height / 2,
        width,
        height,
      };
      pushHistory();
      setElements((prev) => ({ ...prev, [el.id]: el }));
      markDirty();
      setShowPaperMenu(false);
      setShowMenu(false); // submenu flow: adding also dismisses the menu
    },
    [markDirty, pushHistory]
  );

  const openPaperEditor = useCallback(
    (el: PaperElement) => {
      closePromptBox();
      setEditorDraft(el.content);
      setEditingPaperId(el.id);
    },
    [closePromptBox]
  );

  // Close the editor; with unsaved changes, raise the in-app save/discard
  // dialog (styled like the rest of the canvas) instead of closing outright.
  const closePaperEditor = useCallback(() => {
    if (editingPaperId) {
      const el = elementsRef.current[editingPaperId];
      if (el && isPaper(el) && editorDraft !== el.content) {
        setConfirmClose(true);
        return;
      }
    }
    setEditingPaperId(null);
  }, [editingPaperId, editorDraft]);

  const savePaperEditor = useCallback(() => {
    if (!editingPaperId) return;
    pushHistory();
    setElements((prev) => {
      const el = prev[editingPaperId];
      if (!el || !isPaper(el)) return prev;
      return { ...prev, [editingPaperId]: { ...el, content: editorDraft } };
    });
    markDirty();
    setEditingPaperId(null);
  }, [editingPaperId, editorDraft, markDirty, pushHistory]);


  // ---------- markdown editor helpers ----------

  const editorInputRef = useRef<HTMLTextAreaElement>(null);

  // Apply a mark at the textarea's selection, then restore focus/selection
  // once the controlled value has round-tripped through state.
  const applyMark = useCallback((mark: EditorMark) => {
    const ta = editorInputRef.current;
    if (!ta) return;
    const v = ta.value;
    const a = ta.selectionStart;
    const b = ta.selectionEnd;
    let next: string;
    let selA: number;
    let selB: number;
    if (mark.wrap) {
      const [pre, suf] = mark.wrap;
      const sel = v.slice(a, b) || mark.placeholder || 'text';
      next = v.slice(0, a) + pre + sel + suf + v.slice(b);
      selA = a + pre.length;
      selB = selA + sel.length;
    } else if (mark.line) {
      // Expand the selection to whole lines and prefix each one.
      const start = v.lastIndexOf('\n', a - 1) + 1;
      const endIdx = v.indexOf('\n', b);
      const end = endIdx === -1 ? v.length : endIdx;
      const prefixed = v
        .slice(start, end)
        .split('\n')
        .map((l, i) => mark.line!(i) + l)
        .join('\n');
      next = v.slice(0, start) + prefixed + v.slice(end);
      selA = start;
      selB = start + prefixed.length;
    } else {
      const block = mark.block ?? '';
      const nl = a > 0 && v[a - 1] !== '\n' ? '\n' : '';
      next = v.slice(0, a) + nl + block + v.slice(b);
      selA = selB = a + nl.length + block.length;
    }
    setEditorDraft(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(selA, selB);
    });
  }, []);

  // Preview zoom: fit the page's design width to the preview pane. CSS `zoom`
  // (not transform) so the pane's scroll geometry follows the scaled size.
  const previewPaneRef = useRef<HTMLDivElement>(null);
  const [previewZoom, setPreviewZoom] = useState(1);
  useLayoutEffect(() => {
    if (!editingPaperId) return;
    const pane = previewPaneRef.current;
    const paper = elementsRef.current[editingPaperId];
    if (!pane || !paper || !isPaper(paper)) return;
    const designW = paper.wMM * PX_PER_MM;
    const update = () => {
      const w = pane.clientWidth; // the pane has no padding: pages fill it
      if (w > 0) setPreviewZoom(w / designW);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(pane);
    return () => ro.disconnect();
  }, [editingPaperId]);

  // Print a paper natively: the markdown is real, reflowing HTML text (never a
  // raster image) and the margin lives on @page, so the browser flows the text
  // across as many physical pages as needed — breaking only between lines (a
  // line is never cut in half) — and the print dialog's Margins control can
  // override the default (10% of the paper's short side). Font metrics mirror the canvas (design px ÷
  // PX_PER_MM → mm). Stickers are overlaid by their offset from the paper's
  // top-left corner inside a layer clipped to the first physical page (exact
  // spot shifts if the dialog margin is changed).
  const printPaper = useCallback(
    (paper: PaperElement) => {
      const designW = paper.wMM * PX_PER_MM;
      const scale = paper.width / designW; // world px per design px
      const marginMM = pageMarginMM(paper.wMM, paper.hMM);
      const padPx = pagePad(paper.wMM, paper.hMM); // margin in design px
      // Design px → physical mm (the on-canvas unit is PX_PER_MM px per mm).
      const u = (px: number) => `${px / PX_PER_MM}mm`;
      const html = renderMarkdown(paper.content);

      // Each sticker is cropped INDIVIDUALLY to the printable window: from the
      // page's left/top edge (ink in those margins prints fine) to just shy of
      // the content box's right/bottom edge — any box past the right edge makes
      // the print engine shrink-to-fit the whole page, and past the bottom it
      // spawns an extra page. Cropping per sticker (rather than one page-sized
      // clip layer) means an empty page contains NO boxes near the page
      // boundary at all.
      const contentW = paper.wMM * PX_PER_MM - padPx * 2;
      const contentH = paper.hMM * PX_PER_MM - padPx * 2 - 0.4; // 0.2mm inside the boundary
      const stickers = Object.values(elements)
        .filter((e): e is ImageElement => !isPaper(e))
        .filter(
          (e) =>
            e.x < paper.x + paper.width &&
            e.x + e.width > paper.x &&
            e.y < paper.y + paper.height &&
            e.y + e.height > paper.y
        )
        .map((e) => {
          // Sticker rect in design px, relative to the .doc origin (the
          // page's text-content box, inside the margin).
          const l = (e.x - paper.x) / scale - padPx;
          const t = (e.y - paper.y) / scale - padPx;
          const w = e.width / scale;
          const h = e.height / scale;
          const cl = Math.max(l, -padPx);
          const ct = Math.max(t, -padPx);
          const cr = Math.min(l + w, contentW);
          const cb = Math.min(t + h, contentH);
          if (cr <= cl || cb <= ct) return '';
          return `<span class="sticker-crop" style="left:${u(cl)};top:${u(ct)};width:${u(cr - cl)};height:${u(cb - ct)};"><img class="sticker" src="${e.image_url}" style="left:${u(l - cl)};top:${u(t - ct)};width:${u(w)};height:${u(h)};" /></span>`;
        })
        .join('');

      const doc = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>Vanilla Canvas</title>
<style>
  /* Margin on @page → the browser flows the text across pages and the print
     dialog's Margins control can override this default (10% of the short
     side). */
  @page { size: ${paper.wMM}mm ${paper.hMM}mm; margin: ${marginMM}mm; }
  html, body { margin: 0; padding: 0; }
  /* flow-root: without it the first heading's top margin collapses THROUGH
     .doc in some engines (moving .doc — and every sticker anchored to it —
     down by that margin) but not in others, which is exactly the kind of
     Chrome-vs-Safari sticker offset we saw. A BFC pins .doc's top to the
     page content origin in every engine, and matches the canvas (where the
     padding boundary already prevents the collapse). */
  .doc { position: relative; display: flow-root; }
  /* One fixed default body size (em-relative headings/spacing, mirroring
     globals.css .md-body) — independent of the paper size, so print is always a
     normal reading size. orphans/widows: 1 and no break rules let the browser
     break at any line boundary. Explicit CJK fonts: unlike the screen, the
     print pipeline does NOT apply the OS's CJK fallback for generic families,
     so non-Latin text would otherwise print blank. */
  .md-body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Noto Sans SC', sans-serif; font-size: ${PRINT_FONT_MM}mm; line-height: 1.6; color: #222; word-wrap: break-word; orphans: 1; widows: 1; }
  .md-body h1 { font-size: 1.9em; margin: 0 0 0.5em; }
  .md-body h2 { font-size: 1.5em; margin: 0.8em 0 0.4em; }
  .md-body h3 { font-size: 1.2em; margin: 0.8em 0 0.4em; }
  .md-body p { margin: 0 0 0.6em; }
  .md-body ul, .md-body ol { margin: 0 0 0.6em; padding-left: 2em; } /* 2em: room for outside markers ("10.") — narrower and print clips them at the margin */
  .md-body li:has(> input[type='checkbox']) { list-style: none; margin-left: -1.5em; }
  .md-body input[type='checkbox'] { width: 0.9em; height: 0.9em; margin: 0 0.35em 0 0; vertical-align: middle; }
  .md-body code { background: #f2f2f2; padding: 0.1em 0.3em; border-radius: 0.25em; font-size: 0.9em; }
  .md-body pre { background: #f2f2f2; padding: 0.6em; border-radius: 0.4em; overflow: hidden; margin: 0 0 0.6em; }
  .md-body blockquote { margin: 0 0 0.6em; padding-left: 0.7em; border-left: 0.2em solid #ccc; color: #555; }
  .md-body table { border-collapse: collapse; margin: 0 0 0.6em; max-width: 100%; }
  .md-body th, .md-body td { border: 0.07em solid #999; padding: 0.25em 0.6em; }
  .md-body img { max-width: 100%; }
  .md-body hr { border: none; border-top: 0.07em solid #ccc; margin: 0.8em 0; }
  .sticker-crop { position: absolute; overflow: hidden; z-index: 1; }
  .sticker { position: absolute; object-fit: contain; }
</style></head>
<body><div class="doc"><div class="md-body">${html}</div>${stickers}</div></body></html>`;

      // Print via a hidden iframe so we stay on the canvas page — no new tab
      // or pop-up window. The iframe's own @page rules drive the paper size.
      const iframe = document.createElement('iframe');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
      document.body.appendChild(iframe);
      const cw = iframe.contentWindow;
      if (!cw) {
        iframe.remove();
        return;
      }
      const cleanup = () => iframe.remove();
      cw.addEventListener('afterprint', cleanup);

      cw.document.open();
      cw.document.write(doc);
      cw.document.close();

      // Wait for the (remote) sticker images to load before printing, capped
      // so a slow/broken image can't hang the dialog forever.
      const imgs = Array.from(cw.document.images);
      const ready = Promise.race([
        Promise.all(
          imgs.map((img) =>
            img.complete
              ? null
              : new Promise((res) => {
                  img.addEventListener('load', res);
                  img.addEventListener('error', res);
                })
          )
        ),
        new Promise((res) => setTimeout(res, 3000)),
      ]);
      ready.then(() => {
        cw.focus();
        cw.print();
      });
      // Fallback removal in case afterprint never fires (e.g. print cancelled).
      setTimeout(cleanup, 60000);
    },
    [elements]
  );

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
    markDirty();
  }, [markDirty]);

  // ---------- save (freeze current state under a NEW code) ----------

  const saveCanvas = useCallback(async () => {
    if (saving || Object.keys(elements).length === 0) return;
    setSaving(true);
    try {
      let code = '';
      for (let attempt = 0; attempt < 5; attempt++) {
        code = generateCode();
        const { error } = await supabase.from('canvases').insert({
          code,
          background_color: theme,
          elements: Object.values(elements),
        });
        if (!error) break;
        if (error.code !== '23505') throw error; // 23505 = code collision, retry
        code = '';
      }
      if (!code) throw new Error('Could not allocate a canvas code');

      dirtyRef.current = false;
      setDirty(false);
      setCurrentCode(code);
      const url = new URL(window.location.href);
      url.searchParams.set('c', code);
      window.history.replaceState(null, '', url.toString());

      const link = `${window.location.origin}${window.location.pathname}?c=${code}`;
      try {
        await navigator.clipboard.writeText(link);
        setShareMsg(`Saved as ${code} — link copied!`);
      } catch {
        setShareMsg(`Saved as ${code}`);
      }
      setTimeout(() => setShareMsg(null), 5000);
    } catch (err) {
      console.error('Save failed:', err);
      const detail =
        err && typeof err === 'object' && 'message' in err ? ` (${(err as Error).message})` : '';
      alert(`Could not save the canvas${detail}. If this mentions a missing table or column, re-run supabase/schema.sql.`);
    } finally {
      setSaving(false);
    }
  }, [saving, theme, elements]);

  // ---------- open / new ----------

  const confirmDiscard = useCallback(() => {
    if (elementCountRef.current === 0) return true; // blank canvas: nothing to lose
    return !dirtyRef.current || confirm('You have unsaved changes that will be lost. Continue?');
  }, []);

  const openCanvas = useCallback(async () => {
    const code = openCode.toUpperCase().trim();
    if (code.length !== CODE_LENGTH) return false;
    // Fetch first: if the code doesn't exist, the current canvas is untouched.
    const { data } = await supabase.from('canvases').select('*').eq('code', code).maybeSingle();
    if (!data) {
      setCodeError(`Canvas "${code}" not found.`);
      return false;
    }
    if (!confirmDiscard()) return false;
    applySnapshot(data as SavedCanvas);
    return true;
  }, [openCode, confirmDiscard, applySnapshot]);

  const newCanvas = useCallback(() => {
    if (!confirmDiscard()) return;
    setElements({});
    pastRef.current = [];
    futureRef.current = [];
    setHistoryVersion((v) => v + 1);
    setCurrentCode(null);
    setOpenCode('');
    setCodeError(null);
    dirtyRef.current = false;
    setDirty(false);
    window.history.replaceState(null, '', window.location.pathname);
  }, [confirmDiscard]);

  // ---------- canvas click ----------

  // ---------- touch panning / pinch zoom ----------
  // Mouse users pan with the wheel; on touch there IS no wheel, so one finger
  // dragging empty canvas pans and two fingers pinch-zoom. Element drags stop
  // propagation at pointerdown, so only background touches register here.
  const touchesRef = useRef(new Map<number, { x: number; y: number }>());
  const touchMovedRef = useRef(false);
  // A background tap that dismissed an element's action bar must not ALSO
  // open the prompt box — that takes a second tap.
  const dismissedBarRef = useRef(false);

  const onCanvasPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    // Tapping empty canvas dismisses any tap-opened action bar (element taps
    // stop propagation, so reaching here means background).
    setHoveredId((cur) => {
      if (cur !== null) dismissedBarRef.current = true;
      return null;
    });
    if (touchesRef.current.size === 0) touchMovedRef.current = false;
    touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onCanvasPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const t = touchesRef.current;
      const prev = t.get(e.pointerId);
      if (e.pointerType !== 'touch' || !prev) return;
      if (t.size === 1) {
        const dx = e.clientX - prev.x;
        const dy = e.clientY - prev.y;
        // A little slack so a tap isn't mistaken for a pan.
        if (!touchMovedRef.current && Math.hypot(dx, dy) < 4) return;
        touchMovedRef.current = true;
        t.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const z = zoomRef.current;
        const next = {
          // Finite in both axes, same bounds as wheel-scrolling.
          x: Math.min(PAN_LIMIT * z, Math.max(window.innerWidth - PAN_LIMIT * z, panRef.current.x + dx)),
          y: Math.min(PAN_LIMIT * z, Math.max(window.innerHeight - PAN_LIMIT * z, panRef.current.y + dy)),
        };
        panRef.current = next;
        setPan(next);
      } else if (t.size === 2) {
        touchMovedRef.current = true;
        const [a, b] = Array.from(t.entries());
        const other = a[0] === e.pointerId ? b[1] : a[1];
        const oldDist = Math.hypot(prev.x - other.x, prev.y - other.y);
        t.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const newDist = Math.hypot(e.clientX - other.x, e.clientY - other.y);
        if (oldDist > 0 && newDist > 0) {
          const mx = (e.clientX + other.x) / 2;
          const my = (e.clientY + other.y) / 2;
          zoomAt(mx, my, zoomRef.current * (newDist / oldDist));
        }
      }
    },
    [zoomAt]
  );

  const onCanvasPointerUp = useCallback((e: React.PointerEvent) => {
    touchesRef.current.delete(e.pointerId);
  }, []);

  // "Canvas XXX not found" fades away on its own after 5 seconds.
  useEffect(() => {
    if (!codeError) return;
    const t = setTimeout(() => setCodeError(null), 5000);
    return () => clearTimeout(t);
  }, [codeError]);

  // Never let the hover/tap outline reference an element that's gone
  // (deleted, undone, replaced by opening another canvas…).
  useEffect(() => {
    if (hoveredId && !elements[hoveredId]) setHoveredId(null);
  }, [elements, hoveredId]);

  const onCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    canvasDownRef.current = e.target === e.currentTarget;
  }, []);

  const onCanvasClick = useCallback(
    (e: React.MouseEvent) => {
      const startedOnCanvas = canvasDownRef.current;
      canvasDownRef.current = false;
      if (touchMovedRef.current) {
        // The touch gesture panned/zoomed; its trailing click is not a tap.
        touchMovedRef.current = false;
        dismissedBarRef.current = false;
        return;
      }
      if (dismissedBarRef.current) {
        // This tap's job was closing an action bar; the prompt box waits
        // for the next one.
        dismissedBarRef.current = false;
        return;
      }
      if (Date.now() - touchTapRef.current < 500) {
        // A touch-tap on an action button just fired (e.g. delete). Once the
        // element unmounts, the tap's synthesized click lands on the canvas
        // itself — don't let it open the prompt box.
        return;
      }
      if (e.target !== e.currentTarget || !startedOnCanvas) return;
      if (promptBox) {
        setPromptBox(null);
        setPromptText('');
        return;
      }
      setPromptBox({
        sx: e.clientX,
        sy: e.clientY,
        wx: (e.clientX - panRef.current.x) / zoomRef.current,
        wy: (e.clientY - panRef.current.y) / zoomRef.current,
      });
    },
    [promptBox]
  );

  // Paper-size picker content, shared by the toolbar dropdown and the
  // centered dialog opened from the hamburger menu.
  const paperMenuItems = (
    <>
    {PAPER_SIZES.map((s) => (
      <div key={s.id} className="paper-item">
        <span
          className="paper-thumb"
          style={{ width: Math.round((28 * s.wMM) / s.hMM), height: 28 }}
        />
        <span className="paper-item-text">
          <strong>{s.name}</strong>
          <span>
            {s.wMM} × {s.hMM} mm
          </span>
        </span>
        <button
          className="toolbar-btn paper-add"
          title={`Add ${s.name}`}
          onClick={() => addPaper(s.id, s.wMM, s.hMM)}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 12h14" />
            <path d="M12 5v14" />
          </svg>
        </button>
      </div>
    ))}
    <div className="paper-custom">
      <span
        className="paper-thumb"
        style={{
          width: Math.max(10, Math.min(40, Math.round((28 * (Number(customW) || 1)) / (Number(customH) || 1)))),
          height: 28,
        }}
      />
      <span className="paper-item-text">
        <strong>Custom</strong>
        <span className="paper-custom-inputs">
          <input
            type="number"
            min={20}
            max={2000}
            value={customW}
            onChange={(e) => setCustomW(e.target.value)}
          />
          ×
          <input
            type="number"
            min={20}
            max={2000}
            value={customH}
            onChange={(e) => setCustomH(e.target.value)}
          />
          mm
        </span>
      </span>
      <button
        className="toolbar-btn paper-add"
        title="Add this custom size"
        onClick={() => addPaper('custom', Number(customW), Number(customH))}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 12h14" />
          <path d="M12 5v14" />
        </svg>
      </button>
    </div>
    </>
  );

  return (
    <div
      ref={canvasRef}
      className="canvas"
      data-theme={theme}
      onMouseDown={onCanvasMouseDown}
      onPointerDown={onCanvasPointerDown}
      onPointerMove={onCanvasPointerMove}
      onPointerUp={onCanvasPointerUp}
      onPointerCancel={onCanvasPointerUp}
      onClick={onCanvasClick}
      style={{
        backgroundSize: `${DOT_GRID * zoom}px ${DOT_GRID * zoom}px`,
        backgroundPosition: `${pan.x}px ${pan.y}px`,
      }}
    >
      <div className="toolbar toolbar-left">
        <button
          className={`toolbar-btn menu-btn${showMenu ? ' menu-open' : ''}`}
          onClick={() => {
            closePromptBox();
            setShowMenu((v) => !v);
          }}
          title="Menu"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 6h16" />
            <path d="M4 12h16" />
            <path d="M4 18h16" />
          </svg>
        </button>
        <span className="divider collapse-md" />
        <button className="toolbar-btn collapse-md" onClick={newCanvas} title="Start a new blank canvas">
          New
        </button>
        <span className="divider collapse-md" />
        <span className="code-wrap collapse-md">
          <input
            className="code-input"
            value={openCode}
            onChange={(e) => {
              setOpenCode(e.target.value.toUpperCase());
              setCodeError(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && openCanvas()}
            placeholder="Enter code"
            maxLength={CODE_LENGTH}
          />
          {codeError && <div className="code-error">{codeError}</div>}
        </span>
        <button
          className="toolbar-btn collapse-md"
          onClick={openCanvas}
          // Enabled only for a complete 6-char code. Same code + no changes =
          // a pointless reload, so disable; with unsaved changes it stays
          // clickable ("discard my edits and restore the snapshot").
          disabled={
            openCode.trim().length !== CODE_LENGTH ||
            (openCode.toUpperCase().trim() === currentCode && !dirty)
          }
          title={
            openCode.toUpperCase().trim() === currentCode && currentCode
              ? dirty
                ? 'Reopen this code to discard unsaved changes'
                : 'This canvas is already open'
              : 'Open a saved canvas by its code'
          }
        >
          Open
        </button>
      </div>

      <div className="toolbar toolbar-center">
        <button
          className="toolbar-btn icon-btn"
          onClick={undo}
          disabled={pastRef.current.length === 0}
          title="Undo"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" />
          </svg>
        </button>
        <button
          className="toolbar-btn icon-btn"
          onClick={redo}
          disabled={futureRef.current.length === 0}
          title="Redo"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m15 14 5-5-5-5" />
            <path d="M20 9H9.5a5.5 5.5 0 0 0-5.5 5.5v0a5.5 5.5 0 0 0 5.5 5.5H13" />
          </svg>
        </button>
      </div>

      {showPaperMenu &&
        (paperSubmenu ? (
          /* Opened from the hamburger menu: centered dialog. */
          <div className="open-overlay" onClick={() => setShowPaperMenu(false)}>
            <div className="menu-panel paper-menu dialog" onClick={(e) => e.stopPropagation()}>
            {paperMenuItems}
          </div>
        </div>
        ) : (
          <>
            <div className="menu-backdrop" onClick={() => setShowPaperMenu(false)} />
            <div className="menu-panel paper-menu">{paperMenuItems}</div>
          </>
        ))}

      {showOpenDialog && (
        <div className="open-overlay" onClick={() => setShowOpenDialog(false)}>
          <div className="open-box" onClick={(e) => e.stopPropagation()}>
            <input
              className="code-input"
              value={openCode}
              onChange={(e) => {
                setOpenCode(e.target.value.toUpperCase());
                setCodeError(null);
              }}
              onKeyDown={async (e) => {
                if (e.key === 'Enter' && (await openCanvas())) setShowOpenDialog(false);
              }}
              placeholder="ENTER CODE"
              maxLength={CODE_LENGTH}
              autoFocus
            />
            <button
              className="toolbar-btn open-go"
              disabled={openCode.trim().length !== CODE_LENGTH}
              onClick={async () => {
                if (await openCanvas()) setShowOpenDialog(false);
              }}
            >
              Open
            </button>
            {codeError && <div className="code-error">{codeError}</div>}
          </div>
        </div>
      )}

      {showMenu && (
        <>
          <div
            className="menu-backdrop"
            onClick={() => {
              setShowMenu(false);
              setShowPaperMenu(false);
            }}
          />
          <div className="menu-panel">
            {/* Collapsed toolbar buttons, in the toolbar's left-to-right
                order: New, Open (≤1000px), then Undo/Redo, Add paper and the
                theme toggle (≤500px). Save never collapses. */}
            <button
              className="menu-item md-only"
              onClick={() => {
                setShowMenu(false);
                newCanvas();
              }}
            >
              New canvas
            </button>
            <div className="menu-divider md-only" />
            <button
              className="menu-item md-only"
              onClick={() => {
                setShowMenu(false);
                setShowOpenDialog(true);
              }}
            >
              Open canvas…
            </button>
            <div className="menu-divider sm-only" />
            <button
              className="menu-item sm-only"
              onClick={() => {
                setShowMenu(false);
                setPaperSubmenu(true);
                setShowPaperMenu(true); // renders as a centered dialog
              }}
            >
              Add paper…
            </button>
            <div className="menu-divider sm-only" />
            <button
              className="menu-item sm-only"
              onClick={() => {
                setShowMenu(false);
                toggleTheme();
              }}
            >
              {theme === 'light' ? 'Dark mode' : 'Light mode'}
            </button>
            <div className="menu-divider sm-only" />
            {/* Between Open and API when only the md tier is collapsed. */}
            <div className="menu-divider md-mid" />
            <button
              className="menu-item"
              onClick={() => {
                setShowMenu(false);
                setShowSettings(true);
              }}
            >
              Image generation API{apiConfig?.apiKey ? '' : ' ⚠'}
            </button>
          </div>
        </>
      )}

      <div className="toolbar">
        <button
          className={`toolbar-btn icon-btn collapse-sm${showPaperMenu ? ' menu-open' : ''}`}
          onClick={() => {
            closePromptBox();
            setPaperSubmenu(false);
            setShowPaperMenu((v) => !v);
          }}
          title="Add a paper sheet"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
            <path d="M14 2v4a2 2 0 0 0 2 2h4" />
          </svg>
        </button>
        <button
          className="toolbar-btn icon-btn"
          onClick={saveCanvas}
          disabled={saving || !dirty || Object.keys(elements).length === 0}
          title={
            Object.keys(elements).length === 0
              ? 'Canvas is empty'
              : saving
                ? 'Saving…'
                : dirty
                  ? 'Save & share: freeze the canvas under a new code'
                  : 'No unsaved changes'
          }
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
            <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
            <path d="M7 3v4a1 1 0 0 0 1 1h7" />
          </svg>
        </button>
        <span className="divider collapse-sm" />
        <button
          className="theme-toggle collapse-sm"
          onClick={toggleTheme}
          title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
        >
          {theme === 'light' ? (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2" />
              <path d="M12 20v2" />
              <path d="m4.93 4.93 1.41 1.41" />
              <path d="m17.66 17.66 1.41 1.41" />
              <path d="M2 12h2" />
              <path d="M20 12h2" />
              <path d="m6.34 17.66-1.41 1.41" />
              <path d="m19.07 4.93-1.41 1.41" />
            </svg>
          )}
        </button>
      </div>

      {shareMsg && <div className="share-toast">{shareMsg}</div>}


      {editingPaperId && (
        <div className="editor-overlay">
          <div className="editor-modal" onClick={(e) => e.stopPropagation()}>
            <button
              className="editor-close"
              title="Close"
              onClick={() => (confirmClose ? setConfirmClose(false) : closePaperEditor())}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
            {confirmClose && (
              /* Unsaved changes: save / discard drop out below the close
                 button; clicking the close button again keeps editing. */
              <div className="close-confirm">
                <button
                  title="Save & close"
                  onClick={() => {
                    setConfirmClose(false);
                    savePaperEditor();
                  }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
                    <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
                    <path d="M7 3v4a1 1 0 0 0 1 1h7" />
                  </svg>
                </button>
                <button
                  className="discard"
                  title="Discard changes"
                  onClick={() => {
                    setConfirmClose(false);
                    setEditingPaperId(null);
                  }}
                >
                  {/* Floppy with an X in its body: “close WITHOUT saving”. */}
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
                    <path d="M7 3v4a1 1 0 0 0 1 1h7" />
                    <path d="m9 12.5 6 6" />
                    <path d="m15 12.5-6 6" />
                  </svg>
                </button>
              </div>
            )}
            <div className="editor-panes">
              <div className="editor-marks">
                {EDITOR_MARKS.map((m) => (
                  <button
                    key={m.title}
                    className="editor-mark-btn"
                    title={m.title}
                    onClick={() => applyMark(m)}
                  >
                    {m.icon}
                  </button>
                ))}
              </div>
              <textarea
                ref={editorInputRef}
                className="editor-input"
                value={editorDraft}
                onChange={(e) => setEditorDraft(e.target.value)}
                placeholder={'# Title\n\nWrite markdown here...'}
                autoFocus
              />
              <div className="editor-preview" ref={previewPaneRef}>
                {(() => {
                  const paper = elements[editingPaperId];
                  if (!paper || !isPaper(paper)) return null;
                  return (
                    <PreviewPages
                      paper={paper}
                      html={renderMarkdown(editorDraft)}
                      objects={Object.values(elements)
                        .filter((e): e is ImageElement => !isPaper(e))
                        .filter(
                          (e) =>
                            e.x < paper.x + paper.width &&
                            e.x + e.width > paper.x &&
                            e.y < paper.y + paper.height &&
                            e.y + e.height > paper.y
                        )}
                      zoom={previewZoom}
                    />
                  );
                })()}
              </div>
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <div
          className="settings-overlay"
          onMouseDown={(e) => {
            overlayDownRef.current = e.target === e.currentTarget;
          }}
          onClick={(e) => {
            const startedOnOverlay = overlayDownRef.current;
            overlayDownRef.current = false;
            if (startedOnOverlay && e.target === e.currentTarget) setShowSettings(false);
          }}
        >
          <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Image generation API</h3>
            <p className="settings-hint">
              Bring your own key. It is stored only in this browser and sent per-request; the
              server never saves it.
            </p>

            <label>Provider</label>
            <select
              value={draft.provider}
              onChange={(e) => selectDraftProvider(e.target.value as ApiProvider)}
            >
              {(Object.keys(PRESETS) as ApiProvider[]).map((p) => (
                <option key={p} value={p}>
                  {PRESETS[p].label}
                </option>
              ))}
            </select>

            {draft.provider === 'custom' && (
              <>
                <label>Base URL</label>
                <input
                  type="url"
                  value={draft.baseUrl}
                  onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                  placeholder="https://your-proxy.example.com"
                />
                <label>API format</label>
                <select
                  value={draft.format}
                  onChange={(e) => setDraft({ ...draft, format: e.target.value as ApiFormat })}
                >
                  <option value="openai">OpenAI format</option>
                  <option value="gemini">Gemini format</option>
                  <option value="openrouter">OpenRouter format</option>
                </select>
              </>
            )}

            <label>Model</label>
            <input
              type="text"
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              placeholder={PRESETS[draft.provider].defaultModel || 'model name'}
            />

            <label>API key</label>
            <input
              type="password"
              value={draft.apiKey}
              onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              placeholder={PRESETS[draft.provider].keyHint}
            />

            <div className="settings-actions">
              <button className="toolbar-btn" onClick={saveSettings}>
                Save
              </button>
              <button className="toolbar-btn secondary" onClick={() => setShowSettings(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div
        className="world"
        style={
          {
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            '--inv-zoom': 1 / zoom, // element controls counter-scale to stay a fixed screen size
          } as React.CSSProperties
        }
      >
        {Object.values(elements)
          // Paper always sits beneath image objects: rendering papers first
          // means later siblings (the objects) paint on top of them.
          .sort((a, b) => Number(isPaper(b)) - Number(isPaper(a)))
          .map((el) => {
          // The container is exactly the image box: the buttons render outside
          // it as descendants, so while hidden they occupy nothing (canvas
          // clicks pass through), yet once visible the pointer moving onto
          // them still counts as staying inside (no pointerleave).
          const flip = el.x * zoom + pan.x < 64; // not enough room on the left
          // Multi-page papers grow their box by the decoy sheet's offset so the
          // hover outline encloses the stack peeking out behind.
          const stackExtra =
            isPaper(el) && multiPageIds.has(el.id)
              ? STACK_OFFSET * (el.width / (el.wMM * PX_PER_MM))
              : 0;
          const boxW = el.width + stackExtra;
          const boxH = el.height + stackExtra;
          return (
          <div
            key={el.id}
            className={`element${hoveredId === el.id ? ' hovered' : ''}`}
            style={{ left: el.x, top: el.y, width: boxW, height: boxH }}
            onPointerDown={(e) => startDrag(e, el)}
            onPointerLeave={(e) => {
              // Touch has no hover: taps toggle the actions instead, and a
              // lifting finger must not clear them.
              if (e.pointerType === 'touch') return;
              setHoveredId((cur) => (cur === el.id ? null : cur));
            }}
          >
            <div
              className="element-body"
              style={{ left: 0, width: boxW, height: boxH }}
              onPointerEnter={(e) => {
                // Hover-by-enter is a REAL-mouse concept only: on touch, taps
                // set it explicitly in startDrag, and the boundary events a
                // browser synthesizes after a tap (arriving as pointerType
                // "touch" OR "mouse", depending on the engine) must never
                // re-hover whatever sat beneath a just-deleted element. So:
                // non-mouse types are ignored outright, and mouse-typed ones
                // still pass the action-timestamp guard.
                if (e.pointerType !== 'mouse') return;
                if (Date.now() - touchTapRef.current < 500) return;
                setHoveredId(el.id);
              }}
              onPointerMove={(e) => {
                // Lets a mouse re-arm the hover after the guard window (the
                // suppressed pointerenter won't fire again on its own). The
                // same timestamp guard applies: after a tap on mobile the
                // browser synthesizes compat events with pointerType "mouse",
                // and those must not re-hover the element beneath a deletion.
                if (e.pointerType !== 'mouse') return;
                if (Date.now() - touchTapRef.current < 500) return;
                setHoveredId(el.id);
              }}
            >
              {isPaper(el) ? (
                <PaperPages el={el} onMultiPage={reportMultiPage} />
              ) : (
                <img src={el.image_url} alt={el.prompt} title={el.prompt} draggable={false} />
              )}
              {/* Papers are fixed at their natural size (so on-canvas text stays
                  the size that matches print); only image objects resize. */}
              {!isPaper(el) && (
                <div className="resize-handle" onPointerDown={(e) => startResize(e, el)} />
              )}
            </div>
            <div className={`element-actions${flip ? ' right' : ''}${isPaper(el) ? '' : ' arc'}`}>
            {isPaper(el) && (
              <>
                <button
                  className="corner-btn"
                  title="Edit document"
                  {...press(() => openPaperEditor(el))}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                    <path d="m15 5 4 4" />
                  </svg>
                </button>
              </>
            )}
            <button
              className="corner-btn dup-btn"
              title="Duplicate"
              {...press(() => duplicateElement(el))}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="9" y="9" width="13" height="13" rx="2.5" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
            {!isPaper(el) && (
              <button
                className="corner-btn"
                title="Download image"
                {...press(() => downloadImage(el))}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" x2="12" y1="15" y2="3" />
                </svg>
              </button>
            )}
            {isPaper(el) && (
              <button
                className="corner-btn"
                title="Download markdown"
                {...press(() => downloadMarkdown(el))}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" x2="12" y1="15" y2="3" />
                </svg>
              </button>
            )}
            {isPaper(el) && (
              <button
                className="corner-btn"
                title="Print (stickers on the paper are included)"
                {...press(() => printPaper(el))}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                  <path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6" />
                  <rect x="6" y="14" width="12" height="8" rx="1" />
                </svg>
              </button>
            )}
            <button
              className="corner-btn delete-btn"
              title="Delete"
              {...press(() => deleteElement(el.id))}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 6h18" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
            </button>
            </div>
          </div>
          );
        })}

        {loadingSpots.map((s) => (
          <div key={s.key} className="dot-wave" style={{ left: s.x, top: s.y }}>
            {waveDots(s.x, s.y).map((d, i) => (
              <span
                key={i}
                style={{ left: d.ox, top: d.oy, animationDelay: `${d.delay.toFixed(3)}s` }}
              />
            ))}
          </div>
        ))}
      </div>

      {promptBox && (
        <div
          ref={promptBoxRef}
          className="prompt-box"
          style={{ left: promptBox.sx, top: promptBox.sy }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="prompt-row">
            <input
              ref={inputRef}
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitPrompt();
                if (e.key === 'Escape') {
                  setPromptBox(null);
                  setPromptText('');
                }
              }}
              placeholder="A sleepy cat, a slice of cake..."
            />
            <button className="generate-btn" onClick={submitPrompt} title="Generate">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" />
                <path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" />
              </svg>
            </button>
          </div>
          {libraryGrid}
        </div>
      )}
    </div>
  );
}
