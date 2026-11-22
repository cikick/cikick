import { App } from '@cikick/core';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createJiti } from 'jiti';

export const CONFIG_NAMES = ['cikick.config.ts', 'cikick.config.mts', 'cikick.config.js', 'cikick.config.mjs'];

export type ConfigFn = (app: App) => void | Promise<void>;

export function findConfigFile(repoDir: string): string {
  for (const n of CONFIG_NAMES) {
    const p = join(repoDir, n);
    if (existsSync(p)) return resolve(p);
  }
  throw new Error(`No cikick.config.ts (or .js/.mjs) found in ${resolve(repoDir)}. Run \`npx cikick init\`.`);
}

/** Import a module with jiti, uncached so repeated loads see fresh file contents. */
export async function importModule(file: string): Promise<any> {
  const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, interopDefault: true });
  return jiti.import(file);
}

export interface LoadedConfig {
  app: App;
  configPath: string;
}

/** Load the repo's config: default export is an App, or a function `(app) => void | Promise<void>`. */
export async function loadConfig(repoDir: string, configure?: (app: App) => void): Promise<LoadedConfig> {
  const configPath = findConfigFile(repoDir);
  const mod = await importModule(configPath);
  let exp = mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod;
  // interopDefault may yield the default export directly
  let app: App;
  if (typeof exp === 'function') {
    app = new App({ outdir: resolve(repoDir) });
    configure?.(app);
    await (exp as ConfigFn)(app);
  } else if (exp && typeof exp === 'object' && typeof (exp as any).synth === 'function' && (exp as any).node) {
    app = exp as App;
    configure?.(app);
  } else {
    throw new Error(`${configPath}: default export must be an App or a function (app) => void`);
  }
  return { app, configPath };
}
