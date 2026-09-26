/**
 * Playing the game's sound sources (`soundsource.cpp`'s `manager` and
 * `positional_source`). The game holds the specs; this decides when each one
 * sounds and how loud, from where the player is looking:
 *
 * - each update, once a source's `delay` has passed and nothing of it is
 *   playing, it rolls its `chance` (1-100) and, on success, plays -- from
 *   everywhere at full volume if it has no locations, else at the volume of
 *   the *nearest* location to the centre of the view: full within
 *   `full_range` hexes, fading over `fade_range` more, silent beyond (a fog
 *   or shroud on the location silences it too, when asked);
 * - when the view moves, a playing source follows it (`update_positions`),
 *   and one that has gone silent is stopped;
 * - replacing a source (same id, new spec) starts it afresh and silences
 *   the old one; removing one silences it.
 */
import { Location, distanceBetween, distanceToVolumeIndex, volumeIndexToGain, DISTANCE_SILENT, type SoundRequest, type SoundSourceSpec } from '@wesnothweb2/engine';

/** What the manager asks of the board view. */
export interface SourceHost {
  /** The hex at the centre of the viewed map area (engine 0-based), or null when there is no view. */
  viewCenter(): { x: number; y: number } | null;
  isFogged(x: number, y: number): boolean;
  isShrouded(x: number, y: number): boolean;
}

/** What the manager asks of the sound player. */
export interface SourcePlayer {
  play(request: SoundRequest): void;
  stopSource(sourceId: string): void;
  isSourcePlaying(sourceId: string): boolean;
  setSourceVolume(sourceId: string, volume: number): void;
}

interface Live {
  readonly spec: SoundSourceSpec;
  /** Unique per instance (`positional_source::id_`), so a replaced source's sound can be stopped without touching its successor's. */
  readonly playId: string;
  lastPlayed: number;
}

export class SoundSourceManager {
  private readonly live = new Map<string, Live>();
  private serial = 0;
  private lastCenter: string | null = null;

  constructor(
    private readonly player: SourcePlayer,
    private readonly host: SourceHost,
    private readonly random: (max: number) => number = (max) => Math.floor(Math.random() * (max + 1)),
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Follows the game's list of sources: new or replaced specs start afresh, missing ones stop. */
  setSources(specs: readonly SoundSourceSpec[]): void {
    const wanted = new Set(specs.map((s) => s.id));
    for (const [id, live] of this.live) {
      if (!wanted.has(id)) this.drop(id, live);
    }
    for (const spec of specs) {
      const existing = this.live.get(spec.id);
      if (existing?.spec === spec) continue;
      if (existing) this.player.stopSource(existing.playId);
      const live: Live = { spec, playId: `${spec.id}#${++this.serial}`, lastPlayed: Number.NEGATIVE_INFINITY };
      this.live.set(spec.id, live);
      // `impl_sndsrc_set` updates the manager right after adding.
      this.update(live);
    }
  }

  stopAll(): void {
    for (const [id, live] of [...this.live]) this.drop(id, live);
    this.lastCenter = null;
  }

  private drop(id: string, live: Live): void {
    this.player.stopSource(live.playId);
    this.live.delete(id);
  }

  /** One pass, as the display drives it: if the view moved, sources follow it, else they get their chance to play. */
  tick(): void {
    const center = this.host.viewCenter();
    const key = center ? `${center.x},${center.y}` : null;
    const moved = key !== this.lastCenter;
    this.lastCenter = key;
    for (const live of this.live.values()) {
      if (moved) this.updatePositions(live);
      else this.update(live);
    }
  }

  /** `positional_source::calculate_volume` over every location: the index (0 loud .. 255 silent) of the nearest one. */
  private volumeIndex(spec: SoundSourceSpec): number {
    const center = this.host.viewCenter();
    if (!center) return DISTANCE_SILENT;
    const centerLoc = new Location(center.x, center.y);
    let best = DISTANCE_SILENT;
    for (const loc of spec.locations) {
      if ((spec.checkShrouded && this.host.isShrouded(loc.x, loc.y)) || (spec.checkFogged && this.host.isFogged(loc.x, loc.y))) continue;
      best = Math.min(best, distanceToVolumeIndex(distanceBetween(loc, centerLoc), spec.fullRange, spec.fadeRange));
    }
    return best;
  }

  /** `positional_source::update`. */
  private update(live: Live): void {
    const { spec } = live;
    const now = this.now();
    if (now - live.lastPlayed < spec.delayMs || this.player.isSourcePlaying(live.playId)) return;
    const roll = this.random(99) + 1;
    if (roll > spec.chance) return;
    live.lastPlayed = now;
    // No locations: as if present everywhere on the map, at full volume.
    let volume = 100;
    if (spec.locations.length > 0) {
      const index = this.volumeIndex(spec);
      if (index >= DISTANCE_SILENT) return;
      volume = volumeIndexToGain(index) * 100;
    }
    this.player.play({ files: spec.sounds, repeats: spec.loop, group: 'sources', sourceId: live.playId, volume });
  }

  /** `positional_source::update_positions`. */
  private updatePositions(live: Live): void {
    const { spec } = live;
    if (spec.locations.length === 0) {
      this.update(live);
      return;
    }
    if (!this.player.isSourcePlaying(live.playId)) {
      this.update(live);
      return;
    }
    const index = this.volumeIndex(spec);
    if (index >= DISTANCE_SILENT) this.player.stopSource(live.playId);
    else this.player.setSourceVolume(live.playId, volumeIndexToGain(index) * 100);
  }
}
