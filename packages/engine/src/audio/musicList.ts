/**
 * Phase 19: the music playlist, a port of `sound.cpp`'s playlist half
 * (`current_track_list`, `play_music_config`, `commit_music_changes`,
 * `choose_track`/`track_ok`, `play_music_once`, `write_music_play_list`)
 * and `music_track`. It decides *what* plays; a player (the browser's audio
 * layer) does the playing and reports when a track ends.
 *
 * Upstream this is one global list that lives across scenarios; here one
 * `MusicList` is handed from session to session the same way. Track choice
 * uses a random source the caller gives -- upstream's unsynced default RNG,
 * so it never touches the synced game.
 *
 * `request` is the player's instruction: every change of track bumps its
 * `seq`, with the fade-out for the old track (the previous track's
 * `ms_after`) and fade-in for the new (`ms_before`; none when a track just
 * followed another -- the thinker's `no_fading`).
 */
import { WmlConfig } from '../wml/config.js';

export interface MusicTrack {
  /** `name=`: the file under a `music/` binary path. */
  readonly id: string;
  readonly title: string;
  readonly msBefore: number;
  readonly msAfter: number;
  /** `play_once=` (settable: a track can be told to finish then yield). */
  once: boolean;
  readonly append: boolean;
  readonly immediate: boolean;
  /** Default yes. */
  shuffle: boolean;
}

export interface MusicRequest {
  readonly seq: number;
  readonly track: MusicTrack;
  readonly fadeOutMs: number;
  readonly fadeInMs: number;
}

export interface MusicListOptions {
  /** A uniform integer in [0, max] (upstream's `default_instance().get_random_int(0, max)`). */
  random: (max: number) => number;
  /** Whether a music file exists (`resolve_track_path`); a track that does not is refused. */
  exists?: (id: string) => boolean;
}

function cfgOf(attrs: Record<string, string | number | boolean>): WmlConfig {
  const cfg = new WmlConfig();
  for (const [k, v] of Object.entries(attrs)) cfg.setAttribute(k, v);
  return cfg;
}

function trackFromConfig(cfg: WmlConfig): MusicTrack {
  return {
    id: cfg.getString('name', ''),
    title: cfg.getString('title', ''),
    msBefore: cfg.getNumber('ms_before', 0),
    msAfter: cfg.getNumber('ms_after', 0),
    once: cfg.getBoolean('play_once', false),
    append: cfg.getBoolean('append', false),
    immediate: cfg.getBoolean('immediate', false),
    shuffle: cfg.getBoolean('shuffle', true),
  };
}

export class MusicList {
  private tracks: MusicTrack[] = [];
  private currentIndex = 0;
  current: MusicTrack | null = null;
  previous: MusicTrack | null = null;
  private playedBefore: string[] = [];
  request: MusicRequest | null = null;
  private seq = 0;

  constructor(private readonly options: MusicListOptions) {}

  /** A random integer in [0, max] from the same unsynced source track choice uses. */
  randomInt(max: number): number {
    return this.options.random(max);
  }

  get length(): number {
    return this.tracks.length;
  }

  track(i: number): MusicTrack | undefined {
    return this.tracks[i];
  }

  /** `get_current_track_index`: undefined while a play-once track (not on the list) plays. */
  get currentTrackIndex(): number | undefined {
    return this.currentIndex < this.tracks.length ? this.currentIndex : undefined;
  }

  private create(cfg: WmlConfig): MusicTrack | null {
    const track = trackFromConfig(cfg);
    if (track.id === '' || (this.options.exists && !this.options.exists(track.id))) return null;
    return track;
  }

  /** `play_music`: asks the player for the current track, fading the previous one out by its `ms_after`. */
  private play(): void {
    if (!this.current) return;
    this.request = { seq: ++this.seq, track: this.current, fadeOutMs: this.previous?.msAfter ?? 0, fadeInMs: this.current.msBefore };
  }

