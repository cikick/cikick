import { describe, expect, it } from 'vitest';
import { selectMigrations, type Migration } from '../src/index.js';

const m = (version: string): Migration => ({ version, description: version, async run() {} });

describe('selectMigrations', () => {
  const all = [m('2.0.0'), m('1.1.0'), m('1.0.0'), m('1.2.0'), m('3.0.0-beta.1')];
  it('from < v <= to, ascending', () => {
    expect(selectMigrations(all, '1.0.0', '2.0.0').map((x) => x.version)).toEqual(['1.1.0', '1.2.0', '2.0.0']);
  });
  it('empty when nothing in range', () => {
    expect(selectMigrations(all, '2.0.0', '2.0.0')).toEqual([]);
  });
  it('prerelease ordering and invalid input', () => {
    expect(selectMigrations(all, '2.0.0', '3.0.0').map((x) => x.version)).toEqual(['3.0.0-beta.1']);
    expect(() => selectMigrations(all, 'x', '1.0.0')).toThrow();
  });
});
