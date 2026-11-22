import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

// Shared via globalThis: the config may load a different copy of @cikick/core than the CLI.
const ROOT = Symbol.for('@cikick/core.scriptRoot');
const getRoot = (): string | undefined => (globalThis as any)[ROOT];

/** Set the directory `script()` resolves relative paths against (the CLI sets it to the repo directory). */
export function setScriptRoot(dir: string | undefined): void {
  (globalThis as any)[ROOT] = dir === undefined ? undefined : resolve(dir);
}

export interface ScriptOptions {
  /** Replace `@@NAME@@` placeholders with these values. Unreplaced placeholders are an error. */
  vars?: Record<string, string | number | boolean>;
  /** Base directory for a relative path. Defaults to the repo directory (the CLI's `--dir`), else the cwd. */
  root?: string;
}

/**
 * Read a shell file at synth time and return its contents for a `run:` value. Long scripts live in `.sh` files with
 * normal shell syntax: no `\${}` escaping and editor/shellcheck support. A relative `path` resolves against the repo
 * directory. CRLF is normalised and trailing whitespace removed (no trailing newline), so output is deterministic.
 * Throws if the file is missing.
 *
 * @example
 * ```ts
 * job.addStep({ run: script('.github/scripts/move-major-tag.sh') });
 * job.addStep({ run: script('scripts/deploy.sh', { vars: { ENV: 'prod' } }) }); // replaces @@ENV@@
 * ```
 */
export function script(path: string, opts: ScriptOptions = {}): string {
  const file = isAbsolute(path) ? path : resolve(opts.root ?? getRoot() ?? process.cwd(), path);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`script(): cannot read ${file}: ${(e as Error).message}`);
  }
  text = text.replace(/\r\n/g, '\n');
  for (const [k, v] of Object.entries(opts.vars ?? {})) text = text.split(`@@${k}@@`).join(String(v));
  const left = /@@[A-Za-z_][A-Za-z0-9_]*@@/.exec(text);
  if (opts.vars && left) throw new Error(`script(): ${file} has unreplaced placeholder ${left[0]}`);
  return text.replace(/\s+$/, '');
}
