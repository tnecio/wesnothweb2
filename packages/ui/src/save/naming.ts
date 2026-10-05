/**
 * How saves are named and how autosaves are rotated -- ported from
 * `savegame.cpp`/`save_index.cpp` so a file downloaded from here lands in
 * a Wesnoth player's saves folder looking like one of their own.
 *
 * Deliberately pure functions with no storage or DOM dependency: this is
 * the part of the save manager that can be unit-tested under this
 * project's node-only vitest setup, with the IndexedDB and file-picker
 * edges left to the browser script (see `persistence.ts`).
 */

import type { SaveMeta } from '../persistence.js';

/** Mirrors `saved_game.cpp`'s `is_illegal_file_char`: what upstream strips out of a save's label. */
function isIllegalFileChar(ch: string): boolean {
  return ch === '/' || ch === '\\' || ch === ':' || ch < ' ';
}

/**
 * A scenario's save label, mirroring `saved_game::update_label`
 * (`saved_game.cpp:724`): `<campaign abbrev>-<scenario name>`, with
 * illegal characters removed and underscores turned into spaces. This is
 * the `label=` a real save carries and the stem of every filename below.
 */
export function scenarioLabel(abbrev: string, scenarioName: string): string {
  const raw = abbrev ? `${abbrev}-${scenarioName}` : scenarioName;
  let out = '';
  for (const ch of raw) {
    if (isIllegalFileChar(ch)) continue;
    out += ch === '_' ? ' ' : ch;
  }
  return out;
}

/** `autosave_savegame::create_initial_filename` (`savegame.cpp:522`): `<label>-Auto-Save<turn>`, or a bare `Auto-Save` when there is no label. */
export function autosaveName(label: string, turn: number): string {
  return label ? `${label}-${AUTOSAVE_MARKER}${turn}` : AUTOSAVE_MARKER;
}

/** `ingame_savegame::create_initial_filename` (`savegame.cpp:562`): `<label> Turn <turn>`. */
export function manualSaveName(label: string, turn: number): string {
  return `${label} Turn ${turn}`;
}

/** `scenariostart_savegame::create_initial_filename` (`savegame.cpp:470`): the label alone. */
export function scenarioStartSaveName(label: string): string {
  return label;
}

/**
 * Phase 24: `replay_savegame::create_initial_filename` (`savegame.cpp:486`): `<label> replay
 * <YYYYMMDD-HHMMSS>`, local time.
 */
export function replaySaveName(label: string, at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `${label} replay ${stamp}`;
}

/**
 * Phase 24: `savegame::clean_saves(label)` (`savegame.cpp:64`), for "Delete auto-saves at the end of
 * scenarios": every save whose name starts with `<label>-Auto-Save`.
 */
export function scenarioAutosaves(saves: readonly SaveMeta[], label: string): string[] {
  const prefix = `${label}-${AUTOSAVE_MARKER}`;
  return saves.filter((s) => s.name.startsWith(prefix)).map((s) => s.name);
}

/**
 * The substring upstream matches autosaves by -- `get_saves_list(&filter)`
 * does a plain `name.find(filter)`, not a prefix test, which is why an
 * autosave of any campaign is caught by the same rotation.
 */
export const AUTOSAVE_MARKER = 'Auto-Save';

/** Upstream's `pref_constants::INFINITE_AUTO_SAVES`: keep every autosave. */
export const INFINITE_AUTO_SAVES = 61;

/** Upstream's default `auto_save_max`. */
export const DEFAULT_AUTO_SAVE_MAX = 10;

/**
 * Which autosaves to delete, mirroring `save_index_class::
 * delete_old_auto_saves` (`save_index.cpp:335`): keep the newest `max`
 * and delete the rest. `max` of `INFINITE_AUTO_SAVES` keeps everything;
 * `0` means autosaving is off entirely, so nothing is written to rotate.
 *
 * Note this is global, not per-campaign -- upstream filters on the
 * `Auto-Save` substring alone, so a long session in one campaign does
 * prune another's autosaves. Kept faithful rather than "improved": a
 * player who knows Wesnoth's behaviour should not be surprised here.
 */
export function autosavesToDelete(saves: readonly SaveMeta[], max: number): string[] {
  if (max === INFINITE_AUTO_SAVES || max <= 0) return [];
  return saves
    .filter((s) => s.kind === 'autosave')
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(max)
    .map((s) => s.name);
}

/**
 * The filename a save downloads as. Real saves are `<name>.gz`, and
 * upstream's own `check_filename` rejects a *user-typed* name that
 * already ends in `.gz`, so the extension is added here and never
 * duplicated.
 */
export function downloadFileName(name: string): string {
  return name.toLowerCase().endsWith('.gz') ? name : `${name}.gz`;
}

/**
 * A name that does not collide with an existing save, by appending
 * ` (2)`, ` (3)`, ... -- for importing a file whose save is already
 * present, where silently overwriting would lose a game.
 */
export function uniqueName(name: string, taken: readonly string[]): string {
  if (!taken.includes(name)) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name} (${i})`;
    if (!taken.includes(candidate)) return candidate;
  }
}
