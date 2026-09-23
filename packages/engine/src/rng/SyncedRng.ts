/**
 * The RNG every game rule draws from, switching source the way upstream's
 * `randomness::generator` does as the game enters and leaves a synced
 * action (`set_scontext_synced` / `synced_context::get_rng_for_action`):
 *
 * - **Inside an action, `per_action` mode** (upstream's default
 *   `random_mode`): a fresh MT stream per action, seeded lazily on the first
 *   draw from `seedProvider` -- which records the seed as a dependent
 *   `[random_seed]`, or reads it back from the log during a replay or redo
 *   (`random_synced.cpp`'s `synced_rng`). A reload before an attack gets a
 *   new seed and so a new roll; a replay stays exact, and a divergence stays
 *   inside the one action that caused it.
 * - **Inside an action, `deterministic` mode**: the whole game's own stream
 *   (`rng_proxy` over `gamedata->rng()`), for tests and AI benchmarks.
 * - **Outside any action**: `unsynced` -- AI decisions, the `ai turn` event,
 *   anything upstream runs through its default, non-replayed generator.
 *   Deterministic from the session's seed here, so headless runs repeat.
 *
 * Every draw inside an action tells `onSyncedDraw` (upstream: drawing blocks
 * undo in both modes, `ask_server_choice`/`get_rng_for_action`).
 */

import { Rng } from './Rng.js';
import { MtRng } from './MtRng.js';

export type RandomMode = 'per_action' | 'deterministic';

export class SyncedRng extends Rng {
  private action: { rng: MtRng | null } | null = null;
  /** Called on every draw inside an action, before it happens. */
  onSyncedDraw: () => void = () => {};

  constructor(
    /** The whole game's stream (`random_seed`/`random_calls` in a save). */
    readonly game: MtRng,
    /** The stream for everything outside a synced action. */
    readonly unsynced: MtRng,
    public mode: RandomMode,
    /** Supplies the seed for a new action stream: a fresh one live, the recorded one in a replay. */
    public seedProvider: () => string,
  ) {
    super();
  }

  /** Whether a synced action is running. */
  get inAction(): boolean {
    return this.action !== null;
  }

  /** Whether the running action has drawn a random number yet. */
  get actionDrew(): boolean {
    return this.action?.rng !== null && this.action?.rng !== undefined;
  }

  /** Random calls made by the running action's own stream (upstream's `[checkup] random_calls=`). */
  get actionCalls(): number {
    return this.action?.rng?.getRandomCalls() ?? 0;
  }

  /** Enters a synced action (`set_scontext_synced`). Nested entries are an error, as upstream's assert. */
  beginAction(): void {
    if (this.action) throw new Error('SyncedRng: an action is already running');
    this.action = { rng: null };
  }

  endAction(): void {
    this.action = null;
  }

  protected nextRandomImpl(): number {
    const action = this.action;
    if (!action) return this.unsynced.getNextRandom();
    this.onSyncedDraw();
    if (this.mode === 'deterministic') return this.game.getNextRandom();
    if (!action.rng) {
      const rng = new MtRng(0);
      rng.seedRandom(this.seedProvider(), 0);
      action.rng = rng;
    }
    return action.rng.getNextRandom();
  }
}

/** A fresh seed string from real entropy, as `seed_rng::next_seed_str()`. */
export function entropySeedStr(): string {
  return new MtRng().getRandomSeedStr();
}
