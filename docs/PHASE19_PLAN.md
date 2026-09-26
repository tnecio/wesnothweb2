# Phase 19 — Audio & Music: working plan (draft for review, 2026-09-26)

Scope is the plan's Phase 19 section (`IMPLEMENTATION_PLAN.md`). This file
is how I intend to build it, stage by stage, so it can be reviewed before
work starts.

## Ground rules (same as 18c/18d/18)

- Port upstream's behaviour, not an approximation. The sources are
  `src/sound.cpp` (playlist, channels, `play_sound*`), `src/sound_music_track.cpp`,
  `src/soundsource.cpp`, `src/scripting/lua_audio.cpp` (the `music_list` API that
  WML `[music]` goes through), `data/lua/wml-tags.lua` (`[music]`, `[sound]`,
  `[volume]`, `[sound_source]`, `[remove_sound_source]`),
  `src/units/frame.cpp` (frame `sound=`) and `data/game_config.cfg` `[sounds]`.
- **Game state vs presentation.** Upstream's audio state is almost all
  client-side and unsynced (track choice uses the *default* RNG, not the
  synced one). Only these belong to the game and its saves: the music
  playlist (`write_music_play_list` into the snapshot), the sound sources
  (`[sound_source]` tags in the snapshot) and the scenario's
  `victory_music=`/`defeat_music=`. Everything else is the player's.
- **Layering.** The engine holds pure, testable models with no browser APIs:
  the playlist rules, the sound-source specs, and a queue of sound requests
  that WML and actions produce. `packages/ui` gets an `audio/` module that
  owns the Web Audio graph and plays what the models ask for. The renderer
  only reports frame `sound=`s through a callback. Nothing in engine or
  renderer imports audio APIs, so the engine test suites stay node-only.
- Each stage ends with all suites green, a browser check, a commit and a
  `PROGRESS.md` entry.

## Loading, threading and formats (applies to all stages)

**What we'd load.**
- `core/music`: 43 tracks, 162 MB in all. They're Ogg Vorbis at about
  160 kbps, 44.1 kHz stereo, typically 3–6 MB each and up to 11.5 MB
  (`cry_from_elensefar.ogg`).
- `core/sounds`: 8.1 MB, 232 Ogg Vorbis and 40 WAV files, mostly small.
- None of the four campaigns ships its own music.

**Music is streamed, never decoded in JS.**
- Each track plays through an `HTMLAudioElement`: the browser fetches it
  progressively (HTTP range requests) and decodes it on its own media
  threads. The audio is routed into Web Audio with
  `MediaElementAudioSourceNode`, only so that the gains (volume, fades,
  mute) apply.
- Mixing runs on the browser's audio rendering thread.
- So neither the main thread nor our image compositor workers do any
  music work, and a 10 MB track never sits decoded in memory. The
  alternative, `decodeAudioData` on a whole track, would hold roughly
  50 MB of PCM per track and stall until it finished; it's ruled out for
  music.
- Same-origin files (`/game-images/core/music/...`), so
  `MediaElementSource` has no CORS problem.

**Keeping music from competing with the board's images for bandwidth.**
- Nothing is fetched before the board has rendered
  (`data-board-ready`) and the user has made a gesture (autoplay policy).
  Startup bandwidth stays with the terrain and unit bundles.
- The current track uses `preload="auto"`. The *next* track is decided
  early: `MusicList` can pick it ahead, as `choose_track` is
  deterministic given its RNG draw. It's prefetched on a second, idle
  element (`preload="auto"`) about 20 s before the current one ends, so
  the switch is immediate.
- Upstream doesn't crossfade consecutive tracks (`no_fading`), so a
  near-gapless start is all "smooth" requires. Fades (`ms_before`/`ms_after`)
  are gain ramps on the audio thread (`linearRampToValueAtTime`), not JS
  timers.
- At most one prefetch runs at a time, and it's cancelled if the
  playlist changes (`[music] immediate=`).
