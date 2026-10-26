/**
 * Phase 30: the campaign dialog's **Combat:** menu (`campaign_dialog.cfg`'s `rng_menu`, `singleplayer.cpp`): the
 * three random modes, with upstream's labels and tooltips, and the short names the URL (`/play/<id>?rng=`) and
 * the opt-in statistics use for them.
 */
import type { RandomMode } from '@wesnothweb2/engine';
import { t } from '../i18n/locale.js';

export interface RandomModeChoice {
  readonly mode: RandomMode;
  /** `default`, `predictable` or `reduced`. */
  readonly param: string;
  readonly label: () => string;
  readonly tooltip: () => string;
}

/** In upstream's order; the first is what the dialog opens at. */
export const RANDOM_MODE_CHOICES: readonly RandomModeChoice[] = [
  { mode: 'per_action', param: 'default', label: () => t("Default RNG"), tooltip: () => t("Pure, unbiased randomness; the way Wesnoth is intended to be played.\n\nExample: if you strike twice with 50% accuracy, you’re most likely to hit once and miss once, but might also hit twice or miss twice.") },
  { mode: 'deterministic', param: 'predictable', label: () => t("Predictable RNG"), tooltip: () => t("Identical to Default RNG, except loading a saved game will not change the outcome of an attack.\n\nExample: you strike twice and get lucky, hitting both strikes. You then load an earlier save and make the same attack again. Both strikes will still hit.") },
  { mode: 'biased', param: 'reduced', label: () => t("Reduced RNG"), tooltip: () => t("Hits and misses are much more consistent. This tends to make small-scale engagements easier to plan.\n\nExample: if you strike three times with 50% accuracy, you will always hit at least once and miss at least once.") },
];

/** The mode a `?rng=` value (or a statistics name) stands for; anything else is the default. */
export function randomModeFromParam(param: string | null | undefined): RandomMode {
  return RANDOM_MODE_CHOICES.find((c) => c.param === param)?.mode ?? 'per_action';
}

/** The short name of `mode` (`default`, `predictable`, `reduced`). */
export function randomModeParam(mode: RandomMode | undefined): string {
  return RANDOM_MODE_CHOICES.find((c) => c.mode === mode)?.param ?? 'default';
}
