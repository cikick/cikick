import { isSha } from './action-ref.js';
import type { Lockfile } from './lockfile.js';

export interface ActionResolver {
  resolve(owner: string, repo: string, ref: string): Promise<string>;
}

export class MissingLockEntryError extends Error {
  constructor(public readonly key: string) {
    super(`No lock entry for ${key}. Run \`npx cikick lock\` (or synth without --frozen) to resolve it.`);
    this.name = 'MissingLockEntryError';
  }
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<unknown>;
}>;

export interface GitHubResolverOptions {
  token?: string;
  fetch?: FetchLike;
  apiUrl?: string;
}

/** Resolves refs via the GitHub commits API. Accepts `{token, fetch}` or `(fetch, token)`. */
export class GitHubResolver implements ActionResolver {
  private readonly token?: string;
  private readonly fetchFn: FetchLike;
  private readonly apiUrl: string;

  constructor(optsOrFetch: GitHubResolverOptions | FetchLike = {}, token?: string) {
    const opts: GitHubResolverOptions = typeof optsOrFetch === 'function' ? { fetch: optsOrFetch, token } : optsOrFetch;
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.apiUrl = (opts.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
  }

  async resolve(owner: string, repo: string, ref: string): Promise<string> {
    if (isSha(ref)) return ref;
    const url = `${this.apiUrl}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`;
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'cikick', 'X-GitHub-Api-Version': '2022-11-28' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await this.fetchFn(url, { headers });
    if (!res.ok) throw new Error(`Failed to resolve ${owner}/${repo}@${ref}: HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`);
    const body = (await res.json()) as { sha?: string };
    if (!body.sha || !isSha(body.sha)) throw new Error(`Unexpected response resolving ${owner}/${repo}@${ref}`);
    return body.sha;
  }
}

/** Resolves only from an existing lockfile (SHA refs pass through). */
export class LockResolver implements ActionResolver {
  constructor(private readonly lock: Lockfile) {}
  async resolve(owner: string, repo: string, ref: string): Promise<string> {
    if (isSha(ref)) return ref;
    const key = `${owner}/${repo}@${ref}`;
    const e = this.lock.actions[key];
    if (!e) throw new MissingLockEntryError(key);
    return e.sha;
  }
}
