/**
 * Phase 17: the suspension protocol that lets a WML event stop mid-body,
 * ask the player something (or have the display play something out), and
 * resume where it left off.
 *
 * Upstream doesn't need a protocol: `wml_event_pump::operator()` runs on
 * the same C++ stack as the display, so `[message]` simply opens a nested
 * SDL/GUI2 event loop (`gui/dialogs/wml_message.cpp`, `show_wml_message`)
 * and nothing else advances until it closes. A browser has no nested event
 * loop to borrow, and this engine package is deliberately free of
 * `Promise`/`async` (every one of its ~30 event-firing call sites --
 * vision, AI, the snapshot builder -- is synchronous, as are all of its
 * tests).
 *
 * So an action handler that needs to block returns a **generator** which
 * `yield`s an `Interaction` and is resumed with the `InteractionResult`.
 * `runActionFlow` delegates into it with `yield*`, so the suspension
 * propagates all the way out through `[if]`/loop bodies and nested event
 * fires to whoever is driving the pump:
 *
 * - headless callers (`EventPump.pump()`, `runActionSequence`, every
 *   engine test, `runScenarioStartupEvents`) drive it with `runFlow` and
 *   the pure, synchronous `autoRespond` -- so they behave exactly as they
 *   did before this existed, and stay deterministic;
 * - `packages/ui`'s `GameSession` steps the same generator itself and
 *   parks on a real dialog between steps.
 */

import type { Location } from '../model/Location.js';
import type { Unit } from '../model/Unit.js';
import type { RecordedMessage } from './context.js';

/** One `[option]` of a `[message]`, after `[show_if]` filtering (see `message.lua`'s `wml_actions.message`). */
export interface MessageOption {
  /** `label=`: the row's own text. */
  readonly label: string;
  /** `message=`/`description=` (synonyms upstream): the longer body text under the label. */
  readonly description: string;
  /** `image=`: an icon for the row; `''` for none. */
  readonly image: string;
  /** `default=`: this row starts selected. */
  readonly isDefault: boolean;
}

/** A `[message]`'s `[text_input]` child (only the first is honoured, as upstream). */
export interface TextInputSpec {
  /** `label=`: caption above the box. */
  readonly label: string;
  /** `text=`: the initial contents. */
  readonly text: string;
  /** `max_length=`, clamped to 1-1024 (default 256), like `message.lua`. */
  readonly maxLength: number;
}

/** A `[message]` waiting to be shown; `options`/`textInput` are empty/absent for a plain "click to continue" line. */
export interface MessageInteraction {
  readonly kind: 'message';
  readonly message: RecordedMessage;
  readonly options: readonly MessageOption[];
  readonly textInput?: TextInputSpec;
}

/**
 * A unit that only exists for the length of an animation
 * (`[move_unit_fake]`'s `create_fake_unit`): it is never added to the
 * board, so it is described rather than referenced.
 */
export interface FakeUnitSpec {
  readonly typeId: string;
  readonly side: number;
  readonly variation: string;
  readonly imageMods: string;
  readonly gender: string;
}

/** One fake unit and the hexes it walks, in order. */
export interface FakeUnitWalk {
  readonly spec: FakeUnitSpec;
  readonly path: readonly Location[];
}

/**
 * Something for the display to play out before the event continues --
 * upstream's cutscene and camera tags, each of which blocks its event on
 * the C++ side simply by running a nested animation/pump loop. A headless
 * caller completes them instantly (`autoRespond`), which is why every
 * beat carries the *state change* it stands for, never a duration the
 * engine would have to wait out itself.
 */
