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

import { formatMessage } from '../i18n/format.js';
import { dsngettext } from '../i18n/gettext.js';
import { TString } from '../i18n/tstring.js';
import type { WmlConfig } from '../wml/config.js';

export type ObjectiveCondition = 'win' | 'lose';

export interface ScenarioObjectiveEntry {
  /** The text in the current language (read when needed, so it follows a switch). */
  readonly description: string;
  readonly descriptionT: TString;
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
  /** Every text below has a plain form (the language now) and a `...T` form a display can hold across a language switch. */
  readonly summary: string;
  readonly summaryT: TString;
  readonly victoryLabel: string;
  readonly victoryLabelT: TString;
  readonly defeatLabel: string;
  readonly defeatLabelT: TString;
  readonly goldCarryoverLabel: string;
  readonly goldCarryoverLabelT: TString;
  readonly notesLabel: string;
  readonly notesLabelT: TString;
  readonly objectives: readonly ScenarioObjectiveEntry[];
  readonly goldCarryover: readonly GoldCarryoverEntry[];
  readonly notes: readonly string[];
  readonly notesT: readonly TString[];
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

/**
 * Adds the `...T` (translatable) twins to a model object as non-enumerable properties: they are for a display to read, and
 * keep the plain fields the object is compared and serialised by exactly as they were.
 */
function withTranslatable<P extends object, T extends object>(plain: P, twins: T): P & T {
  for (const [key, value] of Object.entries(twins)) Object.defineProperty(plain, key, { value, enumerable: false });
  return plain as P & T;
}

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
    const descriptionT = obj.getTString('description') ?? TString.literal('');
    entries.push(
      withTranslatable(
        {
          get description() {
            return descriptionT.str();
          },
          condition: condition as ObjectiveCondition,
          showTurnCounter: obj.getBoolean('show_turn_counter', false),
        },
        { descriptionT },
      ),
    );
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
function parseNoteEntries(cfg: WmlConfig, passes?: ShowIf): TString[] {
  return shown(cfg.children('note'), passes)
    .map((n) => n.getTString('description') ?? TString.literal(''))
    .filter((d) => !d.isEmpty());
}

/** `victory_string=` etc., or upstream's own default in the `wesnoth` domain (`objectives.lua`'s `_ "Victory:"`). */
function labelT(cfg: WmlConfig, key: string, fallback: string): TString {
  return cfg.getTString(key) ?? TString.translatable('wesnoth', fallback);
}

/** Parses a real `[objectives]` tag's config into a `ScenarioObjectives` model -- see this module's own doc comment for scope. */
export function parseScenarioObjectives(cfg: WmlConfig, passes?: ShowIf): ScenarioObjectives {
  const summaryT = cfg.getTString('summary') ?? TString.literal('');
  const victoryLabelT = labelT(cfg, 'victory_string', 'Victory:');
  const defeatLabelT = labelT(cfg, 'defeat_string', 'Defeat:');
  const goldCarryoverLabelT = labelT(cfg, 'gold_carryover_string', 'Gold carryover:');
  const notesLabelT = labelT(cfg, 'notes_string', 'Notes:');
  const notesT = parseNoteEntries(cfg, passes);
  return withTranslatable(
    {
      get summary() {
        return summaryT.str();
      },
      get victoryLabel() {
        return victoryLabelT.str();
      },
      get defeatLabel() {
        return defeatLabelT.str();
      },
      get goldCarryoverLabel() {
        return goldCarryoverLabelT.str();
      },
      get notesLabel() {
        return notesLabelT.str();
      },
      objectives: parseObjectiveEntries(cfg, passes),
      goldCarryover: parseGoldCarryoverEntries(cfg, passes),
      get notes() {
        return notesT.map((n) => n.str());
      },
      silent: cfg.getBoolean('silent', false),
    },
    { summaryT, victoryLabelT, defeatLabelT, goldCarryoverLabelT, notesLabelT, notesT },
  );
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
  // `_("(this turn left)", "($remaining_turns turns left)", n)`, then `vformat`.
  return ' ' + formatMessage(dsngettext('wesnoth', '(this turn left)', '($remaining_turns turns left)', remaining), { remaining_turns: remaining });
}
