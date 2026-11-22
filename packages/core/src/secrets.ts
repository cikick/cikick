import type { IConstruct } from 'constructs';
import { Construct } from 'constructs';

export type SecretScope = 'repo' | 'env' | 'org';

export interface SecretDeclProps {
  name: string;
  scope: SecretScope;
  environment?: string;
  maxAgeDays?: number;
  provider?: string;
  description?: string;
}

const BRAND = Symbol.for('@cikick/core.SecretDecl');

export class SecretDecl extends Construct {
  static isSecretDecl(x: unknown): x is SecretDecl {
    return typeof x === 'object' && x !== null && (x as any)[BRAND] === true;
  }
  readonly [BRAND] = true;
  readonly name: string;
  readonly scope: SecretScope;
  readonly environment?: string;
  maxAgeDays?: number;
  provider?: string;
  description?: string;

  constructor(scope: Construct, id: string, props: SecretDeclProps) {
    super(scope, id);
    this.name = props.name;
    this.scope = props.scope;
    this.environment = props.environment;
    this.maxAgeDays = props.maxAgeDays;
    this.provider = props.provider;
    this.description = props.description;
  }
}

/**
 * Reference a secret in a workflow expression and register a SecretDecl on the app root.
 * Returns `${{ secrets.NAME }}`. Repeated calls for the same (name, scope, environment) reuse one decl;
 * later opts fill in unset fields.
 */
export function secret(scope: IConstruct, name: string, opts: Partial<Omit<SecretDeclProps, 'name'>> = {}): string {
  const root = scope.node.root;
  const dscope = opts.scope ?? 'repo';
  const id = `secret:${dscope}:${opts.environment ?? ''}:${name}`;
  const existing = root.node.tryFindChild(id);
  if (SecretDecl.isSecretDecl(existing)) {
    existing.maxAgeDays ??= opts.maxAgeDays;
    existing.provider ??= opts.provider;
    existing.description ??= opts.description;
  } else {
    new SecretDecl(root as Construct, id, { ...opts, name, scope: dscope });
  }
  return `\${{ secrets.${name} }}`;
}

export interface SecretManifestEntry {
  name: string;
  scope: SecretScope;
  environment?: string;
  maxAgeDays?: number;
  provider?: string;
  description?: string;
}

/** All declared secrets in the tree, sorted by name/scope/environment. */
export function secretsManifest(app: IConstruct): SecretManifestEntry[] {
  return app.node
    .findAll()
    .filter(SecretDecl.isSecretDecl)
    .map((d) => {
      const e: SecretManifestEntry = { name: d.name, scope: d.scope };
      if (d.environment !== undefined) e.environment = d.environment;
      if (d.maxAgeDays !== undefined) e.maxAgeDays = d.maxAgeDays;
      if (d.provider !== undefined) e.provider = d.provider;
      if (d.description !== undefined) e.description = d.description;
      return e;
    })
    .sort((a, b) => (a.name + a.scope + (a.environment ?? '')).localeCompare(b.name + b.scope + (b.environment ?? '')));
}
