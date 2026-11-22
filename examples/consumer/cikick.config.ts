import { Workflow, secret, type App } from '@cikick/core';
import { applyBaseline } from '@cikick/policies';
import { NodeCi } from '@acme/wf-node-ci';

export default (app: App) => {
  const ci = new NodeCi(app, 'node', {
    nodeVersion: 22,
    packageManager: 'pnpm',
    test: 'pnpm test -- --coverage',
    release: {},
    extraSteps: [
      { name: 'Upload coverage', uses: 'actions/upload-artifact@v7', with: { name: 'coverage', path: 'coverage' } },
    ],
  });

  // Escape hatches into the shared construct
  ci.testJob.addOverride('runs-on', 'ubuntu-24.04');
  ci.testJob.addOverride('env.CI', 'true');
  ci.buildJob.props.runsOn = ['self-hosted', 'linux'];
  ci.workflow.addOverride('concurrency.cancel-in-progress', false);

  // Custom workflow with an environment-scoped secret
  const deploy = new Workflow(app, 'deploy', { name: 'Deploy', on: { workflowDispatch: {} } });
  const job = deploy.addJob('deploy', { runsOn: 'ubuntu-latest', environment: 'production' });
  job.addStep({ uses: 'actions/checkout@v7' });
  job.addStep({
    name: 'Deploy',
    run: './scripts/deploy.sh',
    env: { DEPLOY_KEY: secret(app, 'DEPLOY_KEY', { scope: 'env', environment: 'production', maxAgeDays: 30 }) },
  });

  applyBaseline(app);
};
