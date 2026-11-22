import { describe, expect, it, vi } from 'vitest';
import { App, FrozenLockError, GitHubResolver, LockResolver, MissingLockEntryError, Workflow, readLockfile, serializeLockfile, synth, writeLockfile, type Lockfile } from '../src/index.js';
import { FakeResolver, SHA, tmp } from './helpers.js';

const appWith = (uses: string) => {
  const app = new App();
  new Workflow(app, 'ci', { on: 'push' }).addJob('j', { runsOn: 'x' }).addStep({ uses });
  return app;
};

describe('lockfile', () => {
  it('serializes with stable sorted keys and roundtrips', () => {
    const lock: Lockfile = { version: 1, packages: { z: '1', a: '2' }, actions: { 'b/b@v1': { sha: SHA('b'), resolvedAt: 't' }, 'a/a@v1': { resolvedAt: 't', sha: SHA('a') } } };
    const s = serializeLockfile(lock);
    expect(s.indexOf('a/a@v1')).toBeLessThan(s.indexOf('b/b@v1'));
    expect(s.indexOf('"actions"')).toBeLessThan(s.indexOf('"packages"'));
    expect(s.endsWith('\n')).toBe(true);
    const dir = tmp();
    expect(readLockfile(dir)).toBeUndefined();
    writeLockfile(dir, lock);
    expect(readLockfile(dir)).toEqual(lock);
  });

  it('frozen errors when entry missing, passes when locked', async () => {
    const dir = tmp();
    await expect(synth(appWith('actions/checkout@v4'), { repoDir: dir, frozen: true, resolver: new FakeResolver() })).rejects.toBeInstanceOf(FrozenLockError);
    const lock: Lockfile = { version: 1, packages: {}, actions: { 'actions/checkout@v4': { sha: SHA('d'), resolvedAt: 't' } } };
    const res = await synth(appWith('actions/checkout@v4'), { repoDir: dir, frozen: true, lock });
    expect(res.files[0]!.content).toContain(`actions/checkout@${SHA('d')} # v4`);
  });

  it('frozen ignores sha refs; existing lock entries are not re-resolved; stale entries dropped', async () => {
    const r = new FakeResolver();
    const lock: Lockfile = { version: 1, packages: { p: '1.0.0' }, actions: { 'old/x@v1': { sha: SHA('1'), resolvedAt: 't' }, 'actions/checkout@v4': { sha: SHA('d'), resolvedAt: 't' } } };
    const res = await synth(appWith('actions/checkout@v4'), { repoDir: tmp(), resolver: r, lock });
    expect(r.calls).toEqual([]);
    expect(Object.keys(res.lock.actions)).toEqual(['actions/checkout@v4']);
    expect(res.lock.packages).toEqual({ p: '1.0.0' });
    const res2 = await synth(appWith(`actions/checkout@${SHA('e')}`), { repoDir: tmp(), frozen: true });
    expect(res2.files[0]!.content).toContain(`uses: actions/checkout@${SHA('e')}\n`);
    expect(res2.lock.actions).toEqual({});
  });

  it('LockResolver', async () => {
    const lr = new LockResolver({ version: 1, packages: {}, actions: { 'a/b@v1': { sha: SHA('f'), resolvedAt: 't' } } });
    expect(await lr.resolve('a', 'b', 'v1')).toBe(SHA('f'));
    expect(await lr.resolve('a', 'b', SHA('9'))).toBe(SHA('9'));
    await expect(lr.resolve('a', 'b', 'v2')).rejects.toBeInstanceOf(MissingLockEntryError);
  });
});

describe('GitHubResolver', () => {
  it('passes through shas without fetching', async () => {
    const f = vi.fn();
    expect(await new GitHubResolver({ fetch: f as any }).resolve('a', 'b', SHA('1'))).toBe(SHA('1'));
    expect(f).not.toHaveBeenCalled();
  });

  it('calls commits API with token', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ sha: SHA('c') }) }));
    const sha = await new GitHubResolver({ fetch: f as any, token: 'tok' }).resolve('actions', 'checkout', 'v4');
    expect(sha).toBe(SHA('c'));
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe('https://api.github.com/repos/actions/checkout/commits/v4');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('positional (fetch, token) form and errors', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    await expect(new GitHubResolver(f as any, 't').resolve('a', 'b', 'nope')).rejects.toThrow(/404/);
  });

  it('uses global fetch by default', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ sha: SHA('7') }) })) as any;
    try {
      expect(await new GitHubResolver().resolve('a', 'b', 'v1')).toBe(SHA('7'));
    } finally {
      globalThis.fetch = orig;
    }
  });
});
