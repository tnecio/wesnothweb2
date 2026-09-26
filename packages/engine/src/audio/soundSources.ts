/**
 * Phase 19, stage 3: sound sources -- `soundsource.cpp`'s `sourcespec` and
 * the manager's bookkeeping. A source is a sound (or list of sounds) that
 * plays now and then, from a few hexes or from everywhere, louder the closer
 * the viewed part of the map is to it. The specs are game state (saved, in
 * `[sound_source]` tags); *playing* them depends on where the player is
 * looking, and lives with the audio in `ui`.
 */
import { WmlConfig } from '../wml/config.js';
import { Location } from '../model/Location.js';

/** `soundsource::DEFAULT_DELAY` (ms) and `DEFAULT_CHANCE`. */
export const DEFAULT_SOURCE_DELAY_MS = 1000;
export const DEFAULT_SOURCE_CHANCE = 100;
/** `DISTANCE_SILENT`: SDL_mixer's distance scale runs 0 (full volume) to 255 (silent). */
export const DISTANCE_SILENT = 255;

export interface SoundSourceSpec {
  readonly id: string;
  /** `sounds=`: a comma list, one picked each time it plays. */
  readonly sounds: string;
  /** `delay=`: the least time between two plays, in ms. */
  readonly delayMs: number;
  /** `chance=`: percent, rolled each update once the delay has passed. */
  readonly chance: number;
  /** `loop=`: extra plays per play (-1: until stopped). */
  readonly loop: number;
  /** `full_range=`: within this many hexes of the view's centre the source is at full volume. */
  readonly fullRange: number;
  /** `fade_range=`: over this many further hexes it fades to silence. */
  readonly fadeRange: number;
  readonly checkFogged: boolean;
  readonly checkShrouded: boolean;
  /** Where it sounds from (`x=`/`y=`, WML 1-based in the file, 0-based here); none: everywhere. */
  readonly locations: readonly Location[];
}

/** `sourcespec::sourcespec(const config&)`. */
export function soundSourceFromConfig(cfg: WmlConfig): SoundSourceSpec {
  const xs = cfg.getString('x', '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  const ys = cfg.getString('y', '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  const locations: Location[] = [];
  if (xs.length === ys.length) {
    for (let i = 0; i < xs.length; i++) {
      const x = Number.parseInt(xs[i]!, 10);
      const y = Number.parseInt(ys[i]!, 10);
      if (Number.isFinite(x) && Number.isFinite(y)) locations.push(Location.fromWml(x, y));
    }
  }
  return {
    id: cfg.getString('id', ''),
    sounds: cfg.getString('sounds', ''),
    delayMs: Math.trunc(cfg.getNumber('delay', DEFAULT_SOURCE_DELAY_MS)),
    chance: Math.trunc(cfg.getNumber('chance', DEFAULT_SOURCE_CHANCE)),
    loop: Math.trunc(cfg.getNumber('loop', 0)),
    fullRange: Math.trunc(cfg.getNumber('full_range', 3)),
    fadeRange: Math.trunc(cfg.getNumber('fade_range', 14)),
    checkFogged: cfg.getBoolean('check_fogged', true),
    checkShrouded: cfg.getBoolean('check_shrouded', true),
    locations,
  };
}

/** `sourcespec::write`: the `[sound_source]` a save holds. */
export function soundSourceToConfig(spec: SoundSourceSpec): WmlConfig {
  const cfg = new WmlConfig();
  cfg.setAttribute('id', spec.id);
  cfg.setAttribute('sounds', spec.sounds);
  cfg.setAttribute('delay', spec.delayMs);
  cfg.setAttribute('chance', spec.chance);
  cfg.setAttribute('check_fogged', spec.checkFogged);
  cfg.setAttribute('check_shrouded', spec.checkShrouded);
  cfg.setAttribute('loop', spec.loop);
  cfg.setAttribute('full_range', spec.fullRange);
  cfg.setAttribute('fade_range', spec.fadeRange);
  cfg.setAttribute('x', spec.locations.map((l) => l.wmlX).join(','));
  cfg.setAttribute('y', spec.locations.map((l) => l.wmlY).join(','));
  return cfg;
}

/**
 * `positional_source::calculate_volume`'s distance part: 0 (full volume)
 * within `fullRange` hexes, then a linear fade over `fadeRange` more up to
 * `DISTANCE_SILENT`; silent at once beyond when there is no fade range.
 */
export function distanceToVolumeIndex(distance: number, fullRange: number, fadeRange: number): number {
  if (distance <= fullRange) return 0;
  if (fadeRange === 0) return DISTANCE_SILENT;
  return Math.trunc(((distance - fullRange) / fadeRange) * DISTANCE_SILENT);
}

/** SDL_mixer's `Mix_SetDistance`: the linear gain (0-1) a distance value stands for. */
export function volumeIndexToGain(index: number): number {
  return Math.max(0, Math.min(1, (DISTANCE_SILENT - index) / DISTANCE_SILENT));
}

/** The sources of a game, by id in the order they were added (`sound_source` tags are written in id order upstream: a `std::map`). */
export class SoundSourceStore {
  private readonly sources = new Map<string, SoundSourceSpec>();

  /** `manager::add`: adds, or replaces the source with the same id (which then starts afresh). */
  add(spec: SoundSourceSpec): void {
    this.sources.set(spec.id, spec);
  }

  /** `manager::remove`. */
  remove(id: string): boolean {
    return this.sources.delete(id);
  }

  get(id: string): SoundSourceSpec | undefined {
    return this.sources.get(id);
  }

  /** In id order, as `write_sourcespecs` walks its map. */
  all(): SoundSourceSpec[] {
    return [...this.sources.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  clear(): void {
    this.sources.clear();
  }

  /** `write_sourcespecs`. */
  write(): WmlConfig[] {
    return this.all().map(soundSourceToConfig);
  }
}
