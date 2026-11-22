import { ManagedFile, Workflow, type App } from '@cikick/core';
import { applyBaseline } from '@cikick/policies';

// Dogfooding: this repo's workflows and release config are cikick constructs.
// Regenerate with `pnpm cikick synth`; verify with `pnpm cikick check` (runs in CI).
export default (app: App) => {
  const pages = new Workflow(app, 'docs-pages', {
    name: 'Docs (GitHub Pages)',
    on: {
      push: { branches: ['main'], paths: ['docs-site/**', '.github/workflows/docs-pages.yml'] },
      workflowDispatch: {},
    },
    permissions: { contents: 'read', pages: 'write', idToken: 'write' },
    concurrency: { group: 'pages', cancelInProgress: false },
  });

  const build = pages.addJob('build', { runsOn: 'ubuntu-latest', timeoutMinutes: 15 });
  build.addStep({ uses: 'actions/checkout@v4' });
  build.addStep({
    uses: 'actions/setup-node@v4',
    with: { 'node-version': 22, cache: 'npm', 'cache-dependency-path': 'docs-site/package-lock.json' },
  });
  build.addStep({ name: 'Install', run: 'npm ci', workingDirectory: 'docs-site' });
  build.addStep({ name: 'Build', run: 'npm run build', workingDirectory: 'docs-site' });
  build.addStep({ uses: 'actions/upload-pages-artifact@v3', with: { path: 'docs-site/dist' } });

  const deploy = pages.addJob('deploy', {
    runsOn: 'ubuntu-latest',
    needs: build,
    timeoutMinutes: 10,
    environment: { name: 'github-pages', url: '${{ steps.deployment.outputs.page_url }}' },
  });
  deploy.addStep({ id: 'deployment', uses: 'actions/deploy-pages@v4' });

  // CI: build, typecheck, lint, format, test, and `cikick check` (drift + policies) on ourselves.
  const ci = new Workflow(app, 'ci', {
    name: 'CI',
    on: { push: { branches: ['main'] }, pullRequest: {} },
    permissions: { contents: 'read' },
    concurrency: { group: '${{ github.workflow }}-${{ github.ref }}', cancelInProgress: true },
  });
  const check = ci.addJob('check', { runsOn: 'ubuntu-latest', timeoutMinutes: 15 });
  check.addStep({ uses: 'actions/checkout@v4' });
  check.addStep({ uses: 'pnpm/action-setup@v4' });
  check.addStep({ uses: 'actions/setup-node@v4', with: { 'node-version': 22, cache: 'pnpm' } });
  check.addStep({ name: 'Install', run: 'pnpm install --frozen-lockfile' });
  check.addStep({ name: 'Build', run: 'pnpm build' });
  check.addStep({ name: 'Typecheck', run: 'pnpm typecheck' });
  check.addStep({ name: 'Lint', run: 'pnpm lint' });
  check.addStep({ name: 'Format', run: 'pnpm format:check' });
  check.addStep({ name: 'Test', run: 'pnpm test' });
  check.addStep({ name: 'cikick check', run: 'pnpm cikick check' });

  // Release: release-please opens/updates a release PR from conventional commits; merging it tags + releases.
  const publishable = ['packages/core', 'packages/cli', 'packages/policies', 'packages/fleet'];
  new ManagedFile(app, 'release-please-config', {
    path: 'release-please-config.json',
    mode: 'managed',
    content: {
      $schema: 'https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json',
      'release-type': 'node',
      'include-component-in-tag': true,
      'separate-pull-requests': false,
      plugins: ['node-workspace'],
      packages: Object.fromEntries(publishable.map((p) => [p, {}])),
    },
  });
  // Seeded: release-please owns version bumps after the first synth.
  new ManagedFile(app, 'release-please-manifest', {
    path: '.release-please-manifest.json',
    mode: 'seeded',
    content: Object.fromEntries(publishable.map((p) => [p, '0.1.0'])),
  });
  const release = new Workflow(app, 'release-please', {
    name: 'Release',
    on: { push: { branches: ['main'] }, workflowDispatch: {} },
    permissions: { contents: 'write', pullRequests: 'write' },
    concurrency: { group: 'release-please', cancelInProgress: false },
  });
  release
    .addJob('release-please', { runsOn: 'ubuntu-latest', timeoutMinutes: 10 })
    .addStep({ id: 'release', uses: 'googleapis/release-please-action@v4' });

  applyBaseline(app);
};
