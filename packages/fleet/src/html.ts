import type { InventoryResult } from './inventory.js';
import type { RepoSettingsDiff } from './settings.js';
import { needsAttention, type SecretsReport } from './secrets.js';

export interface FleetReportData {
  generatedAt: string;
  repos: string[];
  inventory: InventoryResult;
  secrets: SecretsReport;
  settings?: RepoSettingsDiff[];
}

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const fmt = (v: unknown) => (v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const badge = (cls: string, text: string) => `<span class="b ${cls}">${esc(text)}</span>`;

export function renderHtmlReport(d: FleetReportData): string {
  const adopted = d.inventory.repos.filter((r) => r.adopted).length;
  const unpinned = d.inventory.repos.reduce((n, r) => n + r.unpinnedCount, 0);
  const attention = d.secrets.rows.filter(needsAttention).length;
  const drift = (d.settings ?? []).reduce((n, r) => n + r.diffs.filter((x) => x.status === 'drift').length, 0);

  const invRows = d.inventory.repos
    .map((r) => {
      const gen = r.workflows.filter((w) => w.generated).length;
      return `<tr><td>${esc(r.repo)}</td><td>${r.error ? badge('bad', 'error') : r.adopted ? badge('ok', 'adopted') : badge('muted', 'not adopted')}</td>
<td>${esc(Object.entries(r.packages).map(([k, v]) => `${k}@${v}`).join(', ') || '—')}</td>
<td>${r.workflows.length} (${gen} generated)</td><td>${r.unpinnedCount ? badge('warn', `${r.unpinnedCount} unpinned`) : badge('ok', '0')}</td></tr>`;
    })
    .join('\n');
  const pkgRows = d.inventory.packages
    .map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.max)}</td><td>${esc(Object.entries(p.versions).map(([v, r]) => `${v} (${r.length})`).join(', '))}</td><td>${p.outdated.length ? badge('warn', `${p.outdated.length} outdated`) : badge('ok', 'current')}</td></tr>`)
    .join('\n');
  const secRows = d.secrets.rows
    .map((r) => {
      const cls = r.status === 'ok' ? 'ok' : r.status === 'untracked' ? 'muted' : r.status === 'missing' ? 'bad' : 'warn';
      return `<tr><td>${esc(r.repo)}</td><td>${esc(r.name)}</td><td>${esc(r.scope === 'env' ? `env:${r.environment}` : 'repo')}</td><td>${esc(r.updatedAt?.slice(0, 10) ?? '—')}</td><td>${r.ageDays ?? '—'}</td><td>${badge(cls, r.status)}</td></tr>`;
    })
    .join('\n');
  const setRows = (d.settings ?? [])
    .flatMap((r) =>
      r.error
        ? [`<tr><td>${esc(r.repo)}</td><td colspan="4">${badge('bad', 'error')} ${esc(r.error)}</td></tr>`]
        : r.diffs.map((x) => `<tr><td>${esc(r.repo)}</td><td>${esc(x.key)}</td><td>${esc(fmt(x.desired))}</td><td>${esc(fmt(x.actual))}</td><td>${badge(x.status === 'ok' ? 'ok' : x.status === 'drift' ? 'warn' : 'muted', x.status)}</td></tr>`),
    )
    .join('\n');
  const unpinnedList = d.inventory.repos
    .flatMap((r) => r.workflows.flatMap((w) => w.unpinned.map((u) => `<tr><td>${esc(r.repo)}</td><td>${esc(w.path)}</td><td><code>${esc(u)}</code></td></tr>`)))
    .join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>cikick fleet report</title>
<style>
:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--card:#f6f8fa;--line:#d0d7de;--ok:#1a7f37;--warn:#9a6700;--bad:#cf222e}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--card:#161b22;--line:#30363d;--ok:#3fb950;--warn:#d29922;--bad:#f85149}}
body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
h1{margin:0 0 4px}h2{margin:32px 0 8px}.sub{color:var(--muted)}
.cards{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;min-width:120px}
.card b{display:block;font-size:24px}
table{border-collapse:collapse;width:100%;margin-top:8px}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
.wrap{overflow-x:auto}
.b{padding:1px 8px;border-radius:10px;border:1px solid currentColor;font-size:12px;white-space:nowrap}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.muted{color:var(--muted)}
code{font-family:ui-monospace,monospace;font-size:12px}
</style></head><body>
<h1>cikick fleet report</h1>
<div class="sub">Generated ${esc(d.generatedAt)} for ${d.repos.length} selected repositor${d.repos.length === 1 ? 'y' : 'ies'}</div>
<div class="cards">
<div class="card"><b>${d.repos.length}</b>repositories</div>
<div class="card"><b>${adopted}</b>adopted cikick</div>
<div class="card"><b class="${unpinned ? 'warn' : 'ok'}">${unpinned}</b>unpinned action refs</div>
<div class="card"><b class="${attention ? 'warn' : 'ok'}">${attention}</b>secrets need attention</div>
${d.settings ? `<div class="card"><b class="${drift ? 'warn' : 'ok'}">${drift}</b>settings drifts</div>` : ''}
</div>
<h2>Inventory</h2><div class="wrap"><table><tr><th>Repository</th><th>State</th><th>cikick packages</th><th>Workflows</th><th>Unpinned</th></tr>
${invRows}</table></div>
<h2>Package versions</h2><div class="wrap"><table><tr><th>Package</th><th>Max seen</th><th>Versions (repos)</th><th>Status</th></tr>
${pkgRows || '<tr><td colspan="4" class="sub">No cikick packages found.</td></tr>'}</table></div>
${unpinnedList ? `<h2>Unpinned action references</h2><div class="wrap"><table><tr><th>Repository</th><th>Workflow</th><th>Reference</th></tr>\n${unpinnedList}</table></div>` : ''}
<h2>Secrets</h2><div class="wrap"><table><tr><th>Repository</th><th>Name</th><th>Scope</th><th>Updated</th><th>Age (days)</th><th>Status</th></tr>
${secRows || '<tr><td colspan="6" class="sub">No secrets.</td></tr>'}</table></div>
${d.secrets.errors.length ? `<p class="bad">${d.secrets.errors.map((e) => esc(`${e.repo}: ${e.error}`)).join('<br>')}</p>` : ''}
${d.settings ? `<h2>Settings</h2><div class="wrap"><table><tr><th>Repository</th><th>Setting</th><th>Desired</th><th>Actual</th><th>Status</th></tr>\n${setRows || '<tr><td colspan="5" class="sub">No differences.</td></tr>'}</table></div>` : ''}
</body></html>
`;
}
