import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { App, Workflow, expr, github, inputs, needs, script, sh, steps, synth, vars, env } from '../src/index.js';
import { FakeResolver, tmp } from './helpers.js';

describe('sh', () => {
  it('dedents by the common indentation and drops the empty first/last lines', () => {
    const s = sh`
      set -e
      if true; then
        echo hi
      fi
    `;
    expect(s).toBe('set -e\nif true; then\n  echo hi\nfi');
  });

  it('keeps inner blank lines empty and strips trailing whitespace', () => {
    const s = sh`
      a
      ${''}
        
      b


    `;
    expect(s).toBe('a\n\n\nb');
  });

  it('returns a single line unchanged without trailing newline', () => {
    expect(sh`echo hi`).toBe('echo hi');
    expect(sh`  echo hi  `).toBe('echo hi');
  });

  it('inserts interpolated values as strings', () => {
    const pm = 'pnpm';
    const n = 3;
    expect(sh`
      ${pm} install --retries ${n}
    `).toBe('pnpm install --retries 3');
  });

  it('re-indents multi-line interpolations to the line indentation', () => {
    const inner = 'echo a\necho b';
    const s = sh`
      if true; then
        ${inner}
      fi
    `;
    expect(s).toBe('if true; then\n  echo a\n  echo b\nfi');
  });

  it('uses cooked strings: \\${var} is shell ${var} and \\${{ }} a GitHub expression', () => {
    const s = sh`
      echo "\${HOME}" "\${{ secrets.TOKEN }}"
    `;
    expect(s).toBe('echo "${HOME}" "${{ secrets.TOKEN }}"');
  });

  it('serialises as a clean, deterministic block scalar', async () => {
    const make = async () => {
      const app = new App();
      const wf = new Workflow(app, 'ci', { on: 'push' });
      const job = wf.addJob('a', { runsOn: 'ubuntu-latest' });
      job.addStep({
        run: sh`
          echo one
          echo "\${{ github.sha }}"
        `,
      });
      return (await synth(app, { repoDir: tmp(), resolver: new FakeResolver() })).files[0]!.content;
    };
    const a = await make();
    expect(a).toContain('run: |-\n');
    expect(a).toContain('          echo one\n          echo "${{ github.sha }}"\n');
    expect(await make()).toBe(a);
  });
});

describe('expression helpers', () => {
  it('build ${{ }} strings and work in sh templates', () => {
    expect(String(github.ref)).toBe('${{ github.ref }}');
    expect(`${github.event.inputs.tag}`).toBe('${{ github.event.inputs.tag }}');
    expect(sh`echo ${steps.build.outputs.path} ${needs.a.outputs.x} ${vars.V} ${env.E} ${inputs.i}`).toBe(
      'echo ${{ steps.build.outputs.path }} ${{ needs.a.outputs.x }} ${{ vars.V }} ${{ env.E }} ${{ inputs.i }}',
    );
    expect(String(expr(" github.ref == 'refs/heads/main' "))).toBe("${{ github.ref == 'refs/heads/main' }}");
  });

  it('are rendered as strings in env/with/if', async () => {
    const app = new App();
    const wf = new Workflow(app, 'ci', { on: 'push' });
    wf.addJob('a', { runsOn: 'ubuntu-latest' }).addStep({ if: expr('always()'), env: { TAG: inputs.tag }, run: 'x' });
    const out = (await synth(app, { repoDir: tmp(), resolver: new FakeResolver() })).files[0]!.content;
    expect(out).toContain('if: ${{ always() }}');
    expect(out).toContain('TAG: ${{ inputs.tag }}');
  });
});

describe('script', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'a.sh'), 'set -e\r\nx="${y%%.*}"\necho @@ENV@@\n\n');

  it('reads a file relative to root, trims, substitutes vars', () => {
    expect(script('a.sh', { root: dir, vars: { ENV: 'prod' } })).toBe('set -e\nx="${y%%.*}"\necho prod');
  });
  it('errors on missing file and unreplaced placeholders', () => {
    expect(() => script('nope.sh', { root: dir })).toThrow(/cannot read/);
    expect(() => script('a.sh', { root: dir, vars: { OTHER: '1' } })).toThrow(/unreplaced/);
  });
});
