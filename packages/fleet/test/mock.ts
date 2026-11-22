import type { GitHubClient } from '../src/client.js';

export type Handler = (params: Record<string, any>) => any;
export interface Call { route: string; params: Record<string, any> }

/** Mock keyed by exact route template. Handlers may throw {status} errors. */
export function mockClient(handlers: Record<string, Handler | any>): GitHubClient & { calls: Call[] } {
  const calls: Call[] = [];
  const run = (route: string, params: Record<string, any> = {}) => {
    calls.push({ route, params });
    const h = handlers[route];
    if (h === undefined) throw Object.assign(new Error(`unmocked ${route}`), { status: 404 });
    return typeof h === 'function' ? h(params) : h;
  };
  return {
    calls,
    async request(route, params) {
      return { status: 200, ...(() => { const d = run(route, params); return d && d.__status ? { status: d.__status, data: d.data } : { data: d }; })() };
    },
    async paginate(route, params) {
      return run(route, params);
    },
  };
}

export const b64 = (s: string) => Buffer.from(s).toString('base64');
export const notFound = () => { throw Object.assign(new Error('Not Found'), { status: 404 }); };
