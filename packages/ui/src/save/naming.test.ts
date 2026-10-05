import { describe, expect, it } from 'vitest';
import type { SaveMeta } from '../persistence.js';
import {
  AUTOSAVE_MARKER,
  DEFAULT_AUTO_SAVE_MAX,
  INFINITE_AUTO_SAVES,
  autosaveName,
  autosavesToDelete,
  downloadFileName,
  manualSaveName,
  scenarioLabel,
  scenarioStartSaveName,
  replaySaveName,
  scenarioAutosaves,
  uniqueName,
} from './naming.js';

describe('save naming (savegame.cpp)', () => {
  it('builds the same label real Wesnoth does: <abbrev>-<scenario name>', () => {
    // The committed fixture -- a real 1.16.9 autosave -- is labelled exactly this.
    expect(scenarioLabel('DW', 'Invasion!')).toBe('DW-Invasion!');
  });

  it('strips the characters upstream refuses in a filename, and turns underscores into spaces', () => {
    expect(scenarioLabel('DW', 'a/b\\c:d')).toBe('DW-abcd');
    expect(scenarioLabel('UtBS', 'The_Morning_After')).toBe('UtBS-The Morning After');
    expect(scenarioLabel('DW', 'tab\there')).toBe('DW-tabhere');
  });

  it('names each save flavour as upstream does', () => {
    const label = scenarioLabel('DW', 'Invasion!');
    // No space before the number for an autosave; a spaced " Turn N" for a manual one.
    expect(autosaveName(label, 3)).toBe('DW-Invasion!-Auto-Save3');
    expect(manualSaveName(label, 3)).toBe('DW-Invasion! Turn 3');
    expect(scenarioStartSaveName(label)).toBe('DW-Invasion!');
  });

  it('falls back to a bare Auto-Save when there is no label', () => {
    expect(autosaveName('', 4)).toBe(AUTOSAVE_MARKER);
  });

  it('appends .gz for download without doubling an extension that is already there', () => {
    expect(downloadFileName('DW-Invasion! Turn 3')).toBe('DW-Invasion! Turn 3.gz');
    expect(downloadFileName('already.gz')).toBe('already.gz');
  });

  it('makes an imported name unique instead of overwriting an existing save', () => {
    expect(uniqueName('DW-Invasion!', [])).toBe('DW-Invasion!');
    expect(uniqueName('DW-Invasion!', ['DW-Invasion!'])).toBe('DW-Invasion! (2)');
    expect(uniqueName('DW-Invasion!', ['DW-Invasion!', 'DW-Invasion! (2)'])).toBe('DW-Invasion! (3)');
  });
});

describe('autosave rotation (save_index.cpp delete_old_auto_saves)', () => {
  const meta = (name: string, savedAt: number, kind: SaveMeta['kind']): SaveMeta => ({
    name,
    scenarioId: '01_Invasion',
    savedAt,
    kind,
  });

  const saves: SaveMeta[] = [
    meta('DW-Invasion!-Auto-Save1', 1000, 'autosave'),
    meta('DW-Invasion!-Auto-Save2', 2000, 'autosave'),
    meta('DW-Invasion!-Auto-Save3', 3000, 'autosave'),
    meta('DW-Invasion! Turn 2', 2500, 'manual'),
    meta('DW-Invasion!', 500, 'scenario-start'),
  ];

  it('keeps the newest N autosaves and deletes the rest', () => {
    expect(autosavesToDelete(saves, 2)).toEqual(['DW-Invasion!-Auto-Save1']);
    expect(autosavesToDelete(saves, 1)).toEqual(['DW-Invasion!-Auto-Save2', 'DW-Invasion!-Auto-Save1']);
  });

  it('never touches manual or start-of-scenario saves, however many autosaves there are', () => {
    const doomed = autosavesToDelete(saves, 1);
    expect(doomed).not.toContain('DW-Invasion! Turn 2');
    expect(doomed).not.toContain('DW-Invasion!');
  });

  it('deletes nothing when under the cap, at the default cap, or when set to keep everything', () => {
    expect(autosavesToDelete(saves, 3)).toEqual([]);
    expect(autosavesToDelete(saves, DEFAULT_AUTO_SAVE_MAX)).toEqual([]);
    expect(autosavesToDelete(saves, INFINITE_AUTO_SAVES)).toEqual([]);
  });

  it('deletes nothing when autosaving is off -- there is nothing being written to rotate', () => {
    expect(autosavesToDelete(saves, 0)).toEqual([]);
  });
});

describe('Phase 24: end-of-scenario saves', () => {
  it('names a replay save as replay_savegame::create_initial_filename', () => {
    expect(replaySaveName('DW-Invasion', new Date(2026, 9, 5, 9, 3, 7))).toBe('DW-Invasion replay 20261005-090307');
  });

  it('clean_saves(label): every save named <label>-Auto-Save..., nothing else', () => {
    const at = (name: string): SaveMeta => ({ name, scenarioId: 's', savedAt: 0 });
    const saves = [at('DW-Invasion-Auto-Save1'), at('DW-Invasion-Auto-Save12'), at('DW-Invasion Turn 3'), at('DW-Flight-Auto-Save2')];
    expect(scenarioAutosaves(saves, 'DW-Invasion')).toEqual(['DW-Invasion-Auto-Save1', 'DW-Invasion-Auto-Save12']);
  });
});
