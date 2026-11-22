import type { IConstruct } from 'constructs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from './app.js';
import type { SynthFile } from './synth.js';

export type Severity = 'info' | 'warn' | 'error';

export interface RepoSettings {
  defaultWorkflowPermissions?: 'read' | 'write';
  allowedActions?: 'all' | 'local_only' | 'selected';
  actionsEnabled?: boolean;
  [key: string]: unknown;
}

export interface Finding {
  checkId: string;
  severity: Severity;
  message: string;
  path?: string;
  fix?: () => void;
}

export interface CheckContext {
  app: App;
  repoDir: string;
  readFile(path: string): string | undefined;
  settings?: RepoSettings;
  /** Files produced by this synth (added). */
  files?: SynthFile[];
}

export interface Check {
  id: string;
  severity: Severity;
  /** ISO date; after it, `warn` findings are upgraded to `error`. */
  enforceAfter?: string;
  run(ctx: CheckContext): Finding[] | Promise<Finding[]>;
}

const KEY = Symbol.for('@cikick/core.Checks');

export class Checks {
  static of(scope: IConstruct): Checks {
    let c = (scope as any)[KEY] as Checks | undefined;
    if (!c) {
      c = new Checks();
      Object.defineProperty(scope, KEY, { value: c, enumerable: false });
    }
    return c;
  }
  private readonly list: Check[] = [];
  add(check: Check): void {
    this.list.push(check);
  }
  get all(): readonly Check[] {
    return this.list;
  }
}

export interface RunChecksOptions {
  repoDir: string;
  settings?: RepoSettings;
  files?: SynthFile[];
  now?: Date;
}

/** Effective severity of a check given the current date. */
export function effectiveSeverity(severity: Severity, enforceAfter: string | undefined, now: Date): Severity {
  if (severity === 'warn' && enforceAfter && now.getTime() > new Date(enforceAfter).getTime()) return 'error';
  return severity;
}

export async function runChecks(app: App, opts: RunChecksOptions): Promise<Finding[]> {
  const now = opts.now ?? new Date();
  const ctx: CheckContext = {
    app,
    repoDir: opts.repoDir,
    settings: opts.settings,
    files: opts.files,
    readFile(p) {
      const full = join(opts.repoDir, p);
      return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
    },
  };
  const findings: Finding[] = [];
  for (const node of [app as IConstruct, ...app.node.findAll()]) {
    for (const check of Checks.of(node).all) {
      const res = await check.run(ctx);
      for (const f of res) {
        findings.push({ ...f, checkId: f.checkId || check.id, severity: effectiveSeverity(f.severity ?? check.severity, check.enforceAfter, now) });
      }
    }
  }
  return findings;
}
