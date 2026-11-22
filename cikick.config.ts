import { type App } from '@cikick/core';
import { applyBaseline } from '@cikick/policies';
import { ConventionalCommits, NodeCi, ReleasePlease } from '@cikick/workflows';

// Dogfooding: this repo's workflows and release config come from @cikick/workflows, the same
// constructs downstream repos use. Regenerate with `pnpm cikick synth`; verify with `pnpm cikick check` (runs in CI).
export default (app: App) => {
  new NodeCi(app, 'ci', {
    commands: {
      Build: 'pnpm build',
      Typecheck: 'pnpm typecheck',
      Lint: 'pnpm lint',
      Format: 'pnpm format:check',
      Test: 'pnpm test',
    },
    // The workspace CLI's bin isn't linked until after build, so use the root script.
    cikickCheck: 'pnpm cikick check',
  });

  new ConventionalCommits(app, 'conventional-commits');

  new ReleasePlease(app, 'release', {
    packages: ['packages/core', 'packages/cli', 'packages/policies', 'packages/fleet', 'packages/workflows'],
    // npm trusted publishing (OIDC): each package has a trusted publisher on npmjs.com, no token.
    publish: {},
  });

  applyBaseline(app);
};