  private setPrevious(): void {
    this.previous = this.current;
  }

  /** `music_list.next`: skips to the list's next choice, fading the current track out. */
  next(): void {
    if (this.tracks.length === 0) return;
    this.setPrevious();
    this.current = this.chooseTrack();
    this.play();
  }

  /** `play_music_once`: plays `id` now, off the list. */
  playOnce(id: string): void {
    const track = this.create(cfgOf({ name: id }));
    if (!track) return;
    this.setPrevious();
    this.current = { ...track, once: true };
    this.currentIndex = this.tracks.length;
    this.play();
  }

  /** `empty_playlist`. */
  clear(): void {
    this.tracks = [];
  }

  /**
   * `play_music_config`: one `[music]`: `play_once=` plays it now off the
   * list; otherwise it replaces the list (or `append=`s to it, at index
   * `at` if given), skipping a duplicate name; `immediate=` switches to it
   * now; else, unless `allowInterrupt`, a replaced list lets the current
   * track finish first.
   */
  playConfig(cfg: WmlConfig, allowInterrupt: boolean, at = -1): void {
    const track = this.create(cfg);
    if (!track) return;
    if (track.once) {
      this.setPrevious();
      this.current = track;
      this.currentIndex = this.tracks.length;
      this.play();
      return;
    }
    if (!track.append) this.tracks = [];
    let index = this.tracks.findIndex((t) => t.id === track.id);
    if (index === -1) {
      index = at >= 0 && at < this.tracks.length ? at : this.tracks.length;
      this.tracks.splice(index, 0, track);
      if (index <= this.currentIndex) this.currentIndex++;
    }
    if (track.immediate) {
      this.setPrevious();
      this.current = this.tracks[index]!;
      this.currentIndex = index;
      this.play();
    } else if (!track.append && !allowInterrupt && this.current) {
      this.current.once = true;
    }
  }

  /** `track_ok`: never the current track again, nor one played too recently (Timothy Pinkham's rules). */
  private trackOk(id: string): boolean {
    if (!this.current) return true;
    if (id === this.current.id) return false;
    if (this.tracks.length <= 3) return true;
    let numPlayed = 0;
    const played = new Set<string>();
    for (let i = this.playedBefore.length - 1; i >= 0; i--) {
      const p = this.playedBefore[i]!;
      if (p === id) {
        if (++numPlayed === 2) break;
      } else {
        played.add(p);
      }
    }
    if (numPlayed === 2 && played.size !== this.tracks.length - 1) return false;
    const beforePrevious = this.playedBefore[this.playedBefore.length - 2];
    return beforePrevious !== id;
  }

  /** `choose_track`: the next in order, or a random acceptable one when the track at the index shuffles. */
  private chooseTrack(): MusicTrack {
    if (this.currentIndex >= this.tracks.length) this.currentIndex = 0;
    if (this.tracks[this.currentIndex]!.shuffle) {
      let pick = 0;
      if (this.tracks.length > 1) {
        do {
          pick = this.options.random(this.tracks.length - 1);
        } while (!this.trackOk(this.tracks[pick]!.id));
      }
      this.currentIndex = pick;
    }
    const chosen = this.tracks[this.currentIndex]!;
    this.playedBefore.push(chosen.id);
    return chosen;
  }

  /**
   * `commit_music_changes`: forget what played; keep a play-once or
   * still-listed current track, else switch to the list's choice.
   */
  commit(): void {
    this.playedBefore = [];
    if (this.current) {
      if (this.current.once) return;
      if (this.tracks.some((t) => t.id === this.current!.id)) return;
    }
    if (this.tracks.length === 0) return;
    this.setPrevious();
    this.current = this.chooseTrack();
    this.play();
  }