export type CutsceneBeat =
  /** `[delay]`: time= in ms, `accelerate=` letting the display cut it short. */
  | { readonly kind: 'delay'; readonly ms: number; readonly accelerate: boolean }
  /** `[scroll_to]`/`[scroll_to_unit]`: centre a hex. */
  | {
      readonly kind: 'scrollTo';
      readonly location: Location;
      readonly immediate: boolean;
      readonly onlyIfNeeded: boolean;
      readonly highlight: boolean;
    }
  /** `[scroll]`: shift the view by a pixel delta. */
  | { readonly kind: 'scrollBy'; readonly dx: number; readonly dy: number }
  /** `[lock_view]`/`[unlock_view]`: pin the camera where it is. */
  | { readonly kind: 'lockView'; readonly locked: boolean }
  /** `[zoom]`: `factor=`, absolute unless `relative=yes`. */
  | { readonly kind: 'zoom'; readonly factor: number; readonly relative: boolean }
  /** `[color_adjust]`: an instant tint over the map, cleared by setting it back to 0,0,0. */
  | { readonly kind: 'colorAdjust'; readonly red: number; readonly green: number; readonly blue: number }
  /** `[screen_fade]`: fade the whole screen to a colour over `duration` ms. */
  | {
      readonly kind: 'screenFade';
      readonly red: number;
      readonly green: number;
      readonly blue: number;
      readonly alpha: number;
      readonly durationMs: number;
    }
  /** `[move_unit]`: a real unit walking its route; the board is updated when the beat finishes. */
  | { readonly kind: 'moveUnit'; readonly unit: Unit; readonly path: readonly Location[] }
  /** `[move_unit_fake]`/`[move_units_fake]`: sprites that exist only for this animation. */
  | { readonly kind: 'moveFakeUnits'; readonly walks: readonly FakeUnitWalk[] }
  /** `[animate_unit]`: play one named animation on a unit. */
  | {
      readonly kind: 'animateUnit';
      readonly unit: Unit;
      /** `flag=`: which animation (`recruited`, `idle`, `levelout`, ...). */
      readonly flag: string;
      /** `text=`: floating text over the unit; `''` for none. */
      readonly text: string;
      readonly withBars: boolean;
    }
  /** `[kill] animate=yes`: a unit's death animation, played before it leaves the board. */
  | { readonly kind: 'unitDeath'; readonly unit: Unit; readonly scroll: boolean }
  /** `[unit] animate=yes`: a freshly placed unit appearing. */
  | { readonly kind: 'unitAppear'; readonly unit: Unit };

/** A cutscene beat waiting to be played out. */
export interface BeatInteraction {
  readonly kind: 'beat';
  readonly beat: CutsceneBeat;
}

/** Everything a running event can stop for. */
export type Interaction = MessageInteraction | BeatInteraction;

/**
 * What the player (or `autoRespond`) answered with -- deliberately the
 * shape upstream records for replay (`[input] value=/text=`, see
 * `synced_user_choice.cpp`'s `ask_local_choice`), so Phase 25 can log
 * these verbatim.
 */
export interface InteractionResult {
  /** The 1-based index of the chosen `[option]` (never the option's `value=` -- that mapping happens in `[message]` itself, as upstream). */
  readonly value?: number;
  /** What was typed into `[text_input]`. */
  readonly text?: string;
  /**
   * Escape on a message with no input: skip the rest of *this event's*
   * input-less messages (`wesnoth.interface.skip_messages()`). Not part
   * of the replayed choice -- it's a local display preference.
   */
  readonly skip?: boolean;
}

/**
 * A suspendable action: `yield`s each `Interaction` and is resumed with
 * its `InteractionResult`. Handlers that never block just return `void`.
 */
export type Flow<T = void> = Generator<Interaction, T, InteractionResult>;

/** Answers one interaction. Anything with a display supplies its own; headless callers use `autoRespond`. */
export type Responder = (interaction: Interaction) => InteractionResult;

const EMPTY_RESULT: InteractionResult = {};

/**
 * The headless answer to any interaction: dismiss a plain message, take
 * the `default=yes` option (else the first one), and accept a
 * `[text_input]`'s own `text=` as typed. Pure and synchronous, so a
 * headless run of the same WML always takes the same branch -- which is
 * what keeps every existing engine test deterministic now that events can
 * suspend.
 */
export const autoRespond: Responder = (interaction) => {
  // A beat has nothing to answer: headless, it has simply happened.
  if (interaction.kind === 'beat') return {};
  const options = interaction.options;
  const preferred = options.findIndex((o) => o.isDefault);
  return {
    value: options.length === 0 ? undefined : preferred >= 0 ? preferred + 1 : 1,
    text: interaction.textInput?.text,
  };
};

/** True for the generator an action handler returns (as opposed to a plain `void` handler's `undefined`). */
export function isFlow(value: unknown): value is Flow {
  return typeof (value as Flow | undefined)?.next === 'function';
}

/** Drives a flow to completion without ever suspending, answering every interaction inline. */
export function runFlow<T>(flow: Flow<T>, respond: Responder = autoRespond): T {
  let step = flow.next(EMPTY_RESULT);
  while (!step.done) {
    step = flow.next(respond(step.value));
  }
  return step.value;
}
