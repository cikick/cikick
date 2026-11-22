export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** syntax-highlight helpers: wrap escaped text in a token class */
export const t = (cls: 'k' | 's' | 'c' | 'h' | 'n' | 'p' | 'a' | 'r', s: string) =>
  `<span class="${cls}">${esc(s)}</span>`;

/** Wrap each line of HTML in an animated stage span; delay = start + i*step (ms). */
export function stagger(lines: string[], start = 0, step = 90): string {
  return lines
    .map((l, i) => `<span class="ln st" style="--d:${start + i * step}">${l === '' ? ' ' : l}</span>`)
    .join('');
}
