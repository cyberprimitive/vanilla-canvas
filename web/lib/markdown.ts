import { marked } from 'marked';

// Shared markdown rendering for the canvas paper, the editor preview and
// printing, so all three stay pixel-identical.
//
// Standard markdown collapses ANY run of blank lines into a single paragraph
// break. To let users add vertical space by pressing Enter — n blank lines =
// n-1 empty paragraphs — every blank line beyond a run's first becomes a
// non-breaking-space paragraph before parsing. Fenced code blocks are left
// untouched (their blank lines are literal content).
export function renderMarkdown(content: string): string {
  const lines = (content || '').split('\n');
  const out: string[] = [];
  let fence = false;
  let blanks = 0;
  const flush = () => {
    if (blanks > 0) {
      out.push('');
      for (let i = 1; i < blanks; i++) out.push('&nbsp;', '');
    }
    blanks = 0;
  };
  for (const line of lines) {
    if (fence) {
      out.push(line);
      if (/^\s*(```|~~~)/.test(line)) fence = false;
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      fence = true;
      out.push(line);
      continue;
    }
    if (!line.trim()) {
      blanks++;
      continue;
    }
    flush();
    out.push(line);
  }
  flush(); // trailing blank lines make trailing space too
  return marked.parse(out.join('\n')) as string;
}
