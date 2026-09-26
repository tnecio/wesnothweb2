/**
 * Static audit of the WML the shipped scenarios actually use against what
 * this port implements (Phase 18c planning, 2026-09-26).
 *
 *   npx tsx packages/ui/scripts/audit-wml.ts [--out docs/WML_AUDIT.md]
 *
 * Reads every committed scenario snapshot (`apps/web/public/scenarios/*.json`
 * -- each carries its scenario fully preprocessed, macros expanded, in
 * `scenarioConfigJson`), walks every `[event]` body the way the event pump
 * would -- following the children that are themselves action bodies
 * (`[then]`/`[else]`/`[elseif]`, `[case]`, `[do]`, `[command]`, `[option]`,
 * nested `[event]`s, ...) -- and classifies each action tag against the
 * port's own action registry, and each condition tag against the
 * conditionals it evaluates. Static on purpose: it covers every branch,
 * not just the ones a test run happens to reach.
 *
 * Categories:
 *  - implemented: a real handler is registered.
 *  - presentation no-op: registered as a deliberate no-op (music, sound,
 *    labels, ...) -- the game plays, but nothing is shown/heard.
 *  - extension point: registered, but only logs that it is not implemented.
 *  - MISSING: no handler; the pump logs "[tag] not supported (skipped)".
 *  - campaign Lua: defined by the campaign's own Lua (`wml_actions.X`),
 *    which this port does not run yet -- effectively missing too.
 * Conditions this port does not evaluate are treated as *passing*
 * (`conditionalWml.ts`), which is worse than skipping, so they are listed
 * separately.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WmlConfig, createDefaultActionRegistry, registerAiWmlActions, type WmlConfigJson } from '@wesnothweb2/engine';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const out = outArg >= 0 ? args[outArg + 1] : null;

// ---------------------------------------------------------------------------
// What the port implements
// ---------------------------------------------------------------------------

const registry = createDefaultActionRegistry();
registerAiWmlActions(registry);
const actionSource = fs.readFileSync(path.join(repoRoot, 'packages/engine/src/events/actionWml.ts'), 'utf8');
const noopList = /for \(const tag of \[([^\]]*)\]\) \{\s*registry\.register\(tag, noop\)/.exec(actionSource)?.[1] ?? '';
const NOOP = new Set([...noopList.matchAll(/'([^']+)'/g)].map((m) => m[1]!));
const EXTENSION = new Set([...actionSource.matchAll(/registry\.register\('([^']+)', extensionPoint\(/g)].map((m) => m[1]!));
/** `conditionalWml.ts`'s `builtinConditions`, plus the connectives and literals it handles itself. */
const CONDITIONS_EVALUATED = new Set(['have_unit', 'variable', 'true', 'false', 'and', 'or', 'not']);

// ---------------------------------------------------------------------------
// Which children of an action are themselves action bodies / conditions
// ---------------------------------------------------------------------------

/** Children of an action tag that hold more actions (walked as bodies). */
const BODY_CHILDREN: Record<string, readonly string[]> = {
  if: ['then', 'else'],
  elseif: ['then', 'else'],
  switch: ['case', 'else'],
  while: ['do'],
  for: ['do'],
  foreach: ['do'],
  repeat: ['do'],
  command: [],
  set_menu_item: ['command'],
  option: ['command'],
  object: ['then', 'else'],
  on_undo: [],
  random_placement: ['command'],
  event: [],
};
/** Tags whose own children are an action body directly (`[command]`, a nested `[event]`, `[on_undo]`). */
const SELF_BODY = new Set(['command', 'event', 'on_undo']);
/** Children of these action tags that hold conditions. */
const CONDITION_CHILDREN: Record<string, readonly string[]> = {
  if: [],
  elseif: [],
  while: [],
  show_if: [],
};
/** Tags that are condition containers themselves: every child that is not a branch is a condition. */
const CONDITION_CONTAINERS = new Set(['if', 'elseif', 'while', 'show_if', 'filter_condition', 'and', 'or', 'not']);
const BRANCH_TAGS = new Set(['then', 'else', 'elseif', 'do']);

interface Seen {
  count: number;
  scenarios: Set<string>;
}
const actions = new Map<string, Seen>();
const conditions = new Map<string, Seen>();
const note = (map: Map<string, Seen>, tag: string, scenario: string) => {
  const seen = map.get(tag) ?? { count: 0, scenarios: new Set<string>() };
  seen.count++;
  seen.scenarios.add(scenario);
  map.set(tag, seen);
};

function walkConditions(cfg: WmlConfig, scenario: string): void {
  for (const { tag, config } of cfg.allChildren()) {
    if (BRANCH_TAGS.has(tag)) continue;
    note(conditions, tag, scenario);
    if (tag === 'and' || tag === 'or' || tag === 'not') walkConditions(config, scenario);
  }
}

/** Walks one action body, as `runActionFlow` would (children starting `filter` are the event's own filters, skipped). */
function walkBody(body: WmlConfig, scenario: string): void {
  for (const { tag, config } of body.allChildren()) {
    if (tag.startsWith('filter')) {
      if (tag === 'filter_condition') walkConditions(config, scenario);
      continue;
    }
    note(actions, tag, scenario);
    walkAction(tag, config, scenario);
  }
}

