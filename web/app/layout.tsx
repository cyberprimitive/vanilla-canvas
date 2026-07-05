import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Vanilla Canvas',
  description: 'A shareable AI sticker canvas on warm vanilla paper',
};

// Lock page zoom: mobile Safari auto-zooms the page when focusing inputs
// with sub-16px text (the prompt box), and that zoom is what shoved the
// fixed toolbars off-screen — it never zooms back on blur. The canvas has
// its own pinch-zoom, so page zoom is all downside here.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
