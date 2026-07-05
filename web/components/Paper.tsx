'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PaperElement } from '@/lib/supabase';
import { renderMarkdown } from '@/lib/markdown';
import { PX_PER_MM, pagePad, PRINT_FONT_MM, STACK_OFFSET } from '@/lib/paper';

// Renders a paper element as a SINGLE page. Content is laid out at the paper's
// design size and clipped to one page: anything past the first page is hidden
// from view (but stays in el.content, editable and printed in full). When the
// content overflows one page, decoy sheets are stacked behind to hint that
// there's more. Resizing only changes the outer CSS scale, so layout never
// reflows.
export default function PaperPages({
  el,
  onMultiPage,
}: {
  el: PaperElement;
  onMultiPage?: (id: string, multi: boolean) => void;
}) {
  const designW = el.wMM * PX_PER_MM;
  const designH = el.hMM * PX_PER_MM;
  const pad = pagePad(el.wMM, el.hMM);
  const innerW = designW - pad * 2;
  const innerH = designH - pad * 2;
  const scale = el.width / designW;

  // Body font is the FIXED print size (4.4mm in design px) on every paper, so
  // what you see on the canvas is what prints — a small paper simply fits
  // fewer characters per line, exactly like the printed page.
  const fontSize = PRINT_FONT_MM * PX_PER_MM;
  // Corner radius counter-scaled to a constant on-screen size, so it tracks the
  // hover outline's (also constant) radius as the paper is zoomed/resized.
  const cornerRadius = `calc(${(8 / scale).toFixed(3)}px * var(--inv-zoom, 1))`;

  const html = useMemo(() => renderMarkdown(el.content), [el.content]);

  // Does the content spill past the first page? If so, stack ONE decoy sheet
  // and clip at the last WHOLE line that fits, so the bottom line isn't halved.
  const measureRef = useRef<HTMLDivElement>(null);
  const [multiPage, setMultiPage] = useState(false);
  const [clipH, setClipH] = useState(innerH);
  useLayoutEffect(() => {
    const c = measureRef.current;
    if (!c) return;
    const full = c.scrollHeight;
    // Ignore overflow smaller than a line (trailing margins / rounding) so a
    // paper whose content fits one page shows no stack at all.
    const multi = full > innerH + fontSize;
    setMultiPage(multi);
    onMultiPage?.(el.id, multi);
    if (!multi) {
      setClipH(innerH);
      return;
    }
    // Find the lowest line-box / block bottom that still fits within one page,
    // and clip there — never through the middle of a line. Client rects are
    // normalised by the container's rendered-vs-layout height to undo any
    // ancestor scale (canvas zoom × paper scale), giving design px.
    const box = c.getBoundingClientRect();
    const s = box.height / full || 1;
    const top = box.top;
    let best = 0;
    const consider = (clientBottom: number) => {
      const b = (clientBottom - top) / s;
      if (b <= innerH && b > best) best = b;
    };
    const walk = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let node: Node | null;
    while ((node = walk.nextNode())) {
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      range.selectNodeContents(node);
      for (const r of Array.from(range.getClientRects())) {
        if (r.height > 0) consider(r.bottom);
      }
    }
    c.querySelectorAll('img, hr, tr, pre, blockquote').forEach((n) =>
      consider(n.getBoundingClientRect().bottom)
    );
    setClipH(best > 0 ? best : innerH);
  }, [html, innerH, fontSize, el.id, onMultiPage]);

  return (
    <div
      className="paper-stack"
      style={{ width: designW, transform: `scale(${scale})`, transformOrigin: 'top left' }}
    >
      {multiPage && (
        // Rendered before the top page (and offset down-right) so it peeks out
        // behind it, hinting there's more than one page.
        <div
          className="paper-page paper-stacked"
          style={{
            width: designW,
            height: designH,
            top: STACK_OFFSET,
            left: STACK_OFFSET,
            borderRadius: cornerRadius,
          }}
        />
      )}
      <div
        className="paper-page"
        style={{ width: designW, height: designH, borderRadius: cornerRadius }}
      >
        <div
          ref={measureRef}
          className="md-body paper-measure"
          style={{ width: innerW, fontSize }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
        <div
          className="paper-clip"
          style={{
            top: 0,
            left: 0,
            width: designW,
            height: pad + clipH,
            paddingTop: pad,
            paddingLeft: pad,
            paddingRight: pad,
          }}
        >
          <div
            className="md-body"
            style={{ width: innerW, fontSize }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
        {/* Dashed page-margin guide, revealed while the paper is hovered
            (via .element.hovered in globals.css). */}
        <div
          className="paper-margin-guide"
          style={{ left: pad, top: pad, width: innerW, height: innerH }}
        />
      </div>
    </div>
  );
}
