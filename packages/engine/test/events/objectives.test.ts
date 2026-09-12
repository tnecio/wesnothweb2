import { describe, expect, it } from 'vitest';
import { WmlConfig } from '../../src/wml/config.js';
import { parseScenarioObjectives, turnCounterSuffix } from '../../src/events/objectives.js';

/**
 * `parseScenarioObjectives`/`turnCounterSuffix` tests -- each expected
 * value is transcribed directly from `data/lua/wml/objectives.lua`'s real
 * `generate_objectives`, not re-derived from this module's own code.
 */

function addObjective(cfg: WmlConfig, description: string, condition: string, showTurnCounter = false): void {
  const obj = new WmlConfig();
  obj.setAttribute('description', description);
  obj.setAttribute('condition', condition);
  if (showTurnCounter) obj.setAttribute('show_turn_counter', true);
  cfg.addChild('objective', obj);
}

describe('parseScenarioObjectives', () => {
  it('parses win/lose objectives, defaulting labels to the real upstream strings', () => {
    const cfg = new WmlConfig();
    addObjective(cfg, 'Defeat the enemy leader', 'win');
    addObjective(cfg, 'Death of Kai Krellis', 'lose');
    addObjective(cfg, 'Turns run out', 'lose', true);

    const result = parseScenarioObjectives(cfg);
    expect(result.victoryLabel).toBe('Victory:');
    expect(result.defeatLabel).toBe('Defeat:');
    expect(result.goldCarryoverLabel).toBe('Gold carryover:');
    expect(result.notesLabel).toBe('Notes:');
    expect(result.objectives).toEqual([
      { description: 'Defeat the enemy leader', condition: 'win', showTurnCounter: false },
      { description: 'Death of Kai Krellis', condition: 'lose', showTurnCounter: false },
      { description: 'Turns run out', condition: 'lose', showTurnCounter: true },
    ]);
  });

  it('overrides label strings from victory_string=/defeat_string=/gold_carryover_string=/notes_string=', () => {
    const cfg = new WmlConfig();
    cfg.setAttribute('victory_string', 'Win:');
    cfg.setAttribute('defeat_string', 'Lose:');
    cfg.setAttribute('gold_carryover_string', 'Carried gold:');
    cfg.setAttribute('notes_string', 'Hints:');
    const result = parseScenarioObjectives(cfg);
    expect(result.victoryLabel).toBe('Win:');
    expect(result.defeatLabel).toBe('Lose:');
    expect(result.goldCarryoverLabel).toBe('Carried gold:');
    expect(result.notesLabel).toBe('Hints:');
  });

  it('skips an [objective] with a missing/invalid condition= (real Wesnoth wml.error()s; headless, just skip)', () => {
    const cfg = new WmlConfig();
    const bad = new WmlConfig();
    bad.setAttribute('description', 'no condition');
    cfg.addChild('objective', bad);
    expect(parseScenarioObjectives(cfg).objectives).toEqual([]);
  });

  it('parses [gold_carryover] entries, each attribute independently optional (real obj.bonus ~= nil / obj.carryover_percentage checks)', () => {
    const cfg = new WmlConfig();
    const gc = new WmlConfig();
    gc.setAttribute('bonus', true);
    gc.setAttribute('carryover_percentage', 40);
    cfg.addChild('gold_carryover', gc);

    const result = parseScenarioObjectives(cfg);
    expect(result.goldCarryover).toEqual([{ bonus: true, carryoverPercentage: 40 }]);
  });

  it('a [gold_carryover] with only bonus= (no carryover_percentage=) reports just that field', () => {
    const cfg = new WmlConfig();
    const gc = new WmlConfig();
    gc.setAttribute('bonus', false);
    cfg.addChild('gold_carryover', gc);
    expect(parseScenarioObjectives(cfg).goldCarryover).toEqual([{ bonus: false }]);
  });

  it('parses [note] children, dropping any with no description=', () => {
    const cfg = new WmlConfig();
    const n1 = new WmlConfig();
    n1.setAttribute('description', 'A hint.');
    cfg.addChild('note', n1);
    cfg.addChild('note', new WmlConfig()); // no description= -- dropped.
    expect(parseScenarioObjectives(cfg).notes).toEqual(['A hint.']);
  });

  it('summary= and silent= round-trip', () => {
    const cfg = new WmlConfig();
    cfg.setAttribute('summary', 'A short overview.');
    cfg.setAttribute('silent', true);
    const result = parseScenarioObjectives(cfg);
    expect(result.summary).toBe('A short overview.');
    expect(result.silent).toBe(true);
  });

  it('silent= defaults to false (objectives_changed = not silent, i.e. shown by default)', () => {
    expect(parseScenarioObjectives(new WmlConfig()).silent).toBe(false);
  });
});

describe('turnCounterSuffix (real generate_objectives turn-counter text)', () => {
  it('shows the real "(N turns left)" text when turns remain', () => {
    // turn_limit=30, current_turn=1 -> remaining = 30 - 1 + 1 = 30.
    expect(turnCounterSuffix(1, 30)).toBe(' (30 turns left)');
  });

  it('uses the real singular "(this turn left)" text on the last turn', () => {
    expect(turnCounterSuffix(30, 30)).toBe(' (this turn left)');
  });

  it('shows nothing once the turn limit has already passed', () => {
    expect(turnCounterSuffix(31, 30)).toBe('');
  });

  it('shows nothing for an unlimited (-1) turn limit, matching the real turn_limit >= current_turn guard', () => {
    expect(turnCounterSuffix(1, -1)).toBe('');
  });
});
