#!/usr/bin/env node
/**
 * Phase 28c survey: what every campaign not yet ported uses that this port does not have yet, so the
 * subsystems (the real AI, the help browser, achievements, the Lua bridge, custom dialogs) are built
 * against the campaigns' real needs, and each campaign can be checked against it when it is ported.
 *
 *   node apps/web/scripts/survey-campaigns.mjs [--reuse] [--scratch <dir>] [--only Name,Name]
 *
 * 1. Builds every scenario of each unported campaign (every campaign directory not in `campaigns.json`)
 *    with `build-scenario-snapshot.mjs` at NORMAL difficulty into a scratch directory -- macros expanded,
 *    the `[campaign]` block's events and resources merged in -- recording build failures. `--reuse` keeps
 *    snapshots already built there.
 * 2. Runs `packages/ui/scripts/audit-wml.ts` over them: every WML action tag and condition, classified.
 * 3. Scans the campaigns' own files and the built scenarios for: the Lua API their Lua calls (against what
 *    `lua-bridge`'s runtime bridges), core Lua modules they `require`, `[micro_ai]` types, custom Lua AI,
 *    `gui.show_dialog` dialogs and their widgets, achievements, `[open_help]` topics, and campaign terrain
 *    graphics or terrain types (this port's terrain rules are core's only).
 * 4. Writes `docs/CAMPAIGN_INVENTORY.md` (the report) and `docs/campaign-inventory.json` (the data).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');
const campaignsRoot = path.join(dataRoot, 'campaigns');
const args = process.argv.slice(2);
const reuse = args.includes('--reuse');
const scratch = path.resolve(args.includes('--scratch') ? args[args.indexOf('--scratch') + 1] : path.join(os.tmpdir(), 'wesnothweb2-campaign-survey'));
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const scenariosOut = path.join(scratch, 'scenarios');

const shipped = new Set(
  JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/web/public/campaigns.json'), 'utf8')).campaigns.filter((c) => !c.debug).map((c) => c.wesnothId),
);
const campaigns = fs
  .readdirSync(campaignsRoot)
  .filter((c) => fs.statSync(path.join(campaignsRoot, c)).isDirectory() && !shipped.has(c) && (!only || only.has(c)))
  .sort();

const walkFiles = (dir, test, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, test, out);
    else if (test(e.name)) out.push(p);
  }
  return out;
};
const rel = (p) => path.relative(dataRoot, p).split(path.sep).join('/');

// ── 1. Build ───────────────────────────────────────────────────────────────
const jobs = [];
for (const campaign of campaigns) {
  for (const file of walkFiles(path.join(campaignsRoot, campaign, 'scenarios'), (n) => n.endsWith('.cfg'))) {
    const stem = path.basename(file, '.cfg');
    jobs.push({ campaign, file, out: path.join(scenariosOut, campaign, `${stem}.json`) });
  }
}
const builds = [];
async function build(job) {
  if (reuse && fs.existsSync(job.out)) return { ...job, ok: true, reused: true, warnings: [] };
  fs.mkdirSync(path.dirname(job.out), { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(repoRoot, 'apps/web/scripts/build-scenario-snapshot.mjs'), path.relative(campaignsRoot, job.file), 'NORMAL', job.out], { cwd: repoRoot });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => {
      const lines = output.split('\n');
      const warnings = [...new Set(lines.filter((l) => /^Warning/.test(l.trim())).map((l) => l.trim()))];
      const error =
        code === 0 ? null : (lines.find((l) => /^\s*\w*Error: /.test(l)) ?? lines.find((l) => /Error|error:/.test(l)) ?? lines.filter(Boolean).at(-1) ?? `exit ${code}`).trim().replace(repoRoot + '/', '').slice(0, 300);
      resolve({ ...job, ok: code === 0, warnings, error });
    });
  });
}
{
  const queue = [...jobs];
  const workers = Array.from({ length: Math.max(1, Math.min(4, os.cpus().length)) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const result = await build(job);
      builds.push(result);
      console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${job.campaign}/${path.basename(job.file)}${result.error ? ` -- ${result.error}` : ''}`);
    }
  });
  await Promise.all(workers);
}

// ── 2. Audit ───────────────────────────────────────────────────────────────
const auditJson = path.join(scratch, 'audit.json');
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(repoRoot, 'packages/ui/scripts/audit-wml.ts'), '--dir', scenariosOut, '--json', auditJson, '--out', path.relative(repoRoot, path.join(scratch, 'audit.md'))], { cwd: repoRoot, stdio: 'inherit' });
  child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`audit-wml exited ${code}`))));
});
const audit = JSON.parse(fs.readFileSync(auditJson, 'utf8'));
const campaignOf = (scenarioKey) => scenarioKey.split('/')[0];

// ── 3. Scans ───────────────────────────────────────────────────────────────
/** What the Lua runtime provides (`lua-bridge`'s runtime and bootstrap): `a.b` or `a.b.c` names. */
function bridgedLuaApi() {
  const names = new Set(['wml.variables', 'wml.tag', 'wesnoth.wml_actions', 'gui.show_dialog', 'wesnoth.sync.evaluate_single', 'wesnoth.require', 'wesnoth.dofile']);
  for (const file of ['packages/lua-bridge/src/runtime.ts', 'packages/lua-bridge/src/bridges/bootstrap.ts']) {
    const src = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    for (const m of src.matchAll(/define\(\[((?:'[\w]+',?\s*)+)\]/g)) names.add([...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]).join('.'));
    for (const m of src.matchAll(/function\s+((?:wml|wesnoth|gui|stringx)(?:\.\w+)+)\s*\(/g)) names.add(m[1]);
  }
  return names;
}
const bridged = bridgedLuaApi();
const LUA_API = /\b(wesnoth|wml|gui|ai|filesystem|stringx|mathx|functional|utils|helper|items|unit_test)\s*\.\s*([A-Za-z_]\w*)(?:\s*\.\s*([A-Za-z_]\w*))?/g;
/** Sub-tables whose members are called as `wesnoth.x.y`; any other `wesnoth.x.y` is a field of a function's result. */
const LUA_NAMESPACES = new Set(['units', 'sides', 'map', 'game_events', 'interface', 'sync', 'audio', 'schedule', 'current', 'game_config', 'achievements', 'paths', 'terrain_types', 'unit_types', 'races', 'persistent_tags', 'experimental', 'wml_actions', 'wml_conditionals', 'variables']);
function luaApiNames(source) {
  const out = new Set();
  for (const m of source.matchAll(LUA_API)) {
    const [, root, a, b] = m;
    if (root === 'wesnoth' && a === 'wml_actions') {
      out.add('wesnoth.wml_actions');
      continue;
    }
    out.add(b && (root !== 'wesnoth' || LUA_NAMESPACES.has(a)) ? `${root}.${a}.${b}` : `${root}.${a}`);
  }
  // Wesnoth's string extensions called as methods (`s:vformat{...}`, `s:split()`): `stringx`, which upstream
  // also puts on strings' (and translatable strings') metatables.
  for (const m of source.matchAll(/:(vformat|split|trim|join|parse_range|map_split|iter_range|iter_ranges|format_conjunct_list|format_disjunct_list|escaped_split|quoted_split|anim_split)\s*[({"']/g)) out.add(`stringx.${m[1]} (as a method)`);
  return out;
}
const LUA_KEYWORDS_OK = new Set(['wml.variables']);
function isBridged(name) {
  if (bridged.has(name) || LUA_KEYWORDS_OK.has(name)) return true;
  // wesnoth.units.find_on_map is bridged; wml.variables["x"] etc.
  return [...bridged].some((b) => name === b || name.startsWith(`${b}.`));
}

/** Every `{tag, config}` in a snapshot's scenario tree. */
function* walkConfig(json, where = []) {
  for (const child of json.children ?? []) {
    yield { tag: child.tag, config: child.config, where };
    yield* walkConfig(child.config, [...where, child.tag]);
  }
}
const str = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

const SUPPORTED_WIDGETS = new Set(['grid', 'row', 'column', 'label', 'scroll_label', 'image', 'button', 'spacer', 'listbox', 'horizontal_listbox', 'toggle_panel', 'panel', 'list_definition', 'list_data', 'widget', 'resolution', 'helptip', 'tooltip']);
const GUI_WIDGET_TAGS = /^\s*\[(\w+)\]/gm;

const perCampaign = {};
for (const campaign of campaigns) {
  const dir = path.join(campaignsRoot, campaign);
  const luaFiles = walkFiles(dir, (n) => n.endsWith('.lua'));
  const cfgFiles = walkFiles(dir, (n) => n.endsWith('.cfg'));
  const snapshots = walkFiles(path.join(scenariosOut, campaign), (n) => n.endsWith('.json')).map((f) => ({ id: path.basename(f, '.json'), json: JSON.parse(fs.readFileSync(f, 'utf8')) }));
  const c = {
    scenarios: jobs.filter((j) => j.campaign === campaign).length,
    built: builds.filter((b) => b.campaign === campaign && b.ok).length,
    buildFailures: builds.filter((b) => b.campaign === campaign && !b.ok).map((b) => ({ file: rel(b.file), error: b.error })),
    buildWarnings: [...new Set(builds.filter((b) => b.campaign === campaign).flatMap((b) => b.warnings))],
    luaFiles: luaFiles.map(rel),
    luaLines: luaFiles.reduce((n, f) => n + fs.readFileSync(f, 'utf8').split('\n').length, 0),
    luaApi: {},
    requires: {},
    microAi: {},
    customAi: [],
    dialogs: { showDialogCalls: 0, widgets: {}, files: [] },
    achievements: 0,
    helpTopics: new Set(),
    terrainGraphics: 0,
    terrainTypes: 0,
    unitTypes: 0,
  };
  // Lua: the campaign's files, and inline [lua] code in the built scenarios.
  const luaSources = luaFiles.map((f) => ({ where: rel(f), source: fs.readFileSync(f, 'utf8') }));
  for (const { id, json } of snapshots) {
    for (const { tag, config } of walkConfig(json.scenarioConfigJson)) {
      if (tag === 'lua' && typeof config.attrs.code === 'string') luaSources.push({ where: `${id} [lua]`, source: config.attrs.code });
      if (tag === 'micro_ai') {
        const type = str(config.attrs.ai_type) || '?';
        (c.microAi[type] ??= new Set()).add(id);
      }
      if (tag === 'open_help') c.helpTopics.add(str(config.attrs.topic));
      if ((tag === 'ai' || tag === 'candidate_action' || tag === 'stage' || tag === 'engine') && (str(config.attrs.engine) === 'lua' || typeof config.attrs.code === 'string' || typeof config.attrs.evaluation === 'string' && /\(/.test(str(config.attrs.evaluation)))) {
        c.customAi.push(`${id}: [${tag}]${config.attrs.name ? ` name=${str(config.attrs.name)}` : ''}${config.attrs.location ? ` location=${str(config.attrs.location)}` : ''}`);
      }
    }
  }
  c.customAi = [...new Set(c.customAi)];
  for (const { where, source } of luaSources) {
    for (const name of luaApiNames(source)) (c.luaApi[name] ??= new Set()).add(where);
    for (const m of source.matchAll(/(?:wesnoth\.require|require)\s*\(?\s*["']([^"']+)["']/g)) {
      if (!m[1].startsWith('campaigns/')) (c.requires[m[1]] ??= new Set()).add(where);
    }
    const calls = (source.match(/gui\.show_dialog/g) ?? []).length;
    c.dialogs.showDialogCalls += calls;
    for (const m of source.matchAll(/\bT\.(\w+)/g)) if (calls > 0 && !SUPPORTED_WIDGETS.has(m[1])) c.dialogs.widgets[m[1]] = (c.dialogs.widgets[m[1]] ?? 0) + 1;
    for (const m of source.matchAll(/wml\.load\s*\(?\s*["']([^"']+)["']/g)) c.dialogs.files.push(m[1]);
  }
  for (const file of c.dialogs.files) {
    const p = path.join(dataRoot, file.replace(/^~?\/?/, ''));
    if (!fs.existsSync(p)) continue;
    for (const m of fs.readFileSync(p, 'utf8').matchAll(GUI_WIDGET_TAGS)) if (!SUPPORTED_WIDGETS.has(m[1])) c.dialogs.widgets[m[1]] = (c.dialogs.widgets[m[1]] ?? 0) + 1;
  }
  for (const f of cfgFiles) {
    const text = fs.readFileSync(f, 'utf8');
    c.achievements += (text.match(/^\s*\[achievement\]/gm) ?? []).length;
    c.terrainGraphics += (text.match(/^\s*\[terrain_graphics\]/gm) ?? []).length;
    c.terrainTypes += (text.match(/^\s*\[terrain_type\]/gm) ?? []).length;
    c.unitTypes += (text.match(/^\s*\[unit_type\]/gm) ?? []).length;
  }
  perCampaign[campaign] = c;
}

// Audit results by campaign.
const auditByCampaign = {};
for (const [tag, info] of Object.entries(audit.actions)) {
  for (const s of info.scenarios) {
    const ac = (auditByCampaign[campaignOf(s)] ??= { missing: {}, campaignLua: {}, extension: {}, noop: {}, conditions: {} });
    const bucket = info.status === 'MISSING' ? ac.missing : info.status === 'campaign Lua' ? ac.campaignLua : info.status === 'extension point' ? ac.extension : info.status === 'presentation no-op' ? ac.noop : null;
    if (bucket) bucket[tag] = (bucket[tag] ?? 0) + 1;
  }
}
for (const [tag, info] of Object.entries(audit.conditions)) {
  if (info.evaluated) continue;
  for (const s of info.scenarios) {
    const ac = (auditByCampaign[campaignOf(s)] ??= { missing: {}, campaignLua: {}, extension: {}, noop: {}, conditions: {} });
    ac.conditions[tag] = (ac.conditions[tag] ?? 0) + 1;
  }
}

// ── 4. Report ──────────────────────────────────────────────────────────────
const setSize = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v instanceof Set ? [...v].sort() : v]));
const data = {
  generated: new Date().toISOString().slice(0, 10),
  bridgedLuaApi: [...bridged].sort(),
  campaigns: Object.fromEntries(
    campaigns.map((name) => {
      const c = perCampaign[name];
      const unbridged = Object.fromEntries(Object.entries(c.luaApi).filter(([n]) => !isBridged(n) && !n.endsWith('.lua')).map(([n, where]) => [n, [...where].sort()]));
      return [
        name,
        {
          ...c,
          luaApi: undefined,
          luaApiUnbridged: unbridged,
          luaApiBridgedUsed: Object.keys(c.luaApi).filter(isBridged).sort(),
          requires: setSize(c.requires),
          microAi: setSize(c.microAi),
          helpTopics: [...c.helpTopics].sort(),
          audit: auditByCampaign[name] ?? { missing: {}, campaignLua: {}, extension: {}, noop: {}, conditions: {} },
        },
      ];
    }),
  ),
};
fs.writeFileSync(path.join(repoRoot, 'docs/campaign-inventory.json'), JSON.stringify(data, null, 1) + '\n');

// Aggregations across campaigns.
const tally = (pick) => {
  const out = new Map();
  for (const [name, c] of Object.entries(data.campaigns)) {
    for (const [key, n] of Object.entries(pick(c))) {
      const t = out.get(key) ?? { campaigns: [], count: 0 };
      t.campaigns.push(name);
      t.count += typeof n === 'number' ? n : Array.isArray(n) ? n.length : 1;
      out.set(key, t);
    }
  }
  return [...out].sort((a, b) => b[1].campaigns.length - a[1].campaigns.length || b[1].count - a[1].count || a[0].localeCompare(b[0]));
};
const short = (list) => (list.length > 6 ? `${list.slice(0, 6).join(', ')}, +${list.length - 6}` : list.join(', '));
const L = [];
const table = (head, rows) => {
  L.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`), '');
};
L.push('# Campaign inventory: what the unported campaigns need', '');
L.push(`Generated ${data.generated} by \`apps/web/scripts/survey-campaigns.mjs\` (data: \`docs/campaign-inventory.json\`). Every scenario of each`);
L.push('campaign not yet in `campaigns.json` was built at NORMAL difficulty and audited statically (every branch of every');
L.push('event, the `[campaign]` block\'s events and resources merged in), and the campaigns\' own Lua and WML scanned. It lists');
L.push('what the port lacks; what it already supports is left out. Re-run after a subsystem lands to see what is left.');
L.push('');
L.push('## Summary', '');
table(
  ['Campaign', 'Scenarios (built)', 'Missing tags', 'Campaign Lua tags', 'Lua (files / lines)', 'Unbridged Lua API', 'Core Lua modules', 'Micro AIs', 'Custom Lua AI', 'Dialogs', 'Achievements', 'Help topics', 'Own terrain rules / types'],
  Object.entries(data.campaigns).map(([name, c]) => [
    name,
    `${c.scenarios} (${c.built})`,
    Object.keys(c.audit.missing).length,
    Object.keys(c.audit.campaignLua).length,
    `${c.luaFiles.length} / ${c.luaLines}`,
    Object.keys(c.luaApiUnbridged).length,
    Object.keys(c.requires).length,
    Object.keys(c.microAi).join(', ') || '—',
    c.customAi.length,
    c.dialogs.showDialogCalls,
    c.achievements,
    c.helpTopics.length,
    `${c.terrainGraphics} / ${c.terrainTypes}`,
  ]),
);

L.push('## WML action tags the port does not have', '');
table(['Tag', 'Campaigns', 'Uses', 'Which'], tally((c) => c.audit.missing).map(([tag, t]) => [`\`[${tag}]\``, t.campaigns.length, t.count, short(t.campaigns)]));
const extension = tally((c) => c.audit.extension);
if (extension.length) {
  L.push('## Tags registered only as extension points', '');
  table(['Tag', 'Campaigns', 'Uses', 'Which'], extension.map(([tag, t]) => [`\`[${tag}]\``, t.campaigns.length, t.count, short(t.campaigns)]));
}
L.push('## Presentation tags that do nothing here', '');
table(['Tag', 'Campaigns', 'Uses', 'Which'], tally((c) => c.audit.noop).map(([tag, t]) => [`\`[${tag}]\``, t.campaigns.length, t.count, short(t.campaigns)]));
const conds = tally((c) => c.audit.conditions);
L.push('## Conditions not evaluated', '');
L.push(conds.length ? '' : 'None.');
if (conds.length) table(['Condition', 'Campaigns', 'Uses', 'Which'], conds.map(([tag, t]) => [`\`[${tag}]\``, t.campaigns.length, t.count, short(t.campaigns)]));
L.push('');
L.push('## WML tags defined in campaign Lua', '');
L.push('These run through the Lua runtime (Phase 28c); what they need is in the Lua API sections below.', '');
table(['Tag', 'Campaign', 'Uses'], Object.entries(data.campaigns).flatMap(([name, c]) => Object.entries(c.audit.campaignLua).map(([tag, n]) => [`\`[${tag}]\``, name, n])));
L.push('## Lua API the bridge does not provide yet', '');
L.push('Names as the campaigns call them (`wesnoth.x.y`; a field read on a function\'s result may show as a name).', '');
table(['Lua API', 'Campaigns', 'Places', 'Which'], tally((c) => c.luaApiUnbridged).map(([n, t]) => [`\`${n}\``, t.campaigns.length, t.count, short(t.campaigns)]));
L.push('## Core Lua modules the campaigns load', '');
L.push('`wesnoth.require` of mainline Lua (`data/lua/...`); the runtime carries only a campaign\'s own files today.', '');
table(['Module', 'Campaigns', 'Places', 'Which'], tally((c) => c.requires).map(([n, t]) => [`\`${n}\``, t.campaigns.length, t.count, short(t.campaigns)]));
L.push('## Micro AIs (`[micro_ai] ai_type=`)', '');
table(['ai_type', 'Campaigns', 'Scenarios', 'Which'], tally((c) => c.microAi).map(([n, t]) => [`\`${n}\``, t.campaigns.length, t.count, short(t.campaigns)]));
L.push('The South Guard (ported) also uses `zone_guardian` (2 scenarios) and `coward` (1).', '');
L.push('## Custom Lua AI', '');
L.push('`[ai]`/`[candidate_action]`/`[stage]`/`[engine]` with `engine=lua` or Lua code, per scenario.', '');
for (const [name, c] of Object.entries(data.campaigns)) if (c.customAi.length) L.push(`- **${name}** (${c.customAi.length}): ${short(c.customAi)}`);
L.push('');
L.push('## Custom dialogs (`gui.show_dialog`)', '');
table(
  ['Campaign', 'Calls', 'Widgets the renderer lacks'],
  Object.entries(data.campaigns)
    .filter(([, c]) => c.dialogs.showDialogCalls > 0)
    .map(([name, c]) => [name, c.dialogs.showDialogCalls, Object.entries(c.dialogs.widgets).map(([w, n]) => `\`${w}\` (${n})`).join(', ') || '—']),
);
L.push('## Achievements', '');
table(['Campaign', 'Achievements declared', '`[set_achievement]` / progress uses'], Object.entries(data.campaigns).filter(([, c]) => c.achievements > 0).map(([name, c]) => [name, c.achievements, (c.audit.missing.set_achievement ?? 0) + (c.audit.missing.progress_achievement ?? 0) || '(supported)']));
L.push('Every campaign\'s `[set_achievement]` is supported since Phase 28c (recorded, not shown).', '');
L.push('## Help topics opened (`[open_help]`)', '');
const topics = Object.entries(data.campaigns).filter(([, c]) => c.helpTopics.length);
L.push(topics.length ? '' : 'None outside The South Guard (which opens three unit pages).');
for (const [name, c] of topics) L.push(`- **${name}**: ${c.helpTopics.map((t) => `\`${t}\``).join(', ')}`);
L.push('');
L.push('## Campaign terrain', '');
L.push('This port\'s terrain graphics rules are core\'s only (`terrain-graphics-rules.json`); a campaign\'s own `[terrain_graphics]` or `[terrain_type]` would not be drawn or known.', '');
table(['Campaign', '`[terrain_graphics]`', '`[terrain_type]`'], Object.entries(data.campaigns).filter(([, c]) => c.terrainGraphics + c.terrainTypes > 0).map(([name, c]) => [name, c.terrainGraphics, c.terrainTypes]));
L.push('## Preprocessor gaps the survey found (fixed)', '');
L.push('Building every campaign exposed places where the port\'s preprocessor differed from upstream\'s; each is fixed and');
L.push('the shipped campaigns\' snapshots rebuilt unchanged:', '');
L.push('- **Macro state across files.** Upstream preprocesses a whole campaign in one pass, so a scenario sees the macros as');
L.push('  they stand when its file is reached; the builder used the state after the last file. Heir to the Throne\'s last');
L.push('  scenario `#undef`s `HTTT_BIGMAP`, and Secrets of the Ancients swaps its `JOURNEY_STAGE*` per chapter. The builder now');
L.push('  copies the macro table as the campaign\'s preload reaches the scenario\'s file.');
L.push('- **`#` inside macro arguments** goes through the same directive/comment handling as elsewhere (Eastern Invasion, The');
L.push('  Deceiver\'s Gambit).');
L.push('- **`#enddefs`**, a typo in `data/campaigns/*/utils/side_ai.cfg` of Of Pearls and Pirates and The Hammer of Thursagan:');
L.push('  upstream\'s define scanner matches `#enddef` as a prefix, so it ends the definition; so does the port now (the stray');
L.push('  `s` is dropped rather than emitted).');
L.push('- **Theme macros** (`data/themes/`, e.g. `CUTSCENE_THEME_BACKGROUND`) are loaded with core\'s, as upstream\'s game');
L.push('  config includes them.');
L.push('');
L.push('## Builds', '');
const failures = Object.entries(data.campaigns).flatMap(([name, c]) => c.buildFailures.map((f) => [name, `\`${f.file}\``, f.error ?? '']));
L.push(failures.length ? '' : 'Every scenario built.');
if (failures.length) table(['Campaign', 'Scenario', 'Error'], failures.map((r) => r.map((x) => String(x).replace(/\|/g, '\\|'))));
if (failures.some(([name]) => name === 'World_Conquest')) {
  L.push('World Conquest is a random-map multiplayer campaign: its one scenario file builds each map with Lua at game start');
  L.push('(`wesnoth.map.generate`, its own era and invest dialogs), which the snapshot builder cannot model, so it was surveyed');
  L.push('from its WML and Lua alone. It is a separate project from the story campaigns.', '');
}
const warned = Object.entries(data.campaigns).filter(([, c]) => c.buildWarnings.length);
if (warned.length) {
  L.push('Build warnings:', '');
  for (const [name, c] of warned) L.push(`- **${name}**: ${c.buildWarnings.slice(0, 8).map((w) => w.replace(/\|/g, '\\|')).join('; ')}`);
  L.push('');
}
fs.writeFileSync(path.join(repoRoot, 'docs/CAMPAIGN_INVENTORY.md'), L.join('\n'));
console.log(`\nwrote docs/CAMPAIGN_INVENTORY.md and docs/campaign-inventory.json (${campaigns.length} campaigns, ${jobs.length} scenarios, ${builds.filter((b) => !b.ok).length} failed builds)`);