  /**
   * The player's report that nothing is playing -- the current track
   * finished, or a list was set while it was silent (`music_thinker`'s
   * "no start time, list not empty, mixer idle" branch): the list's next choice follows at once, no
   * fading. With an empty list nothing follows.
   */
  trackEnded(): void {
    if (this.tracks.length === 0) return;
    this.setPrevious();
    this.current = this.chooseTrack();
    this.request = { seq: ++this.seq, track: this.current, fadeOutMs: 0, fadeInMs: 0 };
  }

  /** `write_music_play_list`: the list as `[music]` tags (the first replaces, the rest append). */
  write(): WmlConfig[] {
    return this.tracks.map((t, i) => {
      const m = new WmlConfig();
      m.setAttribute('name', t.id);
      m.setAttribute('ms_before', t.msBefore);
      m.setAttribute('ms_after', t.msAfter);
      if (i > 0) m.setAttribute('append', true);
      m.setAttribute('shuffle', t.shuffle);
      return m;
    });
  }
}

/**
 * `wml_actions.music` (`wml-tags.lua`) over the `music_list` API: `play_once=`
 * plays now; otherwise a list that is not `append=`ed is cleared (an
 * `immediate=` one first lets the current track be marked play-once), and
 * the track is added (`append=yes`, with `immediate=`/`ms_before=`/
 * `ms_after=`); `shuffle=no` and `title=` then apply to it. Nothing is
 * committed: the change is heard when the current track ends.
 */
export function applyMusicAction(list: MusicList, cfg: WmlConfig): void {
  const name = cfg.getString('name', '');
  if (cfg.getBoolean('play_once', false)) {
    list.playOnce(name);
    return;
  }
  if (!cfg.getBoolean('append', false)) {
    if (cfg.getBoolean('immediate', false) && list.currentTrackIndex !== undefined && list.current) list.current.once = true;
    list.clear();
  }
  const before = list.length;
  const add = cfgOf({
    name,
    append: true,
    immediate: cfg.getBoolean('immediate', false),
    ms_before: cfg.getNumber('ms_before', 0),
    ms_after: cfg.getNumber('ms_after', 0),
  });
  list.playConfig(add, false);
  const n = list.length;
  if (n === 0) return;
  const last = list.track(n - 1)!;
  if (cfg.hasAttribute('shuffle') && !cfg.getBoolean('shuffle')) last.shuffle = false;
  if (cfg.hasAttribute('title') && before !== n) (last as { title: string }).title = cfg.getString('title');
}

/** `game_config::default_victory_music`/`default_defeat_music` (`game_config.cfg`). */
export const DEFAULT_VICTORY_MUSIC: readonly string[] = ['victory.ogg', 'victory2.ogg'];
export const DEFAULT_DEFEAT_MUSIC: readonly string[] = ['defeat.ogg', 'defeat2.ogg'];

/**
 * `playsingle_controller::play_scenario`: the scenario's `[music]` tags,
 * each allowed to interrupt, then one commit. A scenario without any keeps
 * whatever plays.
 */
export function startScenarioMusic(list: MusicList, scenario: WmlConfig): void {
  for (const m of scenario.children('music')) list.playConfig(m, true);
  list.commit();
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * `play_controller::select_music`: one of the scenario's `victory_music=`/
 * `defeat_music=` (an `[endlevel] music=` replaces it), else one of the
 * defaults, chosen at random; '' if there is none.
 */
export function selectEndMusic(scenario: WmlConfig, victory: boolean, override: readonly string[] | undefined, random: (max: number) => number): string {
  const own = override ?? splitList(scenario.getString(victory ? 'victory_music' : 'defeat_music', ''));
  const choices = own.length > 0 ? own : victory ? DEFAULT_VICTORY_MUSIC : DEFAULT_DEFEAT_MUSIC;
  return choices.length === 0 ? '' : choices[random(choices.length - 1)]!;
}

/** The end-of-scenario stinger (`playsingle_controller::play_scenario_end`): the playlist is emptied and the track plays once. */
export function playEndMusic(list: MusicList, track: string): void {
  if (track === '') return;
  list.clear();
  list.playOnce(track);
}
