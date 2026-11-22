export type OverrideOp =
  | { op: 'set'; path: string; value: unknown }
  | { op: 'delete'; path: string };

/** Split a dot path; `\.` escapes a literal dot. */
export function parsePath(path: string): string[] {
  return path.split(/(?<!\\)\./).map((s) => s.replace(/\\\./g, '.'));
}

const isIndex = (s: string) => /^\d+$/.test(s);

export function setPath(obj: any, path: string, value: unknown): void {
  const segs = parsePath(path);
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    const key: string | number = Array.isArray(cur) && isIndex(seg) ? Number(seg) : seg;
    let next = cur[key];
    if (next === null || typeof next !== 'object') {
      next = isIndex(segs[i + 1]!) ? [] : {};
      cur[key] = next;
    }
    cur = next;
  }
  const last = segs[segs.length - 1]!;
  cur[Array.isArray(cur) && isIndex(last) ? Number(last) : last] = value;
}

export function deletePath(obj: any, path: string): void {
  const segs = parsePath(path);
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    cur = cur?.[Array.isArray(cur) && isIndex(seg) ? Number(seg) : seg];
    if (cur === null || typeof cur !== 'object') return;
  }
  const last = segs[segs.length - 1]!;
  if (Array.isArray(cur) && isIndex(last)) cur.splice(Number(last), 1);
  else delete cur[last];
}

export function applyOverrides(obj: unknown, ops: readonly OverrideOp[]): void {
  for (const o of ops) {
    if (o.op === 'set') setPath(obj, o.path, o.value);
    else deletePath(obj, o.path);
  }
}

/** Remove undefined values recursively (returns a new structure). */
export function prune<T>(v: T): T {
  if (Array.isArray(v)) return v.map(prune) as any;
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out: any = {};
    for (const [k, val] of Object.entries(v)) if (val !== undefined) out[k] = prune(val);
    return out;
  }
  return v;
}

export const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
export const snake = (s: string) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
