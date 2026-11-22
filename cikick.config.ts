import { Workflow, type App } from '@cikick/core';
import { applyBaseline } from '@cikick/policies';

// Dogfooding: the docs site deploy workflow is itself a cikick construct.
// Regenerate with `pnpm exec cikick synth`; CI-style verification: `pnpm exec cikick check`.
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

  applyBaseline(app);
};
