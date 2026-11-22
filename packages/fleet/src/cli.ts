import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import pc from 'picocolors';
import { createClient, type GitHubClient } from './client.js';
import { loadConfig, loadConfigOrEmpty, saveConfig } from './config.js';
import { inventory } from './inventory.js';
import { writeHtmlReport } from './report.js';
import { DEFAULT_MAX_AGE_DAYS, needsAttention, rotateSecret, secretsReport } from './secrets.js';
import { applyChosen, listAdminRepos, selectNonInteractive } from './select.js';
import { resolveTargets } from './selection.js';
import { settingsApply, settingsDiff } from './settings.js';

export interface CliDeps {
  client?: GitHubClient;
  out?: (s: string) => void;
  readStdin?: () => string;
  env?: NodeJS.ProcessEnv;
  /** interactive checkbox: returns chosen repo names */
  choose?: (choices: { name: string; checked: boolean }[]) => Promise<string[]>;
}

const list = (v: string, prev: string[] = []) => [...prev, ...v.split(',').map((s) => s.trim()).filter(Boolean)];

export function buildProgram(deps: CliDeps = {}): Command {
  const out = deps.out ?? ((s: string) => console.log(s));
  const client = () => (deps.client ??= createClient());
  const program = new Command('cikick-fleet').description('Fleet control plane for a user-selected set of repositories');
  program.option('-c, --config <path>', 'path to fleet.json', 'fleet.json');
  const cfgPath = () => program.opts().config as string;
  const narrow = (c: Command) => c.option('--repos <names...>', 'narrow to these selected repos (owner/repo)').option('--group <name>', 'narrow to a group');
  const targets = (o: { repos?: string[]; group?: string }) => {
    const repos = o.repos?.flatMap((r) => r.split(',')).filter(Boolean);
    return resolveTargets(loadConfig(cfgPath()), { repos, group: o.group });
  };

  program
    .command('select')
    .description('choose the repositories the fleet operates on (writes fleet.json)')
    .option('--owner <owner>', 'only list repos of this owner')
    .option('--filter <glob>', 'only list repos matching this glob')
    .option('--add <repos...>', 'add repos non-interactively', list)
    .option('--remove <repos...>', 'remove repos non-interactively', list)
    .option('--group <name>', 'also assign to / edit this group')
    .action(async (o) => {
      const cfg = loadConfigOrEmpty(cfgPath());
      let next;
      if (o.add || o.remove) {
        next = await selectNonInteractive(client(), cfg, { add: o.add, remove: o.remove, group: o.group });
      } else {
        const admin = await listAdminRepos(client(), { owner: o.owner, filter: o.filter });
        const current = new Set(o.group ? cfg.groups?.[o.group] ?? [] : cfg.repos);
        const choices = admin.map((r) => ({ name: r.full_name, checked: current.has(r.full_name) }));
        const chosen = deps.choose
          ? await deps.choose(choices)
          : await (await import('@inquirer/prompts')).checkbox({
              message: 'Select repositories',
              pageSize: 20,
              choices: choices.map((c) => ({ value: c.name, name: c.name, checked: c.checked })),
            });
        // keep previously selected repos that were not listed (filtered out) so a filter never silently drops them
        const listed = new Set(admin.map((r) => r.full_name));
        const kept = (o.group ? cfg.groups?.[o.group] ?? [] : cfg.repos).filter((r) => !listed.has(r));
        next = applyChosen(cfg, [...kept, ...chosen], o.group);
      }
      saveConfig(cfgPath(), next);
      out(`Selected ${next.repos.length} repositor${next.repos.length === 1 ? 'y' : 'ies'} in ${cfgPath()}`);
    });

  narrow(program.command('inventory').description('lock files, workflows, unpinned actions').option('--json', 'JSON output')).action(async (o) => {
    const res = await inventory(client(), targets(o));
    if (o.json) return out(JSON.stringify(res, null, 2));
    for (const r of res.repos) {
      const state = r.error ? pc.red(`error: ${r.error}`) : r.adopted ? pc.green('adopted') : pc.dim('not adopted');
      out(`${pc.bold(r.repo)}  ${state}`);
      for (const w of r.workflows) {
        out(`  ${w.path}  ${w.generated ? 'generated' : 'hand-written'}${w.unpinned.length ? pc.yellow(`  ${w.unpinned.length} unpinned`) : ''}`);
        for (const u of w.unpinned) out(`    ${pc.yellow('unpinned')} ${u}`);
      }
    }
    out('\ncikick packages:');
    if (!res.packages.length) out('  (none)');
    for (const p of res.packages) {
      out(`  ${p.name} (max ${p.max})`);
      for (const [v, repos] of Object.entries(p.versions)) out(`    ${v === p.max ? pc.green(v) : pc.yellow(v + ' outdated')}: ${repos.join(', ')}`);
    }
  });

  const settings = program.command('settings').description('settings drift against settingsPolicy');
  narrow(settings.command('diff').description('show drift')).action(async (o) => {
    const cfg = loadConfig(cfgPath());
    for (const r of await settingsDiff(client(), targets(o), cfg.settingsPolicy)) {
      out(pc.bold(r.repo) + (r.error ? pc.red(`  error: ${r.error}`) : ''));
      for (const d of r.diffs) {
        const mark = d.status === 'ok' ? pc.green('ok   ') : d.status === 'drift' ? pc.yellow('drift') : pc.dim('info ');
        out(`  ${mark} ${d.key}: desired ${JSON.stringify(d.desired)}, actual ${JSON.stringify(d.actual)}`);
      }
    }
  });
  narrow(settings.command('apply').description('apply policy (dry-run unless --yes)').option('--yes', 'actually apply')).action(async (o) => {
    const cfg = loadConfig(cfgPath());
    const res = await settingsApply(client(), targets(o), cfg.settingsPolicy, { dryRun: !o.yes });
    if (res.dryRun) out(pc.dim('Dry run: nothing changed. Re-run with --yes to apply.'));
    for (const a of res.actions) out(`${res.dryRun ? 'would set' : a.error ? pc.red('failed') : 'set'} ${a.repo}: ${a.description}${a.error ? ` (${a.error})` : ''}`);
    for (const r of res.report) out(pc.dim(`report-only ${r.repo}: ${r.key} is ${JSON.stringify(r.actual)}`));
    if (!res.actions.length) out('No changes needed.');
    if (res.actions.some((a) => a.error)) process.exitCode = 1;
  });

  const secrets = program.command('secrets').description('secret age report and rotation');
  narrow(secrets.command('report').description('secret staleness').option('--json', 'JSON output').option('--max-age <days>', 'max age for untracked secrets', String(DEFAULT_MAX_AGE_DAYS))).action(async (o) => {
    const rep = await secretsReport(client(), loadConfig(cfgPath()), targets(o), { maxAgeDays: Number(o.maxAge) });
    if (o.json) return out(JSON.stringify(rep, null, 2));
    for (const r of rep.rows) {
      const c = r.status === 'ok' ? pc.green : r.status === 'untracked' ? pc.dim : r.status === 'missing' ? pc.red : pc.yellow;
      out(`${c(r.status.padEnd(15))} ${r.repo}  ${r.scope === 'env' ? `env:${r.environment}/` : ''}${r.name}  ${r.ageDays !== undefined ? `${r.ageDays}d (max ${r.maxAgeDays})` : ''}`);
    }
    for (const e of rep.errors) out(pc.red(`error ${e.repo}: ${e.error}`));
    if (rep.rows.some(needsAttention)) process.exitCode = 1;
  });
  narrow(
    secrets
      .command('rotate <name>')
      .description('seal and PUT a secret value to each target (dry-run unless --yes)')
      .option('--env <environment>', 'environment-scoped secret')
      .option('--value-from-env <var>', 'read the value from this environment variable')
      .option('--value-from-stdin', 'read the value from stdin')
      .option('--yes', 'actually write'),
  ).action(async (name: string, o) => {
    if (!!o.valueFromEnv === !!o.valueFromStdin) throw new Error('Specify exactly one of --value-from-env or --value-from-stdin');
    const ts = targets(o);
    let value: string;
    if (o.valueFromEnv) {
      const v = (deps.env ?? process.env)[o.valueFromEnv];
      if (v === undefined || v === '') throw new Error(`Environment variable ${o.valueFromEnv} is empty or unset`);
      value = v;
    } else {
      value = (deps.readStdin ?? (() => readFileSync(0, 'utf8')))().replace(/\r?\n$/, '');
      if (!value) throw new Error('No value on stdin');
    }
    const res = await rotateSecret(client(), ts, { name, environment: o.env, value, dryRun: !o.yes });
    if (!o.yes) out(pc.dim('Dry run: nothing written. Re-run with --yes to rotate.'));
    for (const r of res) out(`${r.status.padEnd(8)} ${r.repo} ${r.environment ? `env:${r.environment}/` : ''}${r.name}${r.error ? ` (${r.error})` : ''}`);
    if (res.some((r) => r.status === 'failed')) process.exitCode = 1;
  });

  narrow(program.command('report').description('write a static HTML dashboard').requiredOption('--html <file>', 'output file')).action(async (o) => {
    await writeHtmlReport(client(), loadConfig(cfgPath()), targets(o), o.html);
    out(`Wrote ${o.html}`);
  });

  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  try {
    await buildProgram().parseAsync(argv);
  } catch (e) {
    console.error(pc.red(e instanceof Error ? e.message : String(e)));
    process.exitCode = 1;
  }
}
