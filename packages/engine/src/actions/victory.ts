/**
 * TS port of the *default* half of `game_board::check_victory`
 * (`src/game_board.cpp`) -- "is the scenario over, and who's left standing."
 *
 * Ported: a side counts as not-defeated if it has a unit with
 * `can_recruit() == true` (a leader) -- upstream's `defeat_condition::
 * no_leader_left`, the default for a `[side]` that doesn't set
 * `defeat_condition=`. The scenario ends once every remaining not-defeated
 * side is mutually allied with every other remaining not-defeated side
 * (upstream: no two of them are still `is_enemy()` of each other).
 *
 * NOT ported: `defeat_condition=no_units_left`/`=never` (this project's
 * `Team` doesn't parse `defeat_condition=` yet -- every side is treated as
 * `no_leader_left`, which is Dead Water scenario 1's real setting for both
 * sides and mainline's overwhelmingly common default). Also not ported:
 * firing the real `enemies_defeated`/`die` WML events that let a scenario
 * script its own victory/defeat message and `[endlevel]` override (e.g.
 * Dead Water's `{HERO_DEATHS}` macro, which adds "Cylanna dies" as an
 * extra, non-leader defeat condition via a `[event] name=die` handler) --
 * that needs the live `EventPump` to fire `die` *before* the dead unit is
 * removed from the board (so `[filter] id=...` can still match it), which
 * `packages/engine/src/actions/combat.ts`'s headless combat resolver
 * doesn't do. Tracked as a follow-up in docs/PROGRESS.md, not silently
 * dropped -- the generic leader-death check implemented here already
 * covers this scenario's primary, stated objective ("Defeat enemy
 * leader" / "Death of Kai Krellis").
 */

import type { GameBoard } from '../model/GameBoard.js';

export interface VictoryCheck {
  /** False once the scenario should end (mirrors `continue_level` inverted for readability at call sites). */
  readonly continueLevel: boolean;
  /** Side numbers not defeated -- meaningful only when `continueLevel` is false. */
  readonly notDefeated: readonly number[];
}

/** Mirrors `game_board::check_victory`'s default (`no_leader_left`-only) case -- see module doc comment. */
export function checkVictory(board: GameBoard): VictoryCheck {
  const notDefeated = new Set<number>();
  for (const unit of board.allUnits()) {
    if (unit.canRecruit) notDefeated.add(unit.side);
  }

  const sides = [...notDefeated];
  for (let i = 0; i < sides.length; i++) {
    for (let j = i + 1; j < sides.length; j++) {
      const a = board.getTeam(sides[i]!);
      const b = board.getTeam(sides[j]!);
      if (a && b && a.isEnemy(b)) {
        return { continueLevel: true, notDefeated: sides };
      }
    }
  }
  return { continueLevel: false, notDefeated: sides };
}
