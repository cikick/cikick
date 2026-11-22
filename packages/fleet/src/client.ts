import { Octokit } from '@octokit/rest';

/**
 * Minimal Octokit-like surface. All GitHub I/O in this package goes through it
 * so tests can inject a mock. `route` is an Octokit route string such as
 * `GET /repos/{owner}/{repo}/actions/secrets`.
 */
export interface GitHubClient {
  request(route: string, params?: Record<string, unknown>): Promise<{ status: number; data: any }>;
  /** Follows pagination and returns the flattened items (wrapped payloads such as `{secrets: []}` are unwrapped). */
  paginate(route: string, params?: Record<string, unknown>): Promise<any[]>;
}

export function tokenFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const t = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!t) throw new Error('No GitHub token: set GITHUB_TOKEN or GH_TOKEN.');
  return t;
}

export function createClient(token: string = tokenFromEnv()): GitHubClient {
  const octokit = new Octokit({ auth: token, userAgent: 'cikick-fleet' });
  return {
    request: (route, params) => octokit.request(route, params as any) as Promise<{ status: number; data: any }>,
    paginate: (route, params) => octokit.paginate(route, { per_page: 100, ...params } as any) as Promise<any[]>,
  };
}

export function errorStatus(e: unknown): number | undefined {
  return typeof e === 'object' && e !== null && 'status' in e ? Number((e as { status: unknown }).status) : undefined;
}

/** Run a GET and map 404 to `undefined`. */
export async function getOrUndefined(
  client: GitHubClient,
  route: string,
  params?: Record<string, unknown>,
): Promise<any | undefined> {
  try {
    return (await client.request(route, params)).data;
  } catch (e) {
    if (errorStatus(e) === 404) return undefined;
    throw e;
  }
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
