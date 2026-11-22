import type { FleetConfig, RepoRef } from './types.js';

/** Thrown when a command is asked to touch a repository outside the user's selection. */
export class NotSelectedError extends Error {
  constructor(public readonly repos: string[]) {
    super(`Refusing to operate on repositories not in the fleet selection: ${repos.join(', ')}. Add them with "cikick-fleet select --add".`);
    this.name = 'NotSelectedError';
  }
}

export function parseRepo(full: string): RepoRef {
  const [owner, repo, ...rest] = full.split('/');
  if (!owner || !repo || rest.length) throw new Error(`Invalid repository "${full}", expected owner/repo`);
  return { owner, repo, full };
}

export interface TargetOptions {
  repos?: string[];
  group?: string;
}

/**
 * Resolve the repos a command may act on. The result is always a subset of
 * `config.repos`; anything else throws NotSelectedError.
 */
export function resolveTargets(config: FleetConfig, opts: TargetOptions = {}): string[] {
  const selected = new Set(config.repos);
  let result: string[] = [...config.repos];
  if (opts.group !== undefined) {
    const members = config.groups?.[opts.group];
    if (!members) throw new Error(`Unknown group "${opts.group}"`);
    const bad = members.filter((r) => !selected.has(r));
    if (bad.length) throw new NotSelectedError(bad);
    result = [...members];
  }
  if (opts.repos && opts.repos.length) {
    const bad = opts.repos.filter((r) => !selected.has(r));
    if (bad.length) throw new NotSelectedError(bad);
    const want = new Set(opts.repos);
    result = result.filter((r) => want.has(r));
  }
  return [...new Set(result)];
}
