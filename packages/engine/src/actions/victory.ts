/**
 * TS port of `game_board::check_victory` (`src/game_board.cpp`) -- "is the scenario over, and who's left
 * standing." A side stands by its `defeat_condition` (`GameBoard.teamIsDefeated`); a side that has fallen gives
 * up its villages; the scenario goes on while two standing sides are still enemies. `foundPlayer` says
 * whether a human side is among those left: `play_controller::check_victory` then fires `enemies_defeated`,
 * and ends the scenario (a victory) only if the scenario's `victory_when_enemies_defeated=` allows it -- or a
 * defeat when no human side is left.
 */

import type { GameBoard } from '../model/GameBoard.js';

export interface VictoryCheck {
  /** False once the scenario should end (mirrors `continue_level` inverted for readability at call sites). */
  readonly continueLevel: boolean;
  /** Side numbers not defeated -- meaningful only when `continueLevel` is false. */
  readonly notDefeated: readonly number[];
  /** `found_player`: a human side is among those left standing. */
  readonly foundPlayer: boolean;
}

/** Mirrors `game_board::check_victory` -- see module doc comment. Clears the villages of fallen sides. */
export function checkVictory(board: GameBoard): VictoryCheck {
  const notDefeated = board
    .teams()
    .filter((t) => !board.teamIsDefeated(t.side))
    .map((t) => t.side);
  for (const t of board.teams()) if (!notDefeated.includes(t.side)) board.clearVillages(t.side);

  for (let i = 0; i < notDefeated.length; i++) {
    for (let j = i + 1; j < notDefeated.length; j++) {
      const a = board.getTeam(notDefeated[i]!);
      const b = board.getTeam(notDefeated[j]!);
      if (a && b && a.isEnemy(b)) {
        return { continueLevel: true, notDefeated, foundPlayer: false };
      }
    }
  }
  const foundPlayer = notDefeated.some((side) => board.getTeam(side)?.controller === 'human');
  return { continueLevel: false, notDefeated, foundPlayer };
}
