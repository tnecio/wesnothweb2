/**
 * Phase 19: sound-effect requests -- what the game asks the player's audio
 * to play, decoupled from how (the browser's Web Audio lives in `ui`).
 *
 * Groups are `sound.cpp`'s channel groups: `sound` (SOUND_FX: `[sound]`,
 * frame sounds, status sounds), `sources` (SOUND_SOURCES: sound sources and
 * the time of day's ambient sound), `ui`, `bell` (the turn bell) and `timer`.
 */
export type SoundGroup = 'sound' | 'sources' | 'ui' | 'bell' | 'timer';

export interface SoundRequest {
  /** `name=`: a comma list, `[a,b]`/`[1~3]` brackets expanded -- one is picked when it plays (`pick_one`). */
  readonly files: string;
  /** Extra plays after the first (`repeat=`); -1 loops (SDL_mixer's `loops`). */
  readonly repeats: number;
  readonly group: SoundGroup;
  /** Sound-source id, so a positioned sound can be stopped or repositioned. */
  readonly sourceId?: string;
  /** 0-100: distance-based volume for a positioned sound (100 by default). */
  readonly volume?: number;
  /**
   * `false`: play it whenever it is ready, however late (a `[sound]` telling of something that
   * happened). Left out, sound effects and clicks tied to what is on screen are dropped if they
   * would start noticeably late.
   */
  readonly dropIfLate?: boolean;
  /**
   * A side's turn-start sound (the time of day's, the turn bell). A UI that shows the other sides'
   * moves after they were computed holds these until it has shown them, so they sound as the turn
   * changes on screen.
   */
  readonly turnStart?: boolean;
}

/** `game_config::sounds` (`game_config.cfg`'s `[sounds]`, `game_config.cpp`). */
export const GAME_SOUNDS = {
  turnBell: 'bell.wav',
  timerBell: 'timer.wav',
  slowed: 'slowed.wav',
  poisoned: 'poison.ogg',
  petrified: 'petrified.ogg',
  /** `unit_animation`'s default `healed_sound`. */
  healed: 'heal.wav',
  buttonPress: 'button.wav',
  checkboxRelease: 'checkbox.wav',
  sliderAdjust: 'slider.wav',
  menuExpand: 'expand.wav',
  menuContract: 'contract.wav',
  menuSelect: 'select.wav',
  /** `mouse_events`: selecting one's own unit. */
  selectUnit: 'select-unit.wav',
} as const;

/** The status sounds a blow that hits adds, in `attack::perform_hit`'s order (poison, slow, petrify). */
export function extraHitSounds(blow: { poisoned: boolean; slowed: boolean; petrified: boolean }): string[] {
  const sounds: string[] = [];
  if (blow.poisoned) sounds.push(GAME_SOUNDS.poisoned);
  if (blow.slowed) sounds.push(GAME_SOUNDS.slowed);
  if (blow.petrified) sounds.push(GAME_SOUNDS.petrified);
  return sounds;
}
