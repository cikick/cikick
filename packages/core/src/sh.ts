/**
 * Tagged template for multi-line `run:` scripts. Write the script indented to match your code; `sh` removes the
 * indentation so the synthesised YAML is a clean block scalar.
 *
 * - Removes the common leading indentation of the non-blank lines.
 * - Drops the first line when it is empty (the newline after the opening backtick) and any trailing blank
 *   lines/whitespace, so the result has no trailing newline (it serialises like `lines.join('\n')`).
 * - Interpolated values are inserted as strings; a multi-line value is re-indented to the indentation of the
 *   line it is inserted in, so dedenting stays correct.
 * - The template is cooked, like any template literal: `\${var}` yields the shell text `${var}` and
 *   `\${{ secrets.TOKEN }}` yields the GitHub expression `${{ secrets.TOKEN }}`. A bare `${...}` is a
 *   JavaScript interpolation, so always escape the `$` for shell parameter expansion and GitHub expressions.
 *   Likewise `\\` is a single backslash, so a line continuation needs `\\\\` and `\n` is a real newline.
 *
 * @example
 * ```ts
 * job.addStep({
 *   run: sh`
 *     set -euo pipefail
 *     if [ -n "\${TOKEN:-}" ]; then
 *       echo "configured=true" >> "$GITHUB_OUTPUT"
 *     fi
 *   `,
 * });
 * // set -euo pipefail
 * // if [ -n "${TOKEN:-}" ]; then
 * //   echo "configured=true" >> "$GITHUB_OUTPUT"
 * // fi
 * ```
 *
 * @example GitHub expressions and interpolation
 * ```ts
 * const pm = 'pnpm';
 * sh`
 *   echo "\${{ github.ref_name }}"
 *   ${pm} install
 * `;
 * ```
 */
export function sh(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i] ?? strings.raw[i] ?? '';
    if (i < values.length) {
      const value = String(values[i]);
      const lineStart = out.lastIndexOf('\n') + 1;
      const indent = /^[ \t]*/.exec(out.slice(lineStart))![0];
      out += indent ? value.replace(/\r?\n/g, `\n${indent}`) : value;
    }
  }
  return dedent(out);
}

function dedent(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() === '') lines.shift();
  let common: string | undefined;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const lead = /^[ \t]*/.exec(line)![0];
    if (common === undefined) common = lead;
    else {
      let n = 0;
      while (n < common.length && n < lead.length && common[n] === lead[n]) n++;
      common = common.slice(0, n);
    }
  }
  const cut = common?.length ?? 0;
  return lines
    .map((l) => (l.trim() === '' ? '' : l.slice(cut)))
    .join('\n')
    .replace(/\s+$/, '');
}
