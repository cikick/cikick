const SHA_RE = /^[0-9a-f]{40}$/i;

export function isSha(ref: string): boolean {
  return SHA_RE.test(ref);
}

export interface ActionRefProps {
  owner: string;
  repo: string;
  path?: string;
  ref: string;
  sha?: string;
}

export class ActionRef {
  /** Parse `owner/repo[/path]@ref`. Throws on invalid input. */
  static of(spec: string): ActionRef {
    const at = spec.lastIndexOf('@');
    if (at <= 0 || at === spec.length - 1) throw new Error(`Invalid action ref "${spec}" (expected owner/repo[/path]@ref)`);
    const parts = spec.slice(0, at).split('/');
    if (parts.length < 2 || !parts[0] || !parts[1]) throw new Error(`Invalid action ref "${spec}" (expected owner/repo[/path]@ref)`);
    return new ActionRef({ owner: parts[0], repo: parts[1], path: parts.slice(2).join('/') || undefined, ref: spec.slice(at + 1) });
  }

  /** Like `of`, but returns undefined for local (`./`) and `docker://` references. */
  static tryParse(spec: string): ActionRef | undefined {
    if (spec.startsWith('./') || spec.startsWith('docker://')) return undefined;
    return ActionRef.of(spec);
  }

  readonly owner: string;
  readonly repo: string;
  readonly path?: string;
  readonly ref: string;
  sha?: string;

  constructor(props: ActionRefProps) {
    this.owner = props.owner;
    this.repo = props.repo;
    this.path = props.path;
    this.ref = props.ref;
    this.sha = props.sha ?? (isSha(props.ref) ? props.ref : undefined);
  }

  /** Lock key: `owner/repo@ref`. */
  get key(): string {
    return `${this.owner}/${this.repo}@${this.ref}`;
  }

  /** `owner/repo[/path]` */
  get target(): string {
    return `${this.owner}/${this.repo}${this.path ? '/' + this.path : ''}`;
  }

  /** Original spec `owner/repo[/path]@ref`. */
  toSpec(): string {
    return `${this.target}@${this.ref}`;
  }

  /** Rendered form: pinned to sha when resolved, else the original ref. */
  toString(): string {
    return `${this.target}@${this.sha ?? this.ref}`;
  }
}
