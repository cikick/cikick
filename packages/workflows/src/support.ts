import { secret, type Job, type PermissionLevel, type StepProps } from '@cikick/core';
import type { IConstruct } from 'constructs';

/** GitHub Packages (or any npm registry) authentication for installs, via `setup-node` + `NODE_AUTH_TOKEN`. */
export interface GitHubPackagesAuth {
  /** npm scope served by the registry, e.g. `@craftvalueorg`. */
  scope: string;
  /** Default `https://npm.pkg.github.com`. */
  registry?: string;
  /**
   * Secret holding the token. Default: the workflow's `GITHUB_TOKEN` (which needs `packages: read`, added for you).
   * The token is passed to steps through `NODE_AUTH_TOKEN`; it is never echoed or written by a script.
   */
  tokenSecret?: string;
}

export interface ResolvedRegistryAuth {
  /** `with:` entries for `actions/setup-node`. */
  setupNode: Record<string, string>;
  /** `env:` entries for the steps that install from the registry. */
  env: Record<string, string>;
}

const SCOPE = /^@[a-z0-9][\w.-]*$/i;

export function resolveRegistryAuth(scope: IConstruct, auth: GitHubPackagesAuth): ResolvedRegistryAuth {
  if (!SCOPE.test(auth.scope)) throw new Error(`registryAuth.scope must look like "@org", got "${auth.scope}"`);
  const registry = auth.registry ?? 'https://npm.pkg.github.com';
  if (!/^https:\/\/[\w./-]+$/.test(registry)) throw new Error(`registryAuth.registry is not a valid https URL`);
  const token = auth.tokenSecret
    ? secret(scope, auth.tokenSecret, { description: `token to install ${auth.scope} packages` })
    : '${{ secrets.GITHUB_TOKEN }}';
  return { setupNode: { 'registry-url': registry, scope: auth.scope }, env: { NODE_AUTH_TOKEN: token } };
}

/** Reject values that are interpolated into shell commands unless they are plain tokens (names, paths, versions). */
export function shellSafe(value: string, label: string): string {
  if (!/^[\w./@:=+-]+$/.test(value)) throw new Error(`${label} contains characters that are not allowed: "${value}"`);
  return value;
}

/** Add a `read`/`write` permission to a job, falling back to its workflow's permissions when the job has none. */
export function grantPermission(job: Job, name: string, level: PermissionLevel): void {
  const own = job.props.permissions;
  if (own && typeof own === 'object') {
    own[name] = level;
    return;
  }
  const wf = job.node.scope as { props?: { permissions?: unknown } } | undefined;
  const wfPerms = wf?.props?.permissions;
  if (wfPerms && typeof wfPerms === 'object') {
    (wfPerms as Record<string, PermissionLevel>)[name] = level;
    return;
  }
  job.permissions = { contents: 'read', [name]: level };
}

export type PackageManager = 'npm' | 'pnpm';

export interface ToolchainOptions {
  /** Default `pnpm` (uses `pnpm/action-setup`, version from `packageManager` in package.json). */
  packageManager?: PackageManager;
  /** Node.js major version. Default 22. */
  nodeVersion?: number;
  /** `actions/checkout` `fetch-depth` (`0` = full history). Default: the action's. */
  fetchDepth?: number;
  /** `actions/checkout` `ref`. */
  checkoutRef?: string;
  /** Registry authentication, from `resolveRegistryAuth(scope, { scope: '@org' })`. */
  auth?: ResolvedRegistryAuth;
  /** Name of the install step. Default `Install`. */
  installStepName?: string;
}

/**
 * checkout, (pnpm setup), setup-node with dependency caching, install (with optional registry auth).
 * The same steps `NodeCi` and `CloudflareDeploy` start with; use it to build custom workflows.
 */
export function toolchainSteps(o: ToolchainOptions = {}): StepProps[] {
  const pm = o.packageManager ?? 'pnpm';
  const checkoutWith: Record<string, unknown> = {};
  if (o.fetchDepth !== undefined) checkoutWith['fetch-depth'] = o.fetchDepth;
  if (o.checkoutRef !== undefined) checkoutWith.ref = o.checkoutRef;
  const steps: StepProps[] = [
    { uses: 'actions/checkout@v7', with: Object.keys(checkoutWith).length ? checkoutWith : undefined },
  ];
  if (pm === 'pnpm') steps.push({ uses: 'pnpm/action-setup@v6' });
  steps.push({
    uses: 'actions/setup-node@v7',
    with: { 'node-version': o.nodeVersion ?? 22, cache: pm, ...o.auth?.setupNode },
  });
  steps.push({
    name: o.installStepName ?? 'Install',
    run: pm === 'pnpm' ? 'pnpm install --frozen-lockfile' : 'npm ci',
    env: o.auth?.env,
  });
  return steps;
}
