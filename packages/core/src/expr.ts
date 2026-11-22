const EXPR = Symbol.for('@cikick/core.Expr');

/**
 * A GitHub Actions expression that converts to its `${{ ... }}` string form. It can be interpolated into
 * `sh` templates and template literals, and used directly as a value in `env`, `with`, `if` and other props.
 * Property access builds a longer path: `github.event.inputs.tag` is `${{ github.event.inputs.tag }}`.
 */
export type Expr = string & { readonly [key: string]: Expr };

function make(path: string): Expr {
  const text = `\${{ ${path} }}`;
  const target = function () {} as unknown as object;
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === EXPR) return true;
      if (prop === Symbol.toPrimitive) return () => text;
      if (prop === 'toString' || prop === 'valueOf' || prop === 'toJSON') return () => text;
      if (typeof prop === 'symbol') return undefined;
      return make(`${path}.${prop}`);
    },
  }) as Expr;
}

/** True for values created by `expr` and the expression roots (`github`, `env`, ...). */
export function isExpr(v: unknown): v is Expr {
  return typeof v === 'function' && (v as any)[EXPR] === true;
}

/** Raw expression: `expr("github.ref == 'refs/heads/main'")` is `${{ github.ref == 'refs/heads/main' }}`. */
export function expr(body: string): Expr {
  return make(body.trim());
}

const root = (name: string): Expr => make(name);

/**
 * Typed expression roots. Each is a proxy: `github.ref` is `${{ github.ref }}`,
 * `steps.build.outputs.path` is `${{ steps.build.outputs.path }}`, `needs.test.outputs.ok` likewise.
 *
 * For secrets use `secret(scope, 'NAME')`, which also records the secret in the manifest (there is deliberately
 * no `secrets` proxy).
 *
 * Security: expressions such as `inputs.*`, `github.event.*` and `github.head_ref` are attacker-controllable. The
 * `noScriptInjection` policy flags them inside `run`. Pass them through `env` and read `$NAME` in the script:
 *
 * ```ts
 * job.addStep({ env: { TAG: inputs.tag }, run: sh`git tag "$TAG"` });
 * ```
 */
export const github: Expr = root('github');
export const env: Expr = root('env');
export const vars: Expr = root('vars');
export const inputs: Expr = root('inputs');
export const steps: Expr = root('steps');
export const needs: Expr = root('needs');
export const matrix: Expr = root('matrix');
export const runner: Expr = root('runner');
export const job: Expr = root('job');