- Caching: long-lived `Cache-Control` for `/game-images/**/music|sounds`
  in production, like the image bundles, so replaying a scenario doesn't
  refetch.

**Sound effects are small and decoded once.**
- Sound effects are fetched and passed to `decodeAudioData`, which is
  asynchronous; Chrome and Firefox decode off the main thread, and only
  the resulting `AudioBuffer` comes back.
- Buffers are cached by path, with an LRU byte cap of around 32 MB of PCM.
- Preloading is per scenario, at idle priority after the board is ready:
  the sounds referenced by the unit types present (attack, hit, miss, die
  frames) plus the common ones (bell, UI).
- It uses `fetch(…, { priority: 'low' })` with a concurrency cap of 2, so
  it never competes with image bundles.
- A sound needed before it's cached is fetched on demand and played when
  ready, or dropped if it arrives more than ~150 ms late (a late hit sound
  is worse than none). Each miss is logged once.
- The image compositor worker pool is untouched: audio never goes through
  it.

**Formats (decided 2026-09-26).**
- The shipped Ogg Vorbis and WAV files are used as they are, with no
  conversion and no format detection or fallback. Old Safari versions
  without Vorbis are not supported.
- A transcode is **not** part of Phase 19. It stays an option for Phase 23
  (mobile), purely to shrink the download (for example Opus at ~96 kbps
  would take the music from ~162 MB to ~95 MB), and only if real-world
  tests show the download size is actually a problem.

**Checks for this part.**
- In the Playwright run, the main thread's long tasks (`PerformanceObserver`,
  `longtask`) are measured while a track starts and during a fight with
  effects. No new long tasks may be attributable to audio.
- The image bundle timings from `measure-load.mjs` must not regress with
  audio on.
- Network: no music request goes out before board-ready plus a gesture.

## Stage 1 — Music

**Engine**

