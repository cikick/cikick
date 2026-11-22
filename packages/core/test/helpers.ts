import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionResolver } from '../src/index.js';

export const tmp = () => mkdtempSync(join(tmpdir(), 'cikick-'));
export const SHA = (c: string) => c.repeat(40);

export class FakeResolver implements ActionResolver {
  calls: string[] = [];
  async resolve(o: string, r: string, ref: string) {
    this.calls.push(`${o}/${r}@${ref}`);
    return SHA('a');
  }
}
