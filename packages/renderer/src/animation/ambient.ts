/**
 * Phase 27c S3: what a unit plays at rest (`units/animation_component.cpp`), the PixiJS-free part --
 * `SnapshotBoard` drives it.
 */
import type { SnapshotUnit } from '../SnapshotBoard.js';
import type { UnitAnimationDef } from './unitAnimation.js';

/**
 * Phase 27c S3: the events a unit plays at rest (`unit_animation_component`): `standing` (or `_disabled_` with
 * standing animations off, or for an incapacitated unit), `idling`, and `selected` (`_disabled_selected_`).
 */
export type AmbientAnimationEvent = 'standing' | '_disabled_' | 'idling' | 'selected' | '_disabled_selected_';

/** Picks `unit`'s animation for `event` (`choose_animation`), or null for none. */
export type AmbientAnimationSource = (unit: SnapshotUnit, event: AmbientAnimationEvent) => UnitAnimationDef | null;

/** `show_standing_animations`, `idle_anim` and `idle_anim_rate` (-40..30), as upstream's preferences. */
export interface AmbientAnimationPrefs {
  standing: boolean;
  idle: boolean;
  idleRate: number;
}

/** `get_next_idle_tick`: 20-40 s from `now`, scaled by `2^(-rate/10)`; never without idle animations. */
export function nextIdleTick(now: number, prefs: AmbientAnimationPrefs, random: () => number = Math.random): number {
  if (!prefs.idle) return Infinity;
  const rate = Math.pow(2, -prefs.idleRate / 10);
  return now + Math.trunc((20000 + Math.floor(random() * 20000)) * rate);
}