function walkAction(tag: string, cfg: WmlConfig, scenario: string): void {
  if (SELF_BODY.has(tag)) walkBody(cfg, scenario);
  if (CONDITION_CONTAINERS.has(tag) || tag in CONDITION_CHILDREN) walkConditions(cfg, scenario);
  for (const child of BODY_CHILDREN[tag] ?? []) {
    for (const c of cfg.children(child)) walkBody(c, scenario);
  }
  if (tag === 'if') for (const e of cfg.children('elseif')) walkAction('elseif', e, scenario);
  if (tag === 'message') {
    for (const option of cfg.children('option')) {
      for (const showIf of option.children('show_if')) walkConditions(showIf, scenario);
      for (const command of option.children('command')) walkBody(command, scenario);
    }
  }
  if (tag === 'set_menu_item') for (const showIf of cfg.children('show_if')) walkConditions(showIf, scenario);
}

/** Every `[event]` anywhere in the scenario tree (top level, inside `[side]`, ...), except inside unit types. */
function walkScenario(cfg: WmlConfig, scenario: string): void {
  for (const { tag, config } of cfg.allChildren()) {
    if (tag === 'event') walkBody(config, scenario);
    else if (tag !== 'unit_type') walkScenario(config, scenario);
  }
}

// ---------------------------------------------------------------------------
// Campaign Lua: tags the campaigns define for themselves
// ---------------------------------------------------------------------------

const luaTags = new Map<string, string>();
for (const campaign of ['Dead_Water', 'Two_Brothers', 'Liberty', 'Under_the_Burning_Suns']) {
  const dir = path.join(repoRoot, 'wesnoth/data/campaigns', campaign);
  const files: string[] = [];
  const collect = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) collect(p);
      else if (/\.(lua|cfg)$/.test(e.name)) files.push(p);
    }
  };
  collect(dir);
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/wml_actions\s*(?:\.\s*|\[\s*["'])([a-z_]+)/g)) luaTags.set(m[1]!, campaign);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const scenarioDir = path.join(repoRoot, 'apps/web/public/scenarios');
const scenarioFiles = fs.readdirSync(scenarioDir).filter((f) => f.endsWith('.json')).sort();
for (const file of scenarioFiles) {
  const snap = JSON.parse(fs.readFileSync(path.join(scenarioDir, file), 'utf8')) as { scenarioConfigJson: WmlConfigJson };
  walkScenario(WmlConfig.fromJSON(snap.scenarioConfigJson), file.replace(/\.json$/, ''));
}

type Status = 'implemented' | 'presentation no-op' | 'extension point' | 'campaign Lua' | 'MISSING';
function actionStatus(tag: string): Status {
  if (EXTENSION.has(tag)) return 'extension point';
  if (NOOP.has(tag)) return 'presentation no-op';
  // A campaign's Lua may wrap a core tag (Two Brothers redefines [kill]);
  // what matters is whether the port has a handler at all.
  if (registry.has(tag)) return 'implemented';
  if (luaTags.has(tag)) return 'campaign Lua';
  return 'MISSING';
}

const byCount = (a: [string, Seen], b: [string, Seen]) => b[1].scenarios.size - a[1].scenarios.size || b[1].count - a[1].count || a[0].localeCompare(b[0]);
const scenarioList = (s: Seen) => {
  const list = [...s.scenarios].sort();
  return list.length > 4 ? `${list.slice(0, 4).join(', ')}, +${list.length - 4}` : list.join(', ');
};

const lines: string[] = [];
lines.push('# WML audit: what the shipped scenarios use vs. what the port implements');
lines.push('');
lines.push(`Generated by \`packages/ui/scripts/audit-wml.ts\` over ${scenarioFiles.length} scenario snapshots (every branch of every event body, statically).`);
lines.push('');
const order: Status[] = ['MISSING', 'campaign Lua', 'extension point', 'presentation no-op', 'implemented'];
for (const status of order) {
  const rows = [...actions].filter(([tag]) => actionStatus(tag) === status).sort(byCount);
  if (rows.length === 0) continue;
  lines.push(`## Action tags: ${status} (${rows.length})`);
  lines.push('');
  lines.push('| Tag | Uses | Scenarios | Where |');
  lines.push('|---|---:|---:|---|');
  for (const [tag, seen] of rows) lines.push(`| \`[${tag}]\` | ${seen.count} | ${seen.scenarios.size} | ${scenarioList(seen)} |`);
  lines.push('');
}
const condRows = [...conditions].sort(byCount);
lines.push('## Condition tags');
lines.push('');
lines.push('Conditions the port does not evaluate are treated as **passing**, so a missing one silently takes the wrong branch.');
lines.push('');
lines.push('| Tag | Evaluated | Uses | Scenarios | Where |');
lines.push('|---|---|---:|---:|---|');
for (const [tag, seen] of condRows) {
  lines.push(`| \`[${tag}]\` | ${CONDITIONS_EVALUATED.has(tag) ? 'yes' : '**NO**'} | ${seen.count} | ${seen.scenarios.size} | ${scenarioList(seen)} |`);
}
lines.push('');

const text = lines.join('\n');
if (out) fs.writeFileSync(path.join(repoRoot, out), text);
else console.log(text);
const missing = [...actions.keys()].filter((t) => actionStatus(t) === 'MISSING');
console.error(
  `${actions.size} action tags (${missing.length} missing), ${conditions.size} condition tags (${[...conditions.keys()].filter((t) => !CONDITIONS_EVALUATED.has(t)).length} not evaluated)`,
);
