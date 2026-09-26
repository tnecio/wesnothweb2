/**
 * TS port of `data/lua/wml/objectives.lua`'s `generate_objectives`/
 * `wml_actions.objectives`: turns a real `[objectives]` WML block into a
 * structured, renderable model (this project builds a plain data
 * structure for a Svelte dialog to render with real HTML/CSS instead of
 * upstream's Pango-markup string -- see `ScenarioObjectives`' own doc
 * comment).
 *
 * Deliberately not ported: per-`[objective]`/`[gold_carryover]`/`[note]`
 * `red=`/`green=`/`blue=`/`bullet=` overrides (real content overwhelmingly
 * uses the real defaults -- green win / red lose / pale-yellow gold /
 * white notes -- ported as constants below) and `caption=`. Per-entry
 * `[show_if]` is evaluated when the objectives are generated (Phase 18d),
 * through the `passes` callback `parseScenarioObjectives` is given; the
 * `[objectives]`/`[show_objectives]` actions (`actionWml.ts`) keep the raw
 * configs per side, as upstream's `scenario_objectives` table does.
 */

import type { WmlConfig } from '../wml/config.js';

export type ObjectiveCondition = 'win' | 'lose';

export interface ScenarioObjectiveEntry {
  readonly description: string;
  readonly condition: ObjectiveCondition;
  /** Real `show_turn_counter=` -- append "(N turns left)"/"(this turn left)" at render time, computed from the CURRENT turn/turn-limit, not baked in here (matches upstream reading `wesnoth.current.turn`/`wesnoth.scenario.turns` at generate_objectives() time, i.e. every time the dialog is actually shown). */
  readonly showTurnCounter: boolean;
}

/** One `[gold_carryover]` child -- `bonus=`/`carryoverPercentage=` are each independently optional (real content sets either, both, or neither), matching upstream's own `obj.bonus ~= nil`/`obj.carryover_percentage` independent checks. */
export interface GoldCarryoverEntry {
  readonly bonus?: boolean;
  readonly carryoverPercentage?: number;
}

/**
 * A real `[objectives]` block's structured content -- see this module's
 * own doc comment for what's deliberately not ported. `victoryLabel`/
 * `defeatLabel`/`goldCarryoverLabel`/`notesLabel` default to upstream's
 * own real default strings ("Victory:"/"Defeat:"/"Gold carryover:"/
 * "Notes:") when the WML doesn't override them via `victory_string=`/
 * etc.
 */
export interface ScenarioObjectives {
  readonly summary: string;
  readonly victoryLabel: string;
  readonly defeatLabel: string;
  readonly goldCarryoverLabel: string;
  readonly notesLabel: string;
  readonly objectives: readonly ScenarioObjectiveEntry[];
  readonly goldCarryover: readonly GoldCarryoverEntry[];
  readonly notes: readonly string[];
  /** Real `silent=` -- when true, this firing updates the side's objectives WITHOUT popping the dialog (matches `team.objectives_changed = not silent`). */
  readonly silent: boolean;
}

/** Real default bullet colors (`generate_objectives`'s own `obj.red or 0` etc. defaults) -- as CSS hex, not raw RGB components, since this project renders real HTML instead of Pango markup. */
export const OBJECTIVE_COLOR = {
  win: '#00ff00',
  lose: '#ff0000',
  goldCarryover: '#ffffc0',
  note: '#ffffff',
} as const;

/** A `[show_if]` test (`wml.eval_conditional`); entries without one always show. */
export type ShowIf = (showIf: WmlConfig) => boolean;

const shown = (entries: WmlConfig[], passes?: ShowIf) =>
  entries.filter((e) => {
    const showIf = e.child('show_if');
    return !showIf || !passes || passes(showIf);
  });

/** Mirrors `generate_objectives`'s per-`[objective]` loop (win/lose branches only -- per-entry color overrides not ported, see module doc comment). */
function parseObjectiveEntries(cfg: WmlConfig, passes?: ShowIf): ScenarioObjectiveEntry[] {
  const entries: ScenarioObjectiveEntry[] = [];
  for (const obj of shown(cfg.children('objective'), passes)) {
    const condition = obj.getString('condition', '');
    if (condition !== 'win' && condition !== 'lose') continue; // real Wesnoth wml.error()s; headless, just skip.
    entries.push({
      description: obj.getString('description', ''),
      condition,
      showTurnCounter: obj.getBoolean('show_turn_counter', false),
    });
  }
  return entries;
}

/** Mirrors `generate_objectives`'s per-`[gold_carryover]` loop. */
function parseGoldCarryoverEntries(cfg: WmlConfig, passes?: ShowIf): GoldCarryoverEntry[] {
  const entries: GoldCarryoverEntry[] = [];
  for (const obj of shown(cfg.children('gold_carryover'), passes)) {
    const entry: { bonus?: boolean; carryoverPercentage?: number } = {};
    if (obj.hasAttribute('bonus')) entry.bonus = obj.getBoolean('bonus', false);
    if (obj.hasAttribute('carryover_percentage')) entry.carryoverPercentage = obj.getNumber('carryover_percentage');
    if (entry.bonus !== undefined || entry.carryoverPercentage !== undefined) entries.push(entry);
  }
  return entries;
}

/** Mirrors `generate_objectives`'s per-`[note]` loop. */
function parseNoteEntries(cfg: WmlConfig, passes?: ShowIf): string[] {
  return shown(cfg.children('note'), passes)
    .map((n) => n.getString('description', ''))
    .filter((d) => d.length > 0);
}

/** Parses a real `[objectives]` tag's config into a `ScenarioObjectives` model -- see this module's own doc comment for scope. */
export function parseScenarioObjectives(cfg: WmlConfig, passes?: ShowIf): ScenarioObjectives {
  return {
    summary: cfg.getString('summary', ''),
    victoryLabel: cfg.getString('victory_string', 'Victory:'),
    defeatLabel: cfg.getString('defeat_string', 'Defeat:'),
    goldCarryoverLabel: cfg.getString('gold_carryover_string', 'Gold carryover:'),
    notesLabel: cfg.getString('notes_string', 'Notes:'),
    objectives: parseObjectiveEntries(cfg, passes),
    goldCarryover: parseGoldCarryoverEntries(cfg, passes),
    notes: parseNoteEntries(cfg, passes),
    silent: cfg.getBoolean('silent', false),
  };
}

/**
 * Renders a real `show_turn_counter=` suffix, mirroring
 * `generate_objectives`'s own turn-counter text exactly (including the
 * singular/plural split): `turnLimit >= currentTurn` is required (matches
 * upstream's own guard -- an already-expired/unlimited (-1) turn count
 * shows nothing), and the remaining count is `turnLimit - currentTurn + 1`
 * (the current turn itself still counts as one remaining).
 */
export function turnCounterSuffix(currentTurn: number, turnLimit: number): string {
  if (turnLimit < currentTurn) return '';
  const remaining = turnLimit - currentTurn + 1;
  return remaining === 1 ? ' (this turn left)' : ` (${remaining} turns left)`;
}
