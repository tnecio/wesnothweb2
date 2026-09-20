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

/** Everything a running event can stop for. Cutscene/camera beats join this union in E3. */
export type Interaction = MessageInteraction;

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
