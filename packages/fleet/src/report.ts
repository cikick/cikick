import { writeFileSync } from 'node:fs';
import type { GitHubClient } from './client.js';
import { renderHtmlReport, type FleetReportData } from './html.js';
import { inventory } from './inventory.js';
import { secretsReport } from './secrets.js';
import { settingsDiff } from './settings.js';
import type { FleetConfig } from './types.js';

export async function buildReport(client: GitHubClient, config: FleetConfig, targets: string[], opts: { now?: Date; maxAgeDays?: number } = {}): Promise<FleetReportData> {
  const now = opts.now ?? new Date();
  return {
    generatedAt: now.toISOString(),
    repos: targets,
    inventory: await inventory(client, targets),
    secrets: await secretsReport(client, config, targets, { now, maxAgeDays: opts.maxAgeDays }),
    settings: config.settingsPolicy ? await settingsDiff(client, targets, config.settingsPolicy) : undefined,
  };
}

export async function writeHtmlReport(client: GitHubClient, config: FleetConfig, targets: string[], out: string, opts: { now?: Date } = {}): Promise<FleetReportData> {
  const data = await buildReport(client, config, targets, opts);
  writeFileSync(out, renderHtmlReport(data));
  return data;
}
