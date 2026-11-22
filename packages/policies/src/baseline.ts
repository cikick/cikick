import { Aspects, Checks, type App, type Check, type IAspect } from '@cikick/core';
import { DefaultTimeout, ExplicitPermissions } from './aspects.js';
import {
  noCancelInProgressDeploy,
  noPullRequestTargetCheckout,
  noScriptInjection,
  requireExplicitPermissions,
  requirePinnedActions,
  requireTimeout,
} from './checks.js';

export interface BaselineOptions {
  /** Default timeout applied to jobs lacking one. Default 30. */
  timeoutMinutes?: number;
  /** Default permissions. Default `{ contents: 'read' }`. */
  permissions?: ConstructorParameters<typeof ExplicitPermissions>[0];
}

export interface Baseline {
  aspects: IAspect[];
  checks: Check[];
}

/** Opinionated security baseline: least-privilege permissions + timeouts, plus the stock checks. */
export function securityBaseline(opts: BaselineOptions = {}): Baseline {
  return {
    aspects: [
      new ExplicitPermissions(opts.permissions ?? { default: { contents: 'read' } }),
      new DefaultTimeout(opts.timeoutMinutes ?? 30),
    ],
    checks: [
      requirePinnedActions,
      requireExplicitPermissions,
      noPullRequestTargetCheckout,
      noScriptInjection,
      noCancelInProgressDeploy,
      requireTimeout,
    ],
  };
}

/** Register the baseline's aspects and checks on the app. */
export function applyBaseline(app: App, opts: BaselineOptions = {}): Baseline {
  const b = securityBaseline(opts);
  for (const a of b.aspects) Aspects.of(app).add(a);
  for (const c of b.checks) Checks.of(app).add(c);
  return b;
}