- `engine/src/audio/musicList.ts`: a `MusicList` class porting
  `current_track_list`, `play_music_config` (`play_once`/`append`/`immediate`,
  the duplicate-name rule, insert index), `commit_music_changes`,
  `choose_track` + `track_ok` (Timothy Pinkham's no-repeat rules),
  `play_music_once`, `empty_playlist` and `write_music_play_list`. A random
  source and an `exists(file)` check are injected. It exposes
  `request = {seq, track, fadeOutMs, fadeInMs}`, which the player watches,
  and `trackEnded()`, which the player calls (the `music_thinker`'s "nothing
  playing, pick the next" branch, with no fading).
  - A first draft of this file already exists, **uncommitted**:
    `packages/engine/src/audio/musicList.ts`. It typechecks but has no
    tests and isn't wired in. I'll review it against `sound.cpp` again
    before using it.
- `applyMusicAction`: `wml_actions.music` exactly as the Lua does it
  through `music_list.add/clear/play`. It always appends; an `immediate=`
  that clears first marks the current track play-once; `shuffle=no` and
  `title=` apply after the add; nothing is committed.
- Wiring:
  - `ctx.music` holds the list. `[music]` changes from a no-op to real.
  - At scenario start, the scenario's own `[music]` tags go through
    `playConfig(m, allowInterrupt=true)` followed by `commit()` (upstream's
    `play_scenario`).
  - At scenario end, the stinger: `select_music(victory)` (the scenario's
    `victory_music=`/`defeat_music=`, else `default_victory_music` /
    `default_defeat_music` from `game_config.cfg`, picked at random), then
    `empty_playlist` and `play_music_once`. It plays only on defeat, or on
    a victory with a carryover report, as `playsingle_controller.cpp:405`.
- Carried across scenarios: `GameSession.startNextScenario` hands the same
  `MusicList` to the next session, as upstream's global list survives. A
  scenario without `[music]` keeps the current playlist.
- Saves: `SaveGameData.music` (the written `[music]` list). In Wesnoth
  saves it goes out as the snapshot's `[music]` tags and comes back from
  them; loading replays them as scenario-start music.
- `musicFiles.json` (generated, like `campaignImages.json`): the files
  under `core/music` and each campaign's `music/`. It drives `exists()`
  and URL resolution, campaign first (the binary-path order found in 18).

**UI (`packages/ui/src/audio/`)**

- `AudioEngine`: one `AudioContext` with gain buses music/sound/UI/bell
  under a master gain.
  - Music plays through an `HTMLAudioElement` → `MediaElementSource` →
    music bus. That streams long `.ogg` tracks and needs no full decode.
  - Crossfades: fade the old track out over `fadeOutMs`, then start the
    new one fading in over `fadeInMs`. Upstream halts the old track after
    its fade-out, so there's no overlap.
  - On `ended`, the engine calls `list.trackEnded()`.
- Autoplay policy: the context starts suspended and is resumed on the
  first pointer or key gesture. Whatever the list wants at that moment
  starts then, so the queued track isn't lost.
- Missing or undecodable files are logged once per file and treated as
  ended, so the list moves on. There are no retries in a loop.
- Settings, kept per browser in `localStorage` (try/catch):
  - music volume, sound volume, UI volume, bell volume, each 0–100;
  - music on/off, sound on/off, and a master mute.
  - Mute is immediate (master gain to 0) and unmute restores the gains.
  - Upstream's "stop music in background" (pause on window blur) is on by
    default.
- Minimal controls now: a mute toggle in the top bar, plus hotkeys if
  upstream has them (I'll check `hotkeys.cfg`), and a small "Audio"
  dialog with the four sliders. The full preferences screen stays in
  Phase 24.
- `GameShell` makes one `AudioEngine` per app (module singleton) and
  points it at the session's `MusicList`. It follows `request.seq` in
  `sync()`.

**Tests**

- `musicList.test.ts` with a scripted RNG:
  - replace vs append vs immediate vs play_once;
  - duplicate-name skip; insert-index adjustment;
  - `commit` keeping a still-listed or play-once track;
  - `track_ok` rules at 2, 3 and 5 tracks; shuffle off plays in order;
  - `write()` round-trips through `playConfig`.
- Session tests:
  - the scenario-start playlist from a real scenario;
  - a `[music]` event mid-game;
  - the playlist carried into the next scenario;
  - save/load and the Wesnoth-save round trip;
  - the victory/defeat stinger choice.
- Real-binary cross-check (cheap, optional): run the 1.19 build with
  `--log-info=audio` on a scenario whose `[music]` uses `immediate=` or
  `shuffle=no`, and compare the "Playing track" sequence. Shuffled lists
  can't be compared, since the RNG is unsynced.
- Browser check (Playwright): Web Audio can't be heard headless, so the
  `AudioEngine` exposes a debug log of what it started, faded and stopped.
  - The script asserts the scenario's first track starts after the first
    click.
  - A turn boundary with a `[music]` event switches the track.
  - Mute drops master gain to 0, and unmute restores it.

## Stage 2 — Sound effects

**Engine**

- `ctx.sounds`: a queue of `{files, repeats, group}` requests.
  `[sound] name= repeat=` pushes one (`wesnoth.audio.play`). `name=` is a
  comma list, and `pick_one` chooses a file at play time, avoiding the
  previous choice for the same list (client side, unsynced).
- Game-driven sounds come from the same events upstream uses:
  - the turn bell (`[sounds] turn_bell`, bell group) at a human side's
    turn start;
  - the status sounds when a unit becomes slowed or poisoned
    (`[sounds][status]`);
  - anything else I find in `sound::play_sound` call sites in
    `actions/`, `play_controller`, `menu_events`. I'll list them first,
    then port each.

**Renderer**

- Frame sounds: `UnitFrameDef.sound` is already parsed (`frame.ts`).
  Upstream plays it when the frame starts (`unit_frame::redraw` → `play_sound`).
  `playAnimations` gets an `onSound(files)` callback, called once per frame
  start. This covers attack swings, hits and misses, deaths, movement,
  recruits, level-up and heal animations.

**UI**

- Sound effects are decoded once into `AudioBuffer`s and cached (with an
  LRU cap), and played through the sound bus.
- Channels: upstream has 32, with 8 reserved for sound sources, 2 for UI
  and 1 for the bell. I'll mirror the budget: at most N concurrent sound
  effects, where a new one steals the oldest, as SDL_mixer does when
  channels run out. That stops mass combat from stacking up.
- `repeat=`: `AudioBufferSourceNode` loops `repeats` extra times.
- UI sounds (button, checkbox, menu open, error) go through the UI bus,
  from the gui2 theme data. I'll check what the 1.19 GUI actually plays.
  A small `playUiSound(id)` is called from the shared Modal/button
  components.

**Tests / checks**

- The queue contents from `[sound]` and status events are unit tests.
- Frame-sound emission is tested with a stub callback on the renderer's
  pure sampling code.
- Browser: an attack's `onSound` log contains the weapon's hit sound on a
  hit, and no errors appear.

## Stage 3 — Sound sources and `[volume]`

**Engine**

- `SoundSourceSpec` (`soundsource.cpp`'s `sourcespec`): `id`, `sounds`,
  `delay` (default 1000 ms), `chance` (default 100), `loop`, `full_range`
  (3), `fade_range` (14), `check_fogged`, `check_shrouded`, and
  `x`/`y` or `[filter]` locations.
  - `[sound_source]` adds or replaces one by id; `[remove_sound_source]`
    removes a comma list of ids.
  - Saved in `SaveGameData.soundSources` and as `[sound_source]` in the
    snapshot. Read back from Wesnoth saves.
- `[volume] music= sound=` (percent of the player's setting) sets a
  scripted scale. The scale is session state, not a preference. Upstream
  does persist it while the game runs; I'll check whether it survives
  save/load there and do the same.

**UI**

- `SoundSourceManager`: every tick (upstream's `manager::update`, driven by
  the display), each source rolls its chance once `delay` has passed. It
  plays when not already playing, reaches the source bus with a
  distance-based volume, and follows the viewport: full volume within
  `full_range` hexes of the viewport centre, fading to silence at
  `fade_range`. It skips fogged or shrouded hexes when asked to.
  - The viewport centre comes from the board view, which already knows it
    for scrolling.
  - Sources stop when the scenario ends or the view leaves the game.

**Tests / checks**

- The spec parse/write round trip; `[sound_source]`/`[remove_sound_source]`
  in the pump; save/load.
- The distance → volume curve against `soundsource.cpp`'s formula.
- Browser: a scenario with a sound source (I'll find one in the four
  campaigns) logs positioned plays that change volume as the view scrolls.

## Milestone (from the plan)

- A real scenario's `[music]` playlist plays and transitions correctly
  across a turn boundary.
- A weapon's attack sound fires on a hit.
- Mute silences everything immediately and unmute restores it.

All three are verified through the `AudioEngine` debug log in Playwright,
plus one manual listen by you in a real browser.

## Decisions I'd like you to confirm

1. **Audio formats.** Decided: Ogg/WAV as shipped, no fallback. A
   size-reducing transcode is a Phase 23 option only if real-world tests
   show the download is a problem.
2. **Where the playlist lives.** Proposal: the engine `MusicList`, handed
   from session to session. The Phase 21 main menu, which plays
   `title_music`, will then reuse the same `AudioEngine` with its own
   list. The alternative is one app-global list from the start.
3. **Controls now.** Proposal: a mute toggle plus a small Audio dialog
   with the volume sliders now; the full preferences screen stays in
   Phase 24.
4. **Verification depth.** Proposal: headless checks through the debug
   log, plus one real-binary `--log-info=audio` comparison for a
   non-shuffled playlist. There'd be no attempt to compare shuffled
   choices or timing, since both are unsynced and client-side upstream.
