/** TS port of upstream's `stage` base (`src/ai/composite/stage.hpp/.cpp`): one phase of an `[ai]`'s turn, run in `[stage]` document order by `AiComposite.playTurn`. */
export interface Stage {
  readonly id: string;
  readonly name: string;
  /** Runs this stage once; returns whether it changed the gamestate (mirrors `stage::do_play_stage`'s return, used only for logging/observers upstream -- kept here for parity and future use, e.g. a headless "did anything happen this turn" check). */
  playStage(): boolean;
}

/** Mirrors `idle_stage` (`name=empty`): does nothing. Real Wesnoth's `idle_ai` uses exactly one of these as its whole main loop. */
export class IdleStage implements Stage {
  readonly id: string;
  readonly name = 'empty';

  constructor(id: string) {
    this.id = id;
  }

  playStage(): boolean {
    return false;
  }
}
