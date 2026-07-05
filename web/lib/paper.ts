// Paper elements: printable sheets living on the canvas.

// World pixels per millimeter at design scale (zoom 1). A4 = 420×594 world px.
// Only affects how large a paper appears on the canvas; text density is
// independent of it (the body font is a fraction of the page width, below).
export const PX_PER_MM = 2;

// Page margin (all four sides): 10% of the paper's SHORT side, so it scales
// with the paper instead of eating small pages (A4 → 21mm, A5 → 14.8mm,
// A3 → 29.7mm). It stays an exact millimetre value on the printed page via
// PX_PER_MM.
export const PAGE_MARGIN_RATIO = 0.1;
export const pageMarginMM = (wMM: number, hMM: number) => Math.min(wMM, hMM) * PAGE_MARGIN_RATIO;
// Same margin in design px.
export const pagePad = (wMM: number, hMM: number) => pageMarginMM(wMM, hMM) * PX_PER_MM;

// One fixed body size (a normal ~12.5pt) on any paper, used by BOTH the
// canvas rendering (via PX_PER_MM) and printing, so the canvas is WYSIWYG
// with the printed page on every paper size.
export const PRINT_FONT_MM = 4.4;

// Offset (design px) of the decoy sheet stacked behind a multi-page paper.
export const STACK_OFFSET = 8;

export type PaperSize = { id: string; name: string; wMM: number; hMM: number };

export const PAPER_SIZES: PaperSize[] = [
  { id: 'a4', name: 'A4', wMM: 210, hMM: 297 },
  { id: 'a5', name: 'A5', wMM: 148, hMM: 210 },
  { id: 'a3', name: 'A3', wMM: 297, hMM: 420 },
  { id: 'letter', name: 'Letter', wMM: 216, hMM: 279 },
];
