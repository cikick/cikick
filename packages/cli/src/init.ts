export const STARTER_CONFIG = `import { App, Workflow } from '@cikick/core';

export default (app: App) => {
  const ci = new Workflow(app, 'ci', {
    name: 'CI',
    on: { push: { branches: ['main'] }, pull_request: {} },
    permissions: { contents: 'read' },
  });
  const job = ci.addJob('test', { runsOn: 'ubuntu-latest', timeoutMinutes: 15 });
  job.addStep({ uses: 'actions/checkout@v4' });
  job.addStep({ run: 'echo hello from cikick' });
};
`;

export const RENOVATE_SNIPPET = `{
  "extends": ["config:recommended"],
  "packageRules": [
    {
      "matchPackageNames": ["@cikick/**", "@your-org/wf-**"],
      "postUpgradeTasks": {
        "commands": ["npx cikick update"],
        "fileFilters": [".github/**", "cikick.lock.json", "cikick.config.ts"],
        "executionMode": "branch"
      }
    }
  ]
}`;

export const SCRIPTS_HINT = `Add to package.json:
  "scripts": {
    "cikick:synth": "cikick synth",
    "cikick:check": "cikick check"
  }`;
