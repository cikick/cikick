import { Construct } from 'constructs';
import type { Lockfile } from './lockfile.js';
import { synth, type SynthOptions, type SynthResult } from './synth.js';

export interface AppProps {
  outdir?: string;
  lock?: Lockfile;
}

export class App extends Construct {
  readonly outdir?: string;
  lock?: Lockfile;

  constructor(opts: AppProps = {}) {
    super(undefined as any, '');
    this.outdir = opts.outdir;
    this.lock = opts.lock;
  }

  /** Convenience for `synth(app, opts)`; `repoDir` defaults to `outdir` or cwd. */
  synth(opts: Partial<SynthOptions> = {}): Promise<SynthResult> {
    return synth(this, { ...opts, repoDir: opts.repoDir ?? this.outdir ?? process.cwd() });
  }
}
