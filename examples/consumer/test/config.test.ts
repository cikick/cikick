import { App, emptyLockfile, secretsManifest, synth } from '@cikick/core';
import { describe, expect, it } from 'vitest';
import config from '../cikick.config.js';

const dir = new URL('..', import.meta.url).pathname;
const ACTIONS = ['actions/checkout@v7', 'actions/setup-node@v7', 'actions/upload-artifact@v7', 'pnpm/action-setup@v6'];

describe('consumer config', () => {
  it('synths with a frozen lock and no error findings', async () => {
    const lock = emptyLockfile();
    ACTIONS.forEach(
      (k, i) => (lock.actions[k] = { sha: String(i + 1).repeat(40), resolvedAt: '2026-01-01T00:00:00.000Z' }),
    );
    const app = new App();
    config(app);
    const r = await synth(app, { repoDir: dir, lock, frozen: true });

    expect(r.files.map((f) => f.path)).toEqual([
      '.github/workflows/ci.yml',
      '.github/workflows/deploy.yml',
      '.nvmrc',
      'renovate.json',
    ]);
    expect(r.findings.filter((f) => f.severity === 'error')).toEqual([]);

    const ci = r.files[0]!.content;
    expect(ci).toContain('runs-on: ubuntu-24.04');
    expect(ci).toContain('- self-hosted');
    expect(ci).toContain(`actions/upload-artifact@${'3'.repeat(40)} # v7`);
    expect(ci).toContain('permissions:'); // from baseline aspect
    expect(ci).toContain('timeout-minutes: 30');
    expect(r.files[1]!.content).toContain('environment: production');
    expect(JSON.parse(r.files[3]!.content).labels).toEqual(['dependencies']);
    expect(secretsManifest(app).map((s) => s.name)).toEqual(['DEPLOY_KEY', 'NPM_TOKEN']);
  });
});
