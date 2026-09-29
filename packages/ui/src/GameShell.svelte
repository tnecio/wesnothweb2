<script lang="ts">
  /**
   * Top-level game shell: owns one `GameSession` (see gameSession.ts) and
   * bridges it into Svelte's reactivity for TopBar/GameBoardView/
   * SidePanel/StoryViewer/MessageViewer. `GameSession` is a plain, rune-free
   * class (see its own doc comment for why); this component is the one
   * place that mutates it and mirrors the bits each child needs into
   * `$state` variables afterward (`sync()`) -- a deliberate, explicit
   * "reactivity bridge" rather than relying on Svelte's `$state(...)` deep-
   * proxying a custom class instance (which only reliably works for plain
   * objects/arrays and classes whose own fields are declared with
   * `$state()`, neither of which apply to a plain-TS domain class written
   * for `tsc`-only environments).
   *
   * ## Pre-play sequence (playability feedback: story/message tags)
   *
   * `phase` walks 'story' -> 'messages' -> 'playing' (skipping 'story' if
   * the scenario has none, skipping 'messages' if the events recorded no
   * dialogue). The board is fully live underneath the whole time (its
   * PixiJS canvas mounts immediately), but `StoryViewer`/`MessageViewer`
   * are full-screen fixed overlays that visually and interactionally block
   * it -- see those components -- until the player has clicked through
   * both. `session.runStartupEvents()` (real `prestart`/`start` `[event]`
   * handlers, see `GameSession`'s own doc comment) is called once, right
   * before entering 'messages', so the board already reflects every real
   * event-spawned unit by the time the player gets control.
   */
  import { dataUrl } from './dataUrls.js';
  import { setGameContext } from './errors/errorReporting.svelte.js';
  import { setSideColorResolver } from './images/unitImageRef.js';
  import { ENGINE_IMAGES, GAME_IMAGES } from './gameData.js';
  import { tick, untrack } from 'svelte';
  import type {
    GameBoardSnapshot,
    SnapshotUnit,
    TimeOfDayEntry,
    Unit,
    AiAnimationEvent,
    HealOutcome,
    MessageInteraction,
    InteractionResult,
    CutsceneBeat,
    FakeUnitWalk,
  } from '@wesnothweb2/engine';
  import { WmlConfig, type WmlConfigJson, playStoryMusic, extraHitSounds, GAME_SOUNDS, directionBetween, relativeDirection, tilesAdjacent, Direction, Location, unitCanAct, parseTerrainCode } from '@wesnothweb2/engine';
  import {
    type HexPoint,
    type UnitAnimationCue,
    type AnimationContext,
    HEX_STEP_MS,
    animationDurationMs,
    animationSoundFiles,
    parseUnitAnimations,
    chooseAnimation,
    buildAttackAnimationContexts,
    buildMovementAnimationContexts,
    buildMovementAnimationContext,
    terrainLookup,
    spriteKey,
    setImageBaseUrl,
    setCampaignImages,
    sideColorRgb,
    ImageCache,
    setEngineImageBaseUrl,
    setOrbColorIds,
    resolveSideColorId,
    type ColorData,
    type MinimapInput,
    type RouteOverlay,
    type View,
  } from '@wesnothweb2/renderer';
  import {
    GameSession,
    type CombatPreview,
    type SelectedUnitInfo,
    type RecruitOption,
    type RecallOption,
    type AttackerWeaponOption,
    type SaveGameData,
    type EconomyInfo,
    type VillageOwnerInfo,
    type HexVisibilityPoint,
    type ReachableHexPoint,
    type LastAttackAnimation,
    type LastMoveAnimation,
    type LastRecruitAnimation,
    type PendingAdvancement,
    type HoveredHexInfo,
    type InteractionHost,
    type GameSessionOptions,
    type HexClickOptions,
  } from './gameSession.js';
  import {
    saveGame,
    loadGame,
    listSaves,
    deleteSave,
    renameSave,
    readSetting,
    type SaveDetails,
    type SaveKind,
    type SaveMeta,
  } from './persistence.js';
  import { type CampaignInfo as Campaign, campaignAbbrev, defaultDifficulty } from './save/campaign.js';
  import { fetchScenarioSnapshot } from './scenarioFetch.js';
  import { markCampaignCompleted } from './menu/completedStore.js';
  import { campaignCredits, type CreditsJson } from './menu/credits.js';
  import { downloadSave, importSaveFile } from './save/saveManager.js';
  import {
    scenarioLabel,
    autosaveName,
    manualSaveName,
    scenarioStartSaveName,
    autosavesToDelete,
    DEFAULT_AUTO_SAVE_MAX,
  } from './save/naming.js';
  import SaveGameDialog from './SaveGameDialog.svelte';
  import LoadGameDialog from './LoadGameDialog.svelte';
  import { fetchStoryAssets, type StoryAssets } from './story/storyImages.js';
  import { matchesHotkey, type Command } from './commands.js';
  import TopBar from './TopBar.svelte';
  import ContextMenu from './ContextMenu.svelte';
  import LabelDialog from './LabelDialog.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import LabelSettingsDialog from './LabelSettingsDialog.svelte';
  import GameBoardView from './GameBoardView.svelte';
  import SidePanel from './SidePanel.svelte';
  import Minimap from './Minimap.svelte';
  import { createMinimapStyle } from './minimapStyle.js';
  import { displayPrefs } from './displayPrefs.js';
  import { fetchTeamColors } from './teamColorsCache.js';
  import StoryViewer from './StoryViewer.svelte';
  import PreferencesDialog from './PreferencesDialog.svelte';
  import LanguageDialog from './LanguageDialog.svelte';
  import { accessibility } from './accessibility.js';
  import { fmt, locale, t, tw, ts, tx } from './i18n/locale.js';
  import { getAudioEngine } from './audio/audioEngine.js';
  import { installUiSounds } from './audio/uiSounds.js';
  import type { AudioSettings } from './audio/settings.js';
  import MessageViewer from './MessageViewer.svelte';
  import AdvancementDialog from './AdvancementDialog.svelte';
  import ObjectivesDialog from './ObjectivesDialog.svelte';
  import ScenarioEndOverlay from './ScenarioEndOverlay.svelte';
  import Outro from './Outro.svelte';
  import { buildOutroScreens, outroHoldMs } from './story/outro.js';
  import RecruitDialog from './RecruitDialog.svelte';
  import RecallDialog from './RecallDialog.svelte';
  import AttackDialog from './AttackDialog.svelte';

  // Every `imageUrl()` user (time-of-day images, portraits), not only the board, needs the served
  // image roots -- until the board mounted, they defaulted to a non-existent `/data/data` (Phase 16 N0 finding).
  setImageBaseUrl(GAME_IMAGES);
  setEngineImageBaseUrl(ENGINE_IMAGES);

  import campaignImages from './campaignImages.json';

  let {
    snapshot,
    storyAssets: initialStoryAssets = null,
    campaign = null,
    initialSave = null,
    startInReplay = false,
    onOpenSave = undefined,
    campaigns = [],
    onQuitToMenu = undefined,
  }: {
    snapshot: GameBoardSnapshot;
    /** `/story/<campaignDir>/<id>.json` for `snapshot`'s scenario (see `storyAssetsFor`); null shows the story without images. */
    storyAssets?: StoryAssets | null;
    /**
     * Which campaign this scenario belongs to (`campaigns.json`). A save
     * records it so the manager can group and filter by campaign, and so
     * an exported file can name the campaign the way real Wesnoth does
     * (see `save/wesnothSave.ts`). Null for a scenario opened directly.
     */
    campaign?: Campaign | null;
    /**
     * A save to resume instead of starting the scenario fresh (Phase 26).
     * The session is built from it directly, and the story screen and
     * startup events are skipped -- the save already records that they
     * ran (`SaveGameData.startupEventsRun`), and replaying a campaign's
     * intro every time you resume would be wrong twice over.
     */
    initialSave?: SaveGameData | null;
    /**
     * Open `initialSave` straight into its replay instead of resuming it (upstream's "Show replay",
     * offered by the Load dialog both here and on the title screen -- see `LoadGameDialog`'s own
     * `showReplay` checkbox). Ignored without `initialSave`, and falls back to a normal resume if the
     * save has no recorded replay (made before replays were recorded), same as opening it normally and
     * then choosing Show Replay from the in-game Load dialog would.
     */
    startInReplay?: boolean;
    /**
     * Ask the host to open `saveName` in `campaignId` -- i.e. to put that
     * campaign and save in the URL and mount accordingly. Called when a
     * loaded save belongs to a different campaign (this component cannot
     * switch campaigns by itself: the campaign decides the abbreviation
     * saves are named with and the id they are filed under), and after
     * any load, so the address bar names the game that is actually open.
     * `replay` carries a "Show replay" request across the handoff, so
     * picking another campaign's save with the checkbox ticked still opens
     * its replay once the host remounts this shell for that campaign.
     */
    onOpenSave?: (campaignId: string, saveName: string, replay?: boolean) => void;
    /** Every campaign, so the load dialog can name the campaign a save belongs to even when it is not the one being played. */
    campaigns?: readonly Campaign[];
    /** Leave the game for the title screen (upstream's "Quit to Menu"). Without it the command is not offered. */
    onQuitToMenu?: () => void;
  } = $props();

  /** The scenario currently being played -- reassigned by `continueToNextScenario`. Everything below that used to read the `snapshot` prop directly now reads this instead. */
  // `$state.raw`, not `$state`: the snapshot (~2.3 MB of JSON) is only ever replaced whole (continueToNextScenario),
  // and a deep proxy made every engine read of it go through Svelte proxy traps -- ~190 ms of main-thread time
  // plus GC while loading Dead Water 1 (Phase 28a P3 profile).
  let activeSnapshot = $state.raw(snapshot);

  /**
   * Phase 22: the minimap's inputs. `minimapInput` is refreshed by `sync()`
   * with everything else the board shows; `cameraState` follows the board's
   * camera (every pan, zoom and glide) for the minimap's outline.
   */
  let minimapInput = $state.raw<MinimapInput | null>(null);
  /**
   * Phase 22: "Show Enemy Moves" / "Best Possible Enemy Moves"
   * (`menu_handler::show_enemy_moves`): every hex an enemy could reach, shown
   * in place of the selection's reach until the pointer moves to another hex
   * or the player clicks. `shownAt` is the hex the pointer was on then.
   */
  let enemyReach = $state.raw<{ hexes: { x: number; y: number }[]; shownAt: HexPoint | null } | null>(null);

  function showEnemyMoves(ignoreUnits: boolean): void {
    enemyReach = { hexes: session.enemyReach(ignoreUnits), shownAt: lastHoveredHex };
    refreshMinimap();
  }

  function clearEnemyMoves(): void {
    if (!enemyReach) return;
    enemyReach = null;
    refreshMinimap();
  }

  /** The minimap's reach overlay is whatever reach the board is showing (`reach_map`). */
  function refreshMinimap(): void {
    minimapInput = session.minimapInput(new Set((enemyReach?.hexes ?? reachable).map((h) => `${h.x},${h.y}`)));
  }
  let cameraState = $state.raw<{ view: View; viewport: { width: number; height: number } } | null>(null);
  let teamColors = $state.raw<ColorData | null>(null);
  void fetchTeamColors().then((colors) => (teamColors = colors));
  const minimapStyle = $derived(
    createMinimapStyle({
      terrainTypeConfigs: (activeSnapshot.terrainTypeConfigs ?? []) as { attrs?: Record<string, unknown> }[],
      colors: teamColors,
      sideColorId: (side) => resolveSideColorId(session.board.getTeam(side)?.color ?? '', side, teamColors?.defaultColors ?? []),
      orbColorIds: accessibility.current.orbColors,
      terrainInfo: (code) => {
        try {
          const info = session.board.map.terrainInfoFor(parseTerrainCode(code));
          return { id: info.id, unionType: info.unionType.map((c) => c.toString()) };
        } catch {
          return null;
        }
      },
    }),
  );
  // Phase 20: fetch the translation catalogues this scenario's own text belongs to (its campaign's domain, ...).
  $effect(() => {
    void locale.useDomains(activeSnapshot.textdomains ?? []);
  });
  /** Bound `GameBoardView` instance, so `handleConfirmAttack`/`handleHexClick` can await its imperative `playAnimationSequence` before applying a resolved attack's/move's final state -- see that method's own doc comment. Reassigned across a scenario transition (the `{#key}` block around `<GameBoardView>` remounts it), so `$state`, not a plain `let`, same reasoning as `board` in `GameBoardView.svelte` itself. */
  let boardView: GameBoardView | undefined = $state();
  /** Bumped when the board's area changes size, so a message over it re-measures (see `MessageViewer`'s `layoutTick`). */
  let boardResizeTick = $state(0);
  /**
   * `$state.raw`, not plain `$state`/a bare `let`: `GameSession` is a
   * deliberately rune-free plain-TS class (see `gameSession.ts`'s own doc
   * comment), so Svelte can't/shouldn't deep-proxy its internals -- every
   * in-place mutation is already mirrored into the `$state` vars below via
   * `sync()`, which is what the template actually reads. `$state.raw`
   * tracks exactly the one thing that DOES need to be reactive:
   * *reassignment* of `session` itself, which `continueToNextScenario` does
   * wholesale on a scenario transition. A plain (non-reactive) `let` here
   * was tried first and flagged by `svelte-check` (`non_reactive_update`)
   * -- worth heeding given this project's own prior history of a real,
   * intermittent reactivity bug from exactly this pattern (an unmarked
   * `let` reassigned after the fact, read directly in template/effect code
   * -- see docs/PROGRESS.md's "real, intermittent reactivity race" entry
   * about `GameBoardView.svelte`'s `board` variable).
   */
  /**
   * Phase 18b: the browser game seeds each action from real entropy, as
   * upstream does, so reloading before an attack gives a new roll. (Headless
   * callers keep the default: seeds derived from the session seed.)
   */
  /**
   * Phase 19: the one audio engine of the app; its playlist is shared by
   * every session, as upstream's global one survives scenarios.
   */
  const audio = getAudioEngine();
  const SESSION_OPTIONS: GameSessionOptions = { actionSeeds: 'entropy', music: audio.music, onSound: (request) => audio.playSound(request), onVolume: (scale) => audio.setVolumeScale(scale) };
  /**
   * `startInReplay`'s session, built up front (rather than resumed normally and switched over after mount,
   * the way `startReplay` does for an in-game "Show replay") so the very first render is already the
   * replay screen -- resuming first would flash the wrong phase (the end screen, for a finished game) for
   * one frame before `startReplay` could correct it. `null` when `startInReplay` was not asked for, or the
   * save has no recorded replay to show (made before replays were recorded) -- the normal resume below is
   * the fallback either way, same as `startReplay`'s own guard.
   */
  const initialReplaySession = initialSave && startInReplay ? GameSession.forReplay(activeSnapshot, initialSave, { ...SESSION_OPTIONS, onSound: undefined, onVolume: undefined }) : null;
  // Resuming a save builds the session from it instead (Phase 26) -- see
  // the `initialSave` prop. `startupEventsRun` comes back true with it, so
  // `runStartupEvents` below is skipped as well.
  let session = $state.raw(
    initialReplaySession ?? (initialSave ? GameSession.fromSaveData(activeSnapshot, initialSave, SESSION_OPTIONS) : new GameSession(activeSnapshot, SESSION_OPTIONS)),
  );
  /** Resolved once per scenario, before its startup events run -- see `GameSession.storyParts`. A resumed save has already been past all of this. */
  let storyParts = $state.raw(initialSave ? [] : session.storyParts());
  let storyAssets = $state.raw(initialStoryAssets);
  /** The live turn limit (`[modify_turns]` can change it); synced with the rest of the session state. */
  // Phase 18: the campaign's own images are searched before core (its [binary_path]).
  $effect.pre(() => {
    const id = campaign?.wesnothId;
    const files = id ? (campaignImages as Record<string, string[]>)[id] : undefined;
    setCampaignImages(id && files ? `campaigns/${id}/images` : null, files ?? []);
  });

  // Phase 19: the campaign's own music is searched before core's, and the audio starts on the
  // first gesture once the board has rendered (browsers refuse earlier; music must not compete
  // with the board's images for bandwidth).
  $effect.pre(() => {
    audio.campaign = campaign?.wesnothId;
  });
  let audioSettings = $state<Readonly<AudioSettings>>(audio.settings);
  let preferencesOpen = $state(false);
  let languageDialogOpen = $state(false);
  function changeAudio(patch: Partial<AudioSettings>): void {
    audio.updateSettings(patch);
    audioSettings = audio.settings;
  }
  $effect(() => {
    let disposed = false;
    const unlock = (): void => audio.unlock();
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    const stopUiSounds = installUiSounds(audio);
    // Sound sources measure from the middle of the viewed map and honour the viewing side's fog and shroud.
    audio.setSourceHost({
      viewCenter: () => boardView?.viewCenterHex() ?? null,
      isFogged: (x, y) => session.board.isFogged(session.viewingSide, new Location(x, y)),
      isShrouded: (x, y) => session.board.isShrouded(session.viewingSide, new Location(x, y)),
    });
    void (async () => {
      await tick();
      while (!boardView && !disposed) await new Promise((resolve) => setTimeout(resolve, 50));
      if (boardView && !disposed) await boardView.whenReady();
      if (!disposed) audio.setBoardReady();
    })();
    return () => {
      disposed = true;
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      stopUiSounds();
      audio.setSourceHost(null);
      audio.stopSoundSources();
    };
  });

  // Sounds the scenario is likely to need -- the frame sounds of every unit type on the board or
  // recruitable, the status, bell and interface sounds -- decoded ahead of use, at idle priority and
  // in small idle-time steps (parsing a type's animations is main-thread work), once the board is up.
  $effect(() => {
    const current = session;
    let cancelled = false;
    const typeIds = new Set<string>();
    for (const unit of current.board.allUnits()) typeIds.add(unit.type.id);
    for (const team of current.board.teams()) for (const id of team.canRecruit) typeIds.add(id);
    const idle = (work: () => void): void => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(work, { timeout: 2000 });
      else setTimeout(work, 50);
    };
    void (async () => {
      await tick();
      while (!boardView && !cancelled) await new Promise((resolve) => setTimeout(resolve, 50));
      if (boardView && !cancelled) await boardView.whenReady();
      if (cancelled) return;
      audio.preloadSounds(Object.values(GAME_SOUNDS));
      // The scenario's own `[sound]`s and sound sources, wherever they sit in its events.
      const named: string[] = [];
      const collect = (node: WmlConfigJson): void => {
        for (const { tag, config } of node.children) {
          if (tag === 'sound' && typeof config.attrs['name'] === 'string') named.push(config.attrs['name']);
          if (tag === 'sound_source' && typeof config.attrs['sounds'] === 'string') named.push(config.attrs['sounds']);
          collect(config);
        }
      };
      collect(activeSnapshot.scenarioConfigJson);
      audio.preloadSounds(named.filter((files) => !files.includes('$')));
      // The time of day's ambient sounds (`[time] sound=`), the scenario's own and its `[time_area]`s'.
      const scenario = WmlConfig.fromJSON(activeSnapshot.scenarioConfigJson);
      audio.preloadSounds(
        [...scenario.children('time'), ...scenario.children('time_area').flatMap((area) => area.children('time'))]
          .map((time) => time.getString('sound', ''))
          .filter((sound) => sound !== ''),
      );
      const queue = [...typeIds];
      const step = (): void => {
        const id = queue.shift();
        if (id === undefined || cancelled) return;
        const cfg = current.rawUnitTypeConfig(id);
        if (cfg) audio.preloadSounds(animationSoundFiles(parseUnitAnimations(WmlConfig.fromJSON(cfg))));
        idle(step);
      };
      idle(step);
    })();
    return () => {
      cancelled = true;
    };
  });

  let scenarioTurnsLimit = $state<number | null>(session.turnLimit);

  let continuing = $state(false);
  let continueError = $state<string | null>(null);
  /** Phase 16 N7: set once the campaign outro has played (or was skipped). */
  let outroDone = $state(false);

  /** Phase 21: the "Do you really want to quit?" question behind Quit to Menu. */
  let quitConfirmOpen = $state(false);
  /** `menu_handler::end_turn`'s "You have not started your turn yet" question is open. */
  let endTurnConfirmOpen = $state(false);
  /**
   * What the other sides' turns are doing after End Turn: the AI computing ('thinking' -- End Turn is greyed
   * out), or their moves being shown ('animating' -- the button becomes Skip Animation). `null` on the
   * player's own turn.
   */
  let otherSidesTurn = $state<'thinking' | 'animating' | null>(null);
  /** Set by Skip Animation: the rest of this batch of the other sides' animations is not played. */
  let skipOtherSidesAnimations = false;
  const turnButton = $derived<'end' | 'wait' | 'skip'>(otherSidesTurn === 'animating' ? 'skip' : otherSidesTurn === 'thinking' ? 'wait' : 'end');

  let phase = $state<'story' | 'objectives' | 'playing' | 'ended' | 'replay'>(
    initialReplaySession ? 'replay' : session.scenarioResult ? 'ended' : storyParts.length > 0 ? 'story' : 'playing',
  );
  /**
   * Phase 21: a campaign is completed by winning its last scenario (`playcampaign.cpp`: victory with no next
   * scenario), recorded per difficulty for the campaign dialog's laurels -- whether or not the credits roll.
   */
  let completionRecorded = false;
  let creditsRequested = false;
  $effect(() => {
    if (phase !== 'ended' || completionRecorded || !campaign) return;
    if (session.scenarioResult !== 'victory' || session.nextScenarioId !== null) return;
    completionRecorded = true;
    void markCampaignCompleted(campaign.id, activeSnapshot.difficulty ?? '').catch((err) => console.error('[menu] could not record completion:', err));
  });
  /**
   * The campaign's credits for the outro, from `credits.json` (the same data as the title screen's credits, with
   * translatable section titles). Fetched when the outro is first due; a campaign with none (a debug one) gets
   * just its end text.
   */
  let creditsData = $state.raw<CreditsJson | null>(null);
  const outroCredits = $derived(creditsData ? campaignCredits(creditsData, campaign?.wesnothId, (s) => ts(s)) : undefined);
  $effect(() => {
    if (!showOutro || creditsRequested) return;
    creditsRequested = true;
    fetch(dataUrl('credits.json'))
      .then((res) => (res.ok ? (res.json() as Promise<CreditsJson>) : null))
      .then((json) => (creditsData = json))
      .catch((err) => console.error('[outro] could not load credits.json:', err));
  });
  /** Upstream shows the outro only for a victory with no next scenario, and only when `end_credits` is not turned off. */
  const showOutro = $derived(
    phase === 'ended' &&
      session.scenarioResult === 'victory' &&
      session.nextScenarioId === null &&
      session.endLevelPresentation?.endCredits !== false &&
      !outroDone,
  );
  /**
   * Phase 17: the one `[message]` a suspended event is waiting on, if
   * any. Nothing else about the game advances while this is set -- the
   * event itself is parked inside `GameSession`, holding the promise
   * `answerInteraction` resolves.
   */
  let currentMessage = $state<MessageInteraction | null>(null);
  let answerInteraction: ((result: InteractionResult) => void) | null = null;
  /** True while a WML flow is being driven (dialogue, a cutscene, an AI turn): the board is the engine's, not the player's. */
  let eventsRunning = $state(false);
  /** `[color_adjust]`/`[screen_fade]`: a CSS overlay over the whole shell. */
  let screenTint = $state<{ r: number; g: number; b: number; a: number; ms: number } | null>(null);

  let units = $state<SnapshotUnit[]>(session.renderUnits);
  let selected = $state<SelectedUnitInfo | null>(null);
  /** The currently-inspected unit's view-model (see `GameSession.inspectedUnit`) -- any unit clicked purely to view its info, independent of `selected`. */
  let inspected = $state<SelectedUnitInfo | null>(null);
  let selectedHex = $state<HexPoint | null>(null);
  /** The hex of the unit speaking the `[message]` on screen, shown as selected meanwhile (bugs6.md; see the speaker `$effect`). */
  let speakerHex = $state<HexPoint | null>(null);
  let reachable = $state<ReachableHexPoint[]>([]);
  let attackTargets = $state<HexPoint[]>([]);
  /** Feeds the context menu's "is this hex a valid recruit/recall target" check -- selection-independent, see `GameSession.recruitTiles`'s own doc comment. There is no board highlight for these: real Wesnoth has none (bugs6.md). */
  let recruitTiles = $state<HexPoint[]>([]);
  let recruitOptions = $state<RecruitOption[]>([]);
  let pendingRecruitTypeId = $state<string | null>(null);
  let recallOptions = $state<RecallOption[]>([]);
  let pendingRecallIndex = $state<number | null>(null);
  let pendingPreview = $state<CombatPreview | null>(null);
  let pendingAdvancement = $state<PendingAdvancement | null>(null);
  /** Phase 13: whether the real modal Recruit/Recall dialogs are open -- opened via `SidePanel`'s "Recruit.../Recall..." trigger, distinct from `pendingRecruitTypeId`/`pendingRecallIndex` (the ARMED, awaiting-a-tile-click state that persists after the dialog closes). */
  let recruitDialogOpen = $state(false);
  let recallDialogOpen = $state(false);
  /** Phase 14: real Wesnoth's Actions menu "Objectives" entry -- reopens the same `ObjectivesDialog` the scenario shows automatically at start, on demand, independent of the `phase` state machine (which only ever shows it once, at the right moment in the startup sequence). */
  let objectivesDialogOpen = $state(false);
  /** Phase 26: the save manager (`gui/dialogs/game_save.cpp`/`game_load.cpp`). */
  let saveDialogOpen = $state(false);
  let loadDialogOpen = $state(false);
  let savesList = $state<SaveMeta[]>([]);
  /** A download/upload is in flight -- the list stays up but its actions are inert. */
  let saveBusy = $state(false);
  let attackerWeaponOptions = $state<AttackerWeaponOption[]>([]);
  let log = $state<string[]>([]);
  /** Phase 18b: whether Undo/Redo are available -- mirrors `session.canUndo`/`canRedo`, refreshed by `sync`. */
  let canUndo = $state(false);
  let canRedo = $state(false);
  let turnNumber = $state(session.turnNumber);

  // Unit images in the side panel and dialogs are team-coloured like the board's (see unitImageRef.ts).
  $effect(() => {
    const defaults = teamColors?.defaultColors ?? [];
    setSideColorResolver((side) => {
      const s = side ?? session.activeSide;
      return resolveSideColorId(session.board.getTeam(s)?.color ?? '', s, defaults);
    });
    return () => setSideColorResolver(null);
  });

  // Phase 28 S6: where the player is, for error reports (read only when a report is built).
  $effect(() => {
    setGameContext(() => ({
      campaignId: campaign?.id,
      scenarioId: activeSnapshot.scenario.id,
      scenarioName: session.scenarioName,
      turn: session.turnNumber,
      saveData: () => session.toSaveData(),
    }));
    return () => setGameContext(null);
  });
  let activeSide = $state(session.activeSide);
  let gold = $state(session.board.getTeam(session.activeSide)?.gold ?? 0);
  let economyInfo = $state<EconomyInfo>(session.economyInfo);
  let villageOwners = $state<VillageOwnerInfo[]>(session.villageOwnership);
  let hexVisibility = $state<HexVisibilityPoint[]>(session.hexVisibility);
  let terrainHexes = $state(session.terrainHexes);
  let mapItems = $state(session.mapItems);
  let mapLabels = $state(session.mapLabels);
  let timeOfDay = $state<TimeOfDayEntry>(session.currentTimeOfDay);
  let statusMessage = $state(tx('Click one of your units to select it.'));
  /** Phase 14: the infobox's "terrain info for the hovered hex" -- kept in sync by `GameBoardView`'s `onHexHoverChange`. */
  let hoveredHexInfo = $state<HoveredHexInfo | null>(null);
  /** What a screen reader says about the hex under the keyboard cursor; `describeHex`, updated as the cursor moves. */
  let cursorAnnouncement = $state('');
  /** Phase 14: the right-click context menu's position + which hex it's for, `null` when closed. */
  let contextMenuAt = $state<{ x: number; y: number; clientX: number; clientY: number } | null>(null);
  /** Phase 18: the "Place Label" dialog's hex and initial state, `null` when closed. */
  let labelDialog = $state<{ hex: HexPoint; text: string; teamOnly: boolean } | null>(null);
  let clearLabelsConfirmOpen = $state(false);
  let labelSettingsOpen = $state(false);
  /** The last hex the pointer was over -- where the label hotkeys act, as upstream's `get_last_hex`. */
  let lastHoveredHex: HexPoint | null = null;
  /**
   * Real, reported bug (bugs4.md #5): the hex a Recruit/Recall dialog was
   * opened FROM, when opened by right-clicking a specific empty castle
   * tile -- `handleConfirmRecruit`/`handleConfirmRecall` place the chosen
   * unit there directly instead of arming a pending choice and making the
   * player click the (already-known) tile a second time. `null` when the
   * dialog was opened from the top bar's Actions menu instead (no single
   * origin hex to prefer -- falls back to the old arm-then-click flow).
   */
  let recruitOriginHex = $state<HexPoint | null>(null);

  function selectedInfo(): SelectedUnitInfo | null {
    const u = session.selectedUnit;
    return u ? session.unitInfo(u) : null;
  }

  /** `null` when nothing's inspected, or when the inspected unit is the same one `selected` already shows (avoids rendering the same unit's info twice). */
  function inspectedInfo(): SelectedUnitInfo | null {
    const u = session.inspectedUnit;
    if (!u || u === session.selectedUnit) return null;
    return session.unitInfo(u);
  }

  /**
   * Re-derives only the selection/highlight views -- deliberately NOT
   * `units`, so this is safe to call while an animation is playing.
   * (`SnapshotBoard.updateUnits` snaps every sprite to its target hex and
   * must not race `playAnimations`; that race is what used to wedge a
   * scenario mid-cutscene, see this file's `playCutsceneBeat`.)
   *
   * Used before a `moveUnit` beat so the walking unit's reach overlay and
   * selection ring are gone *before* it starts walking, as upstream does
   * (`mouse_handler::move_unit_along_current_route` clears the route, the
   * reach highlight and the selected hex before the animation).
   */
  function syncHighlights(): void {
    selected = selectedInfo();
    inspected = inspectedInfo();
    selectedHex = speakerHex ?? (session.selectedUnit ? { x: session.selectedUnit.location.x, y: session.selectedUnit.location.y } : null);
    reachable = session.reachable;
    attackTargets = session.attackCandidates.map((u) => ({ x: u.location.x, y: u.location.y }));
    // "do not show footsteps during movement"
    route = null;
    attackIndicator = null;
    hoverReach = null;
  }

  /** Re-derives every `$state` view from `session`'s current (just-mutated) state. Call after every session mutation. */
  /**
   * `story_viewer::display_part`: a part's `music=` replaces the playlist and switches at once, its
   * `sound=` plays, and its `voice=` speaks as sound source 255 (the previous voice is cut off).
   */
  function playStoryPartSounds(part: { music: string; sound: string; voice: string }): void {
    playStoryMusic(session.music, part.music);
    if (part.sound !== '') audio.playSound({ files: part.sound, repeats: 0, group: 'sound' });
    audio.stopSource('voice');
    if (part.voice !== '') audio.playSound({ files: part.voice, repeats: 0, group: 'sources', sourceId: 'voice' });
  }

  /** The unit whose selection last made a sound. */
  let lastSelectedForSound: object | null = null;

  /** The side panel's status line for the current state (a one-off `message` from an action wins). */
  function statusFor(message?: string | null): string {
    if (session.scenarioResult) return session.scenarioResult === 'victory' ? tx('Victory!') : tx('Defeat.');
    if (message) return message;
    if (pendingPreview) return tx('Review the attack prediction, then confirm or cancel.');
    if (pendingRecruitTypeId) return tx('Click a free castle tile to place your recruit.');
    if (pendingRecallIndex !== null) return tx('Click a free castle tile to place your recalled unit.');
    if (selected) return fmt(tx('$unit selected.'), { unit: selected.name });
    return tx('Click one of your units to select it.');
  }

  /**
   * After a language switch: re-reads every view of the game that holds text (unit and type names, weapon and
   * trait names, terrain, time of day, the status line), from a session that still holds the untranslated strings.
   * Deliberately not `sync()`: nothing else changed, and `sync` restarts sprite positions mid-animation.
   */
  function refreshTexts(): void {
    selected = selectedInfo();
    inspected = inspectedInfo();
    recruitOptions = session.recruitOptions;
    recallOptions = session.recallOptions;
    timeOfDay = session.currentTimeOfDay;
    hoveredHexInfo = hoveredHexInfo ? session.hoveredHexInfo(hoveredHexInfo.x, hoveredHexInfo.y) : null;
    statusMessage = statusFor();
  }

  // Phase 20: the orb colours are a preference; the renderer redraws the orbs on the next `sync`.
  let orbsApplied = false;
  $effect(() => {
    const colors = accessibility.current.orbColors;
    setOrbColorIds(colors);
    if (orbsApplied) untrack(sync);
    orbsApplied = true;
  });

  let lastLanguage = locale.current;
  $effect(() => {
    const language = locale.current;
    if (language === lastLanguage) return;
    lastLanguage = language;
    untrack(refreshTexts);
  });

  function sync(message?: string | null): void {
    // `mouse_events`: selecting one of your own units clicks (`select-unit.wav`, the UI group).
    const selectedUnit = session.selectedUnit;
    if (selectedUnit && selectedUnit !== lastSelectedForSound && selectedUnit.side === session.viewingSide && phase === 'playing') {
      audio.playUi(GAME_SOUNDS.selectUnit);
    }
    lastSelectedForSound = selectedUnit ?? null;
    audio.setSoundSources(session.soundSources);
    units = session.renderUnits;
    selected = selectedInfo();
    inspected = inspectedInfo();
    selectedHex = speakerHex ?? (session.selectedUnit ? { x: session.selectedUnit.location.x, y: session.selectedUnit.location.y } : null);
    reachable = session.reachable;
    attackTargets = session.attackCandidates.map((u) => ({ x: u.location.x, y: u.location.y }));
    recruitTiles = session.recruitTiles;
    recruitOptions = session.recruitOptions;
    pendingRecruitTypeId = session.pendingRecruitTypeId;
    recallOptions = session.recallOptions;
    pendingRecallIndex = session.pendingRecallIndex;
    pendingPreview = session.pendingAttack?.preview ?? null;
    pendingAdvancement = session.pendingAdvancement;
    attackerWeaponOptions = session.attackerWeaponOptions;
    log = session.log;
    canUndo = session.canUndo;
    canRedo = session.canRedo;
    turnNumber = session.turnNumber;
    scenarioTurnsLimit = session.turnLimit;
    activeSide = session.activeSide;
    gold = session.board.getTeam(session.activeSide)?.gold ?? 0;
    economyInfo = session.economyInfo;
    villageOwners = session.villageOwnership;
    hexVisibility = session.hexVisibility;
    terrainHexes = session.terrainHexes;
    mapItems = session.mapItems;
    mapLabels = session.mapLabels;
    timeOfDay = session.currentTimeOfDay;
    refreshMinimap();
    armedMove = null;

    statusMessage = statusFor(message);

    // Latches once `session.checkForGameEnd()` (run after any kill --
    // see `confirmAttack`) sets a result; `phase` only ever moves forward
    // to 'ended' from here, never back (scenarioResult itself never
    // un-latches either -- see GameSession's own doc comment).
    // Only from normal play: a scenario that ends during its own startup events (an epilogue's
    // start-event [endlevel]) must still show its story, objectives and dialogue first --
    // `runStartupEvents`/`advanceObjectives` move on to 'ended' once those are done.
    if (session.scenarioResult && phase === 'playing') phase = 'ended';
    updateMovementPreview();
  }

  /**
   * Phase 17: `GameSession`'s window onto the display. A `[message]`
   * parks here until the player dismisses it (or picks an option); a
   * cutscene beat is played out and the event resumes when the animation
   * finishes. Either way the WML event is genuinely suspended in the
   * meantime, which is what upstream gets for free by running its dialog
   * on the same stack as the event pump.
   */
  const interactionHost: InteractionHost = {
    handle(interaction) {
      // A beat is animated FROM the board as it currently stands, so it
      // must not be re-synced first: `SnapshotBoard.updateUnits` snaps
      // every sprite straight to its target hex, which would both cut the
      // animation short and race the frame loop driving it (see that
      // method's own doc comment). `playCutsceneBeat` syncs when it's done.
      if (interaction.kind === 'beat') return playCutsceneBeat(interaction.beat);
      // A message, though, must show the state the event has reached
      // *now*, not the state it will have when the event finishes -- the
      // whole point of blocking dialogue (bugs2.md, fixed properly here).
      sync();
      return scrollToSpeaker(interaction).then(
        () =>
          new Promise<InteractionResult>((resolve) => {
            currentMessage = interaction;
            answerInteraction = resolve;
          }),
      );
    },
  };
  session.interactionHost = interactionHost;

  /**
   * Phase 22: message.lua's `scroll_to_hex(loc, true, false, true)` -- an
   * ONSCREEN glide to the speaker, skipped if the viewing side can't see
   * the hex (`check_fogged`), finished before the dialog opens.
   */
  async function scrollToSpeaker(interaction: MessageInteraction): Promise<void> {
    const at = interaction.message.speakerLocation;
    if (!at || !interaction.message.scroll || !interaction.message.highlight) return;
    if (visibleHexes([at]).length === 0) return;
    await boardView?.scrollToHexIfOffscreen(at.x, at.y);
  }

  /** `display::fogged`, for `check_fogged` scrolls: the hexes the viewing side can see (not fogged or shrouded). */
  function visibleHexes<T extends { x: number; y: number }>(hexes: readonly T[]): T[] {
    const side = session.viewingSide;
    return hexes.filter((h) => {
      const loc = new Location(h.x, h.y);
      return !session.board.isFogged(side, loc) && !session.board.isShrouded(side, loc);
    });
  }

  /**
   * Phase 22: `unit_display`'s "follow the action" scrolls -- ONSCREEN,
   * unforced (so `[lock_view]` and the "follow unit actions" preference
   * turn them off), only over hexes the viewing side can see. Each waits
   * for the camera before the animation it precedes, as upstream's
   * blocking scroll does.
   */
  function followAction(hexes: readonly { x: number; y: number }[], options: { addSpacing?: number; onlyIfPossible?: boolean } = {}): Promise<void> {
    return boardView?.scrollToHexes(visibleHexes(hexes), { type: 'onscreen', force: false, ...options }) ?? Promise.resolve();
  }

  /**
   * `unit_mover::start`: the whole path if it fits on screen, else (the
   * per-step scroll `proceed_to` falls back on) as much of it from the
   * start as fits.
   */
  async function followMove(path: readonly { x: number; y: number }[]): Promise<void> {
    if (!boardView) return;
    const before = boardView.viewState()?.view;
    await followAction(path, { onlyIfPossible: true });
    const after = boardView.viewState()?.view;
    if (before && after && before.x === after.x && before.y === after.y) await followAction(path);
  }

  /** `unit_attack`: both fighters, with at least half a hex around them. */
  function followAttack(a: { x: number; y: number }, b: { x: number; y: number }): Promise<void> {
    return followAction([a, b], { addSpacing: 0.5 });
  }

  /** The player answered the message on screen (dismissed it, chose an option, typed something). */
  function answerMessage(result: InteractionResult): void {
    const resolve = answerInteraction;
    currentMessage = null;
    answerInteraction = null;
    resolve?.(result);
  }

  /**
   * Plays one cutscene beat, resolving when the display is done with it.
   *
   * Deliberately does NOT sync the board afterwards. Real, reported bug
   * ("the Skeleton jumps back and forth between hexes before settling"):
   * `[move_unit]` animates the walk and only *then* relocates the unit
   * (upstream's own `move_unit.lua` order), so a sync straight after the
   * beat re-renders the unit at the hex it started from -- the sprite
   * arrived, snapped back, and only reached its destination at the next
   * sync. The animation leaves every sprite where the engine is about to
   * put it; the sync before the next message reconciles the rest.
   *
   * Everything here is guarded, because the event that yielded the beat
   * is suspended until this resolves: a renderer error, or an animation
   * whose frames never finish resolving, would otherwise wedge the
   * scenario with no dialogue and no way forward. A beat that overruns
   * is abandoned (the state it stands for has already been applied) and
   * the event carries on.
   */
  async function playCutsceneBeat(beat: CutsceneBeat): Promise<InteractionResult> {
    const started = performance.now();
    try {
      await capped(playBeatBody(beat));
    } catch (err) {
      console.error('[cutscene] beat failed, continuing:', beat.kind, err);
    }
    // Dev-only timing (same `import.meta.env` cast as the `__wesnoth`
    // debug hook below -- this package has no `vite/client` types): a
    // beat that blocks for seconds on a cold image cache is the single
    // most useful number when a cutscene feels stuck.
    if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
      console.info(`[cutscene] ${beat.kind} took ${Math.round(performance.now() - started)}ms`);
    }
    return {};
  }

  /** Resolves when `work` does, or after `MAX_BEAT_MS` -- whichever comes first. */
  function capped(work: Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, MAX_BEAT_MS);
      work.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (err) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  async function playBeatBody(beat: CutsceneBeat): Promise<void> {
    switch (beat.kind) {
      case 'delay':
        await new Promise((r) => setTimeout(r, Math.min(beat.ms, MAX_BEAT_MS)));
        break;
      case 'scrollTo':
        // wesnoth.interface.scroll_to_hex: only_if_needed picks ONSCREEN, immediate the WARP variant; the
        // event waits for the camera to arrive, as upstream's blocking scroll does.
        await boardView?.scrollToHex(
          beat.location.x,
          beat.location.y,
          beat.onlyIfNeeded ? (beat.immediate ? 'onscreen-warp' : 'onscreen') : beat.immediate ? 'warp' : 'scroll',
        );
        break;
      case 'scrollBy':
        boardView?.scrollByPixels(beat.dx, beat.dy);
        break;
      case 'lockView':
        boardView?.setViewLocked(beat.locked);
        break;
      case 'zoom':
        if (beat.relative) boardView?.zoomBy(beat.factor);
        else boardView?.zoomTo(beat.factor);
        break;
      case 'colorAdjust':
        // An instant tint, held until something sets it back to 0,0,0.
        screenTint =
          beat.red === 0 && beat.green === 0 && beat.blue === 0
            ? null
            : { r: Math.max(0, beat.red), g: Math.max(0, beat.green), b: Math.max(0, beat.blue), a: Math.min(1, Math.abs(beat.red + beat.green + beat.blue) / 765), ms: 0 };
        break;
      case 'screenFade':
        screenTint = beat.alpha <= 0 ? null : { r: beat.red, g: beat.green, b: beat.blue, a: beat.alpha / 255, ms: Math.min(beat.durationMs, MAX_BEAT_MS) };
        await new Promise((r) => setTimeout(r, Math.min(beat.durationMs, MAX_BEAT_MS)));
        break;
      case 'moveUnit':
        // The mover has already been deselected by the session; push that
        // to the board before it starts walking so its reach overlay and
        // selection ring don't follow it around (upstream clears both up
        // front -- see `syncHighlights`).
        syncHighlights();
        await followMove(beat.path);
        if (boardView) await boardView.playAnimationSequence(buildMoveAnimationCues({ unit: beat.unit, path: beat.path }));
        break;
      case 'moveFakeUnits':
        await playFakeWalks(beat.walks);
        break;
      case 'animateUnit':
        if (boardView) await boardView.playAnimationSequence(buildFlagAnimationCues(beat.unit, beat.flag), 1);
        break;
      case 'unitDeath':
        if (boardView) {
          if (beat.scroll) await boardView.scrollToHexIfOffscreen(beat.unit.location.x, beat.unit.location.y);
          await boardView.playAnimationSequence(buildFlagAnimationCues(beat.unit, 'death'), 1);
        }
        break;
      case 'unitAppear':
        if (boardView) {
          // The new unit has no visual until the next sync(), so give it
          // one first (bugs5.md #3) -- otherwise its own cue does nothing.
          await boardView.ensureUnitVisual(session.snapshotUnitFor(beat.unit), { hidden: true });
          await followAction(beat.by ? [beat.unit.location, beat.by.location] : [beat.unit.location]);
          await boardView.playAnimationSequence(
            beat.by
              ? buildRecruitAnimationCues({ unit: beat.unit, leader: beat.by, unitLocation: beat.unit.location, leaderLocation: beat.by.location })
              : buildFlagAnimationCues(beat.unit, 'recruited'),
          );
        }
        break;
    }
  }

  /**
   * A cap on how long one beat may hold the game: real content asks for
   * pauses of a few hundred ms, but a scenario with a badly-tuned
   * `[delay]` (or a long `[screen_fade]`) should not be able to lock the
   * UI for minutes on end.
   */
  const MAX_BEAT_MS = 4000;

  /** One unit, one named animation, in place -- `[animate_unit] flag=`, a death, a plain appearance. */
  function buildFlagAnimationCues(unit: Unit, flag: string): UnitAnimationCue[][] {
    const context: AnimationContext = {
      loc: unit.location,
      secondLoc: unit.location,
      myUnit: unit,
      event: flag,
      value: 0,
      value2: 0,
      hit: 'invalid',
      terrainAtLoc: terrainLookup(session.board)(unit.location),
    };
    return [
      [
        {
          key: spriteKey({ underlyingId: session.renderKeyFor(unit), typeId: unit.type.id, x: unit.location.x, y: unit.location.y }),
          anim: chooseAnimation(animationsFor(unit.type.id), context),
          direction: unit.facing,
          srcHex: { x: unit.location.x, y: unit.location.y },
          dstHex: { x: unit.location.x, y: unit.location.y },
        },
      ],
    ];
  }

  /**
   * The throwaway sprite a `[move_unit_fake]` walks. Negative
   * `underlyingId`s keep its `spriteKey` clear of every real unit's (see
   * `spriteKey`), so removing it afterwards can't take a real unit's
   * visual with it.
   */
  function fakeUnitSnapshot(walk: FakeUnitWalk, index: number): SnapshotUnit {
    const start = walk.path[0]!;
    const typeSnapshot = activeSnapshot.unitTypes[walk.spec.typeId];
    return {
      id: null,
      name: null,
      typeId: walk.spec.typeId,
      image: typeSnapshot?.image ?? null,
      side: walk.spec.side,
      x: start.x,
      y: start.y,
      canRecruit: false,
      hitpoints: 1,
      maxHitpoints: 1,
      flagRgb: typeSnapshot?.flagRgb,
      underlyingId: -1 - index,
    };
  }

  /**
   * `[move_unit_fake]`: sprites that exist only for the animation. Each
   * is added to the board as a throwaway visual, walked along its path,
   * and removed again -- upstream's `create_fake_unit`/`fake_unit_ptr`.
   */
  async function playFakeWalks(walks: readonly FakeUnitWalk[]): Promise<void> {
    if (!boardView) return;
    const visuals = walks.map((walk, i) => ({ walk, snapshot: fakeUnitSnapshot(walk, i) }));
    for (const { snapshot } of visuals) await boardView.ensureUnitVisual(snapshot);
    // Lock-step, one hex at a time, so several fake units travel together
    // (`[move_units_fake]`); a shorter path simply has nothing to do on
    // the later steps.
    const longest = Math.max(...visuals.map((v) => v.walk.path.length));
    for (let step = 1; step < longest; step++) {
      const cues: UnitAnimationCue[] = [];
      for (const { walk, snapshot } of visuals) {
        const from = walk.path[step - 1];
        const to = walk.path[step];
        if (!from || !to) continue;
        const context = buildMovementAnimationContext(walk.unit, from, to, terrainLookup(session.board));
        cues.push({
          key: spriteKey(snapshot),
          anim: chooseAnimation(animationsFor(walk.spec.typeId), context),
          direction: directionBetween(from, to) ?? Direction.SouthEast,
          srcHex: { x: from.x, y: from.y },
          dstHex: { x: to.x, y: to.y },
          restAt: 'dst' as const,
          // One hex on the per-hex clock, as a real move (see buildMoveAnimationCues).
          legs: [{ srcHex: { x: from.x, y: from.y }, dstHex: { x: to.x, y: to.y }, direction: directionBetween(from, to) ?? Direction.SouthEast }],
        });
      }
      if (cues.length > 0) await boardView.playAnimationSequence([cues]);
    }
    for (const { snapshot } of visuals) boardView.removeUnitVisual(spriteKey(snapshot));
  }

  /**
   * Real, reported bug (bugs3.md "objectives dialog"): a scenario's real
   * `[objectives]` (see `GameSession.scenarioObjectives`'s own doc
   * comment) used to have no dialog to show it in at all. It comes after
   * the startup events now, because those show their own dialogue as
   * they run rather than afterwards.
   */
  function advanceObjectives(): void {
    phase = session.scenarioResult ? 'ended' : 'playing';
  }

  // No story: run the startup events immediately, so the board and side
  // panel reflect the real event-spawned units from the first render.
  // A resumed save skips them -- they already ran in the game that was
  // saved, and re-running `prestart`/`start` would spawn its units a
  // second time on top of the ones the save just restored.
  if (storyParts.length === 0 && !initialSave) {
    void runStartupEvents();
  }

  if (initialReplaySession) {
    void beginInitialReplay();
  } else if (startInReplay && initialSave) {
    // Asked to open straight into replay, but this save predates replay recording -- fall back to the
    // normal resume above and say why, same message `startReplay`'s own guard shows mid-game.
    sync('This save has no replay to show (it was made before replays were recorded).');
  }

  /**
   * Waits for the board to finish its first render (bugs6.md): the opening
   * dialogue used to start while the map was still loading, so the units it
   * scrolls to and names were not on screen yet. Callers hold
   * `eventsRunning`, which keeps input blocked meanwhile. The `tick` first
   * lets a scenario transition's `{#key}` remount bind the new board.
   */
  async function boardReady(): Promise<void> {
    await tick();
    while (!boardView) await new Promise((resolve) => setTimeout(resolve, 50));
    await boardView.whenReady();
  }

  /** Runs the scenario's `prestart`/`start` events, showing their dialogue and cutscenes as they happen. */
  async function runStartupEvents(): Promise<void> {
    eventsRunning = true;
    try {
      await boardReady();
      await session.runStartupEvents();
    } finally {
      eventsRunning = false;
    }
    sync();
    await showDeferredInteractions();
    if (phase !== 'ended') phase = session.takeObjectivesChanged() ? 'objectives' : session.scenarioResult ? 'ended' : 'playing';
    // Upstream's start-of-scenario save (`scenariostart_savegame`), which
    // is what lets a campaign be restarted from any scenario it reached
    // rather than only from the turn you last played.
    await autosave('scenario-start');
  }

  /**
   * Shows whatever an AI side's own events (or the attack choreography's
   * nested `last breath`/`die`) had to say. Those run where the flow
   * cannot stop for the player -- see
   * `GameSession.takeDeferredInteractions` -- so their dialogue lands
   * here, after the animations, exactly as all dialogue did before
   * Phase 17.
   */
  async function showDeferredInteractions(): Promise<void> {
    for (const interaction of session.takeDeferredInteractions()) {
      if (interaction.kind !== 'message') continue;
      await scrollToSpeaker(interaction);
      await new Promise<void>((resolve) => {
        currentMessage = interaction;
        answerInteraction = () => resolve();
      });
    }
    sync();
  }

  /**
   * Phase 23: the hex a finger has chosen for the selected unit's move, waiting for the confirming
   * second tap. The mouse moves on the first click, as upstream's; a finger can't hover to see where
   * it is about to go, so the first tap only marks the hex (shown as the cursor). Cleared by any
   * change to the game (`sync`) and by a tap anywhere else.
   */
  let armedMove = $state<HexPoint | null>(null);

  /**
   * `GameBoardView`'s `onHexClick`: a finger's tap on a move destination asks for a second tap first.
   * Phase 28b: a click on an enemy attacks it from the hex `attackFrom` picks -- the side the mouse came
   * from -- or, for a finger, the hex it tapped first, moving there first when that isn't the unit's own.
   */
  function handleBoardHexClick(x: number, y: number, input?: { touch: boolean }): void {
    const armed = armedMove;
    armedMove = null;
    if (input?.touch && canAct() && isPlainMoveTarget(x, y) && !(armed && armed.x === x && armed.y === y)) {
      armedMove = { x, y };
      hoveredHexInfo = session.hoveredHexInfo(x, y);
      statusMessage = tx('Tap again to move here.');
      updateMovementPreview();
      return;
    }
    const attackFrom = input?.touch ? armed : session.attackFrom({ x, y }, previousHex, previousFreeHex);
    void handleHexClick(x, y, { attackFrom });
  }

  /**
   * A hex the selected unit can be ordered to with nothing (visible) standing on it, and no
   * recruit/recall/attack waiting: one it reaches this turn, or (Phase 28b) any it has a route to.
   */
  function isPlainMoveTarget(x: number, y: number): boolean {
    const unit = session.selectedUnit;
    if (!unit || pendingRecruitTypeId || pendingRecallIndex !== null || pendingPreview) return false;
    if (units.some((u) => u.x === x && u.y === y)) return false;
    if (reachable.some((h) => h.x === x && h.y === y)) return true;
    return unit.side === session.activeSide && session.routePreview(x, y) !== null;
  }

  /**
   * Phase 28b: what the board shows of the order the pointer is about to give (`mouse_handler::
   * mouse_motion`): the footsteps to the hovered hex, or to the hex a click on the hovered enemy would
   * attack it from, with the attack direction indicator; with nothing selected, the reach of the unit
   * under the pointer and the route of its standing order. A finger's picked hex shows its route.
   */
  let route = $state.raw<RouteOverlay | null>(null);
  let attackIndicator = $state.raw<{ src: HexPoint; dst: HexPoint } | null>(null);
  let hoverReach = $state.raw<ReachableHexPoint[] | null>(null);
  /** The hex the mouse (or the keyboard cursor) is on. */
  let pointerHex: HexPoint | null = null;
  /** `mouse_handler::previous_hex_`/`previous_free_hex_`: the last hex it left, and the last one without a unit (or with the selected one). */
  let previousHex: HexPoint | null = null;
  let previousFreeHex: HexPoint | null = null;

  function pointerMovedTo(hex: HexPoint | null): void {
    const last = pointerHex;
    if (hex && last && (hex.x !== last.x || hex.y !== last.y)) {
      previousHex = last;
      const sel = session.selectedUnit;
      const selectedThere = !!sel && sel.location.x === last.x && sel.location.y === last.y;
      if (selectedThere || !units.some((u) => u.x === last.x && u.y === last.y)) previousFreeHex = last;
    }
    pointerHex = hex;
    updateMovementPreview();
  }

  function updateMovementPreview(): void {
    canContinueMove = pointerHex ? session.canContinueMove(pointerHex.x, pointerHex.y) : session.canContinueMove();
    route = null;
    attackIndicator = null;
    hoverReach = null;
    // Nothing while the player can't act, or while "show enemy moves" owns the reach display.
    if (!canAct() || enemyReach || pendingRecruitTypeId || pendingRecallIndex !== null) return;
    const pending = session.pendingAttack;
    if (pending) {
      route = session.routePreview(pending.from.x, pending.from.y);
      attackIndicator = { src: { x: pending.from.x, y: pending.from.y }, dst: { x: pending.defender.location.x, y: pending.defender.location.y } };
      return;
    }
    if (armedMove) {
      route = session.routePreview(armedMove.x, armedMove.y);
      return;
    }
    const hex = pointerHex;
    if (!hex) return;
    const from = session.attackFrom(hex, previousHex, previousFreeHex);
    if (from) attackIndicator = { src: from, dst: hex };
    const dest = from ?? hex;
    route = session.routePreview(dest.x, dest.y);
    const hover = session.hoverPreview(hex.x, hex.y);
    if (hover) {
      hoverReach = hover.reach;
      route = hover.route;
    }
  }

  async function handleHexClick(x: number, y: number, options: HexClickOptions = {}): Promise<void> {
    if (!canAct()) return;
    clearEnemyMoves();
    // Phase 17: the walk and the new recruit's appearance are cutscene
    // beats yielded by the click's own flow (see
    // `GameSession.moveSelectedTo`), so they play at the point the WML
    // reaches them -- before whatever the `moveto`/`recruit` events they
    // trigger have to say, not after the click has fully resolved.
    const message = await runPlayerAction(() => session.handleHexClick(x, y, options));
    sync(message);
  }

  /** Whether "Continue Move" has a unit to move: the selected one, or the one under the pointer. */
  let canContinueMove = $state(false);

  /** `menu_handler::continue_move`: the unit at `hex` (or the selected one) walks on after sighting units stopped it. */
  async function handleContinueMove(hex: HexPoint | null): Promise<void> {
    if (!canAct()) return;
    clearEnemyMoves();
    const message = await runPlayerAction(() => session.continueMove(hex?.x, hex?.y));
    if (message === null) return;
    sync(message);
    await showDeferredInteractions();
  }

  /**
   * Phase 28b: `play_human_turn`'s `execute_gotos` -- as the player's turn begins, units with a standing
   * order (a multi-turn move) walk on towards it.
   */
  async function continueStandingOrders(): Promise<void> {
    // The "Disable automatic moves" preference (`disable_auto_moves`).
    if (!canAct() || displayPrefs.value.disableAutoMoves) return;
    const message = await runPlayerAction(() => session.executeGotos());
    if (message === null) return;
    sync(message);
    await showDeferredInteractions();
  }

  /**
   * Phase 18b: undoes the last undoable action (upstream's `u`). A move
   * walks back along its route, as upstream animates it; everything else
   * simply reappears as it was.
   */
  async function handleUndo(): Promise<void> {
    if (!canAct() || !session.canUndo) return;
    const message = await runPlayerAction(async () => {
      const text = session.undo();
      const walk = session.lastUndoneWalk;
      session.lastUndoneWalk = null;
      if (walk && walk.path.length > 1) await playCutsceneBeat({ kind: 'moveUnit', unit: walk.unit, path: walk.path });
      return text;
    });
    sync(message);
  }

  /** Phase 18b: redoes the last undone action (upstream's `r`) -- it runs again, with the same recorded outcome. */
  async function handleRedo(): Promise<void> {
    if (!canAct() || !session.canRedo) return;
    const message = await runPlayerAction(() => session.redo());
    sync(message);
  }

  /**
   * Runs one player-initiated action, keeping the board's own input out
   * of the way while the events it triggers play out, and showing
   * anything they deferred (an AI reply's dialogue, a death's) once the
   * animations are done.
   */
  async function runPlayerAction<T>(action: () => Promise<T>): Promise<T> {
    eventsRunning = true;
    try {
      return await action();
    } finally {
      eventsRunning = false;
    }
  }

  /** True when the player may act: their own turn, no dialog up, no event mid-flight. */
  function canAct(): boolean {
    return phase === 'playing' && !eventsRunning && currentMessage === null;
  }

  /** `GameBoardView`'s `onHexHoverChange` -- keeps the infobox's hovered-hex terrain section live. */
  function handleHexHoverChange(hex: HexPoint | null, input?: { touch: boolean }): void {
    // "A single pixel move would remove the enemy movement highlights" -- a move to another hex does.
    if (enemyReach && hex && (enemyReach.shownAt === null || hex.x !== enemyReach.shownAt.x || hex.y !== enemyReach.shownAt.y)) clearEnemyMoves();
    hoveredHexInfo = hex ? session.hoveredHexInfo(hex.x, hex.y) : null;
    if (hex) lastHoveredHex = hex;
    // A finger dragging the map isn't pointing anywhere.
    if (!input?.touch) pointerMovedTo(hex);
  }

  /** `menu_handler::label_terrain`: opens the label dialog on `hex`, with its current label if any. */
  function openLabelDialog(hex: HexPoint | null, teamOnly: boolean): void {
    if (!hex) return;
    const current = session.labelAt(hex);
    labelDialog = { hex, text: current?.text ?? '', teamOnly };
  }

  function placeLabel(text: string, teamOnly: boolean): void {
    const dialog = labelDialog;
    labelDialog = null;
    if (!dialog) return;
    const side = session.viewingSide;
    const team = activeSnapshot.teams.find((t) => t.side === side);
    const color = sideColorRgb(ImageCache.getColorData(), team?.color ?? '', side) ?? '255,255,255';
    session.placeLabel(dialog.hex, text, teamOnly, color);
    sync();
  }

  /** `GameBoardView`'s `onHexRightClick` -- opens the context menu at the clicked hex/screen position; its commands are built by `contextMenuCommands` below from the same hex. */
  function handleHexRightClick(x: number, y: number, clientX: number, clientY: number): void {
    if (phase !== 'playing') return;
    contextMenuAt = { x, y, clientX, clientY };
  }

  function closeContextMenu(): void {
    contextMenuAt = null;
  }

  /**
   * Dev-only debug hook for automated visual testing (Playwright etc.):
   * `window.__wesnoth.clickHex(x, y)` simulates a real click on
   * engine-convention hex `(x, y)` through the EXACT SAME code path a real
   * pointer click on the board takes (`handleHexClick`), without needing to
   * compute screen pixel coordinates -- which depend on the board's current
   * pan/zoom/scroll state and are fragile to guess from a screenshot.
   * `window.__wesnoth.session` exposes the live `GameSession` for
   * introspection (e.g. `session.board.allUnits().find(u => u.id ===
   * 'Gwabbo').location` to find a real hex to click, rather than guessing).
   * Stripped from production builds (`import.meta.env.DEV`), so this never
   * ships as a real attack surface.
   */
  // `packages/ui` has no `vite/client` types of its own (it's a library
  // package, not a Vite app), hence the cast -- `apps/web`, the only real
  // consumer, does run under Vite, so `import.meta.env.DEV` is genuinely
  // present at runtime there.
  if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV && typeof window !== 'undefined') {
    (window as unknown as { __wesnoth: unknown }).__wesnoth = {
      get session() {
        return session;
      },
      clickHex: (x: number, y: number) => handleHexClick(x, y),
      /** Phase 22: the hexes "Show Enemy Moves" is showing, or null when it isn't. */
      enemyReach: () => enemyReach?.hexes ?? null,
      /** Phase 28b: what the pointer's order preview is showing. */
      movementPreview: () => ({ route, attackIndicator, hoverReach: hoverReach?.length ?? null, pointerHex, canAct: canAct(), phase }),
    };
  }

  // The `phase !== 'playing'` guards below are defensive: StoryViewer/
  // MessageViewer are full-screen `position:fixed` overlays that should
  // already block pointer events from reaching SidePanel's buttons while
  // shown, but that couldn't be visually confirmed in a real browser in
  // this environment (see top-level report) -- these guards make sure a
  // stray click/keyboard-focus during 'story'/'messages' can't end a turn
  // or place a recruit before the player has actually taken control.
  /**
   * A unit type's real `[*_anim]`/`[defend]`/`[death]` blocks, parsed
   * fresh each call -- `UnitType.ts` deliberately doesn't parse or cache
   * these (see its own doc comment), so there's no cheaper source than
   * `session.rawUnitTypeConfig` + `parseUnitAnimations` to reach for.
   * Real content's animation block count per type is small (single
   * digits to a few dozen), so re-parsing per attack (not per blow) is
   * cheap enough not to need a cache -- revisit if profiling ever says
   * otherwise.
   */
  function animationsFor(typeId: string): ReturnType<typeof parseUnitAnimations> {
    const cfg = session.rawUnitTypeConfig(typeId);
    return cfg ? parseUnitAnimations(WmlConfig.fromJSON(cfg)) : [];
  }

  /**
   * Builds one `UnitAnimationCue` pair (attacker + defender) per real
   * blow of `info`, for `GameBoardView.playAnimationSequence` -- see
   * `LastAttackAnimation`'s own doc comment for why this glue lives here
   * (in the one place with both engine data and a `@wesnothweb2/renderer`
   * dependency) rather than in `gameSession.ts` or `SnapshotBoard.ts`
   * themselves.
   */
  function buildBlowAnimationCues(info: LastAttackAnimation): UnitAnimationCue[][] {
    const attackerWeapon = info.attacker.attacks[info.attackerWeaponIndex];
    const defenderWeapon = info.defenderWeaponIndex >= 0 ? info.defender.attacks[info.defenderWeaponIndex] : undefined;
    const contexts = buildAttackAnimationContexts(
      info.attacker,
      attackerWeapon,
      info.defender,
      defenderWeapon,
      info.result,
      terrainLookup(session.board),
    );

    // Real, reported bug: a combatant that advances (levels up) has its
    // `.type` mutated in place synchronously, before this animation ever
    // plays (see `LastAttackAnimation.attackerTypeId`'s own doc comment) --
    // resolving sprite/animation-set by the live `.type.id` showed the
    // ALREADY-ADVANCED unit for the whole fight instead of only after it
    // visually finishes. Use the type id captured at combat-resolution time.
    const attackerTypeId = info.attackerTypeId;
    const defenderTypeId = info.defenderTypeId;
    const attackerAnims = animationsFor(attackerTypeId);
    const defenderAnims = animationsFor(defenderTypeId);
    const attackerKey = spriteKey({
      underlyingId: session.renderKeyFor(info.attacker),
      typeId: attackerTypeId,
      x: info.attacker.location.x,
      y: info.attacker.location.y,
    });
    const defenderKey = spriteKey({
      underlyingId: session.renderKeyFor(info.defender),
      typeId: defenderTypeId,
      x: info.defender.location.x,
      y: info.defender.location.y,
    });
    // Real, reported bug (bugs4.md #2/#3): frozen at combat-resolution time
    // (`info.attackerLocation`/`defenderLocation`), NOT re-read from the
    // live `.location` field -- an AI-played attack's cue is only built
    // AFTER `playAiTurn` has already resolved the WHOLE rest of that
    // side's turn, so a live read here could show either combatant at
    // wherever a LATER action left it instead of where this exchange
    // actually took place. See `AiAnimationEvent`'s attack variant (engine
    // package) for the full rationale.
    const attackerHex = { x: info.attackerLocation.x, y: info.attackerLocation.y };
    const defenderHex = { x: info.defenderLocation.x, y: info.defenderLocation.y };

    // Each blow's own `attackerContext`/`defenderContext` (the "attack"-
    // event/"defend"-event pair) can belong to EITHER real combatant --
    // `buildAttackBlowAnimationContexts` swaps `myUnit` to whichever unit
    // is actually striking THIS blow (see its own doc comment: a
    // defender's retaliation blow makes the DEFENDER the one playing
    // "attack"). Resolve each context's own real resources (animation
    // set/sprite key/hex) by `myUnit` OBJECT IDENTITY per blow, rather
    // than assuming the combat's overall attacker always swings --
    // getting this wrong was a real bug (every retaliation blow showed
    // the original attacker's sprite/animation set instead of the
    // defender's own).
    const resourcesFor = (unit: Unit) =>
      unit === info.attacker
        ? { anims: attackerAnims, key: attackerKey, hex: attackerHex }
        : { anims: defenderAnims, key: defenderKey, hex: defenderHex };

    const cues: UnitAnimationCue[][] = contexts.map(({ attackerContext, defenderContext }, blowIndex) => {
      const strikerRes = resourcesFor(attackerContext.myUnit);
      const receiverRes = resourcesFor(defenderContext.myUnit);
      // `unit_attack`'s extra_hit_sounds: a hit that poisons, slows or petrifies says so once, as it lands.
      const blow = info.result.blows[blowIndex];
      const extraSounds = blow?.hit ? extraHitSounds(blow) : [];
      return [
        {
          key: strikerRes.key,
          anim: chooseAnimation(strikerRes.anims, attackerContext),
          direction: attackerContext.myUnit.facing,
          srcHex: strikerRes.hex,
          dstHex: receiverRes.hex,
        },
        {
          key: receiverRes.key,
          anim: chooseAnimation(receiverRes.anims, defenderContext),
          direction: defenderContext.myUnit.facing,
          srcHex: receiverRes.hex,
          dstHex: strikerRes.hex,
          ...(extraSounds.length > 0 ? { extraSounds } : {}),
        },
      ];
    });

    // Real, reported bug: death animations never played -- `unit_die`
    // (udisplay.cpp ~L572-590) fires a SEPARATE "death" animation for the
    // loser (loc=loser's own hex, secondLoc=winner's hex, hit=kill) after
    // all of a fight's strike/defend animations finish, which this project
    // never triggered at all: a dead unit's sprite just vanished the
    // instant `sync()` next reconciled with the board (which had already
    // removed it -- `executeAttack`'s `handleDeath` runs synchronously
    // inside `confirmAttack`, well before this animation sequence plays).
    const deathBeat: UnitAnimationCue[] = [];
    const addDeathCue = (loser: Unit, winner: Unit): void => {
      const loserRes = resourcesFor(loser);
      const winnerRes = resourcesFor(winner);
      const deathContext: AnimationContext = {
        loc: loser.location,
        secondLoc: winner.location,
        myUnit: loser,
        event: 'death',
        value: 0,
        value2: 0,
        hit: 'kill',
        terrainAtLoc: terrainLookup(session.board)(loser.location),
        secondUnit: winner,
      };
      deathBeat.push({
        key: loserRes.key,
        anim: chooseAnimation(loserRes.anims, deathContext),
        direction: loser.facing,
        srcHex: loserRes.hex,
        dstHex: winnerRes.hex,
      });
    };
    if (info.result.attackerDied) addDeathCue(info.attacker, info.defender);
    if (info.result.defenderDied) addDeathCue(info.defender, info.attacker);
    if (deathBeat.length > 0) cues.push(deathBeat);

    return cues;
  }

  /**
   * Real, reported bugs: the HP bar only ever updated once, after a whole
   * attack's exchange fully resolved, instead of after each individual
   * blow the way real Wesnoth's `unit_display` does; and no floating
   * damage/heal numeral ever appeared at all. Both driven by the same
   * per-blow data -- returns a `playAnimationSequence` `onBeatComplete`
   * callback that walks `info.result.blows` in step with the beats
   * already playing (`buildBlowAnimationCues` builds exactly one beat per
   * blow), running the attacker/defender HP totals forward from their
   * real PRE-combat starting points (`attackerHitpointsBefore`/
   * `defenderHitpointsBefore` -- see that field's own doc comment on why
   * the live `Unit` objects can't be read for this: `executeAttack`
   * already applied every blow before this ever plays), and previewing/
   * spawning for whichever combatant that blow actually landed on.
   */
  function makeBlowPreview(info: LastAttackAnimation): (beatIndex: number) => void {
    const attackerKey = spriteKey({
      underlyingId: session.renderKeyFor(info.attacker),
      typeId: info.attackerTypeId,
      x: info.attacker.location.x,
      y: info.attacker.location.y,
    });
    const defenderKey = spriteKey({
      underlyingId: session.renderKeyFor(info.defender),
      typeId: info.defenderTypeId,
      x: info.defender.location.x,
      y: info.defender.location.y,
    });
    let attackerHp = info.attackerHitpointsBefore;
    let defenderHp = info.defenderHitpointsBefore;

    return (beatIndex: number) => {
      const blow = info.result.blows[beatIndex];
      if (!blow || !boardView) return;
      if (blow.hit) {
        if (blow.attackerTurn) {
          defenderHp = Math.max(0, defenderHp - blow.damage);
          boardView.previewHitpoints(defenderKey, defenderHp);
          boardView.spawnFloatingNumber(defenderKey, blow.damage, 'damage');
        } else {
          attackerHp = Math.max(0, attackerHp - blow.damage);
          boardView.previewHitpoints(attackerKey, attackerHp);
          boardView.spawnFloatingNumber(attackerKey, blow.damage, 'damage');
        }
      }
      if (blow.drainAmount !== 0) {
        // drainAmount always applies to whoever STRUCK this blow (the
        // "striker" -- see GameSession.formatBlowMessage's identical
        // attackerTurn-picks-the-striker convention), gaining HP; a rare
        // reversed/negative drain instead shows as a second "damage" number.
        if (blow.attackerTurn) {
          attackerHp = Math.max(0, attackerHp + blow.drainAmount);
          boardView.previewHitpoints(attackerKey, attackerHp);
          boardView.spawnFloatingNumber(attackerKey, blow.drainAmount, blow.drainAmount > 0 ? 'heal' : 'damage');
        } else {
          defenderHp = Math.max(0, defenderHp + blow.drainAmount);
          boardView.previewHitpoints(defenderKey, defenderHp);
          boardView.spawnFloatingNumber(defenderKey, blow.drainAmount, blow.drainAmount > 0 ? 'heal' : 'damage');
        }
      }
    };
  }

  /**
   * Builds one cue per real leg-GROUP of `info.path` for
   * `GameBoardView.playAnimationSequence` -- each leg its own "movement"
   * `AnimationContext` (terrain/direction can differ leg to leg) and its
   * own REAL direction of travel, computed directly from the path -- not
   * `unit.facing`, which `executeMove` only ever sets ONCE, from the last
   * two hexes of the whole move (a documented simplification of this
   * project's `move.ts`, never exercised until movement animation needed
   * a real per-step facing).
   *
   * Real, reported bug: "the move animation between adjacent hexes plays
   * twice on every step." Root cause, verified against
   * `src/units/udisplay.cpp`/`animation.cpp`: real Wesnoth does not start
   * a fresh "movement" animation instance per hex -- `unit_animator::
   * replace_anim_if_invalid` (animation.cpp ~L1365) keeps reusing the
   * SAME running instance across consecutive hexes for as long as it
   * still matches (same chosen animation) AND hasn't finished its own
   * declared duration, updating only src/dst per hex while elapsed time
   * keeps counting continuously -- the engine-injected default `offset=`
   * (`HEX_STEP_MS`'s own doc comment, `@wesnothweb2/renderer`) is a
   * REPEATING 200ms ramp specifically so each repeat lines up with one
   * hex of that reused instance. This project instead gave every leg its
   * own fresh, full-duration cue: for a unit whose movement_anim frame
   * cycle runs longer than 200ms (any `MOVING_ANIM_DIRECTIONAL_*_FRAME`
   * unit, e.g. Horseman's 400ms/8-frame run, Skeleton's 600ms/12-frame
   * one -- not Elvish Fighter, whose custom `movement_anim` happens to
   * fit in one segment), the repeating ramp played a full
   * 0->1->(snap)->0->1 within that ONE leg: glide to the hex, snap back,
   * glide again.
   *
   * Fix: consecutive legs that resolve to the SAME chosen `anim` (using
   * the engine-injected default movement offset -- see
   * `UnitAnimationDef.usesDefaultMovementOffset`'s own doc comment) are
   * grouped into one cue with `legs` set, up to `floor(animationDurationMs
   * (anim) / HEX_STEP_MS)` hexes per group -- exactly how many hexes fit
   * in that animation's own declared duration before upstream's real
   * `animation_finished_potential()` would force a fresh instance anyway
   * (2 for Horseman, 3 for Skeleton; both exact multiples of `HEX_STEP_MS`
   * in real content, so a group boundary always lands cleanly on a hex
   * boundary rather than mid-glide). `SnapshotBoard.playAnimations`
   * samples the whole group with one continuously increasing elapsed
   * clock, switching which leg's src/dst/direction to interpolate against
   * every `HEX_STEP_MS` -- see its own doc comment.
   */
  function buildMoveAnimationCues(info: LastMoveAnimation): UnitAnimationCue[][] {
    const contexts = buildMovementAnimationContexts(info.unit, info.path, terrainLookup(session.board));
    const anims = animationsFor(info.unit.type.id);
    const key = spriteKey({
      underlyingId: session.renderKeyFor(info.unit),
      typeId: info.unit.type.id,
      x: info.unit.location.x,
      y: info.unit.location.y,
    });

    const legs = contexts.map((ctx, i) => {
      const from = info.path[i]!;
      const to = info.path[i + 1]!;
      const teleport = !tilesAdjacent(from, to);
      const direction = teleport ? relativeDirection(from, to) : (directionBetween(from, to) ?? info.unit.facing);
      return { from, to, direction, teleport, anim: teleport ? undefined : chooseAnimation(anims, ctx) };
    });

    const beats: UnitAnimationCue[][] = [];
    let i = 0;
    while (i < legs.length) {
      const first = legs[i]!;
      if (first.teleport) {
        beats.push(...teleportBeats(key, info.unit, first.from, first.to, first.direction, anims));
        i++;
        continue;
      }
      let groupSize = 1;
      if (first.anim !== undefined && first.anim.usesDefaultMovementOffset) {
        const maxGroupSize = Math.max(1, Math.floor(animationDurationMs(first.anim) / HEX_STEP_MS));
        while (groupSize < maxGroupSize && i + groupSize < legs.length && legs[i + groupSize]!.anim === first.anim) {
          groupSize++;
        }
      }
      const group = legs.slice(i, i + groupSize);
      const last = group[group.length - 1]!;
      beats.push([
        {
          key,
          anim: first.anim,
          direction: first.direction,
          srcHex: { x: first.from.x, y: first.from.y },
          dstHex: { x: last.to.x, y: last.to.y },
          restAt: 'dst' as const,
          // Always on the per-hex clock, even for one leg: upstream's move_unit_between gives every hex
          // HEX_STEP_MS whatever the animation's own length ("round it to the next multiple of 200"). Timed
          // by the animation instead, horses (whose movement animations are short) crossed a hex in 75-100 ms
          // while units without one glided at the default 400 ms halved by a 2x movement speed-up. Every
          // unit now takes upstream's 200 ms, and moves play at speed 1.
          legs: group.map((leg) => ({
            srcHex: { x: leg.from.x, y: leg.from.y },
            dstHex: { x: leg.to.x, y: leg.to.y },
            direction: leg.direction,
          })),
        },
      ]);
      i += groupSize;
    }
    return beats;
  }

  /**
   * Phase 18a: a teleport step (`teleport_unit_between`, udisplay.cpp) --
   * "pre_teleport" played in place at the source, then the unit reappears
   * at the exit and plays "post_teleport" there, facing the way it went.
   * A unit type with neither animation (most, when a `[teleport]` tag or a
   * `[tunnel]` moves them) simply vanishes and reappears.
   */
  function teleportBeats(
    key: string,
    unit: Unit,
    from: Location,
    to: Location,
    direction: Direction,
    anims: ReturnType<typeof animationsFor>,
  ): UnitAnimationCue[][] {
    const context = (event: string, at: Location) => ({ ...buildMovementAnimationContext(unit, at, at, terrainLookup(session.board)), event });
    const pre = chooseAnimation(anims, context('pre_teleport', from));
    const post = chooseAnimation(anims, context('post_teleport', to));
    const beats: UnitAnimationCue[][] = [];
    if (pre) beats.push([{ key, anim: pre, direction, srcHex: { x: from.x, y: from.y }, dstHex: { x: from.x, y: from.y } }]);
    beats.push([
      post
        ? { key, anim: post, direction, srcHex: { x: to.x, y: to.y }, dstHex: { x: to.x, y: to.y } }
        : // No arrival animation: jump straight to the exit (`holdInPlace` + `restAt: 'dst'` = no glide).
          { key, anim: undefined, direction, srcHex: { x: from.x, y: from.y }, dstHex: { x: to.x, y: to.y }, restAt: 'dst' as const, holdInPlace: true },
    ]);
    return beats;
  }

  /**
   * Real, reported bug: recruitment never played any animation at all.
   * Mirrors `unit_recruited` (`units/udisplay.cpp`): the new unit plays
   * "recruited" at its own hex (secondLoc = the leader's hex), and the
   * leader -- turned to face it -- plays "recruiting" (secondLoc = the
   * new unit's hex), both in place (no `restAt`, i.e. lunge-and-return
   * convention, same as attack/defend -- neither unit actually relocates).
   */
  function buildRecruitAnimationCues(info: LastRecruitAnimation): UnitAnimationCue[][] {
    const terrainAt = terrainLookup(session.board);
    const unitKey = spriteKey({
      underlyingId: session.renderKeyFor(info.unit),
      typeId: info.unit.type.id,
      x: info.unitLocation.x,
      y: info.unitLocation.y,
    });
    const leaderKey = spriteKey({
      underlyingId: session.renderKeyFor(info.leader),
      typeId: info.leader.type.id,
      x: info.leaderLocation.x,
      y: info.leaderLocation.y,
    });
    // Real, reported bug (bugs4.md #2/#3): frozen at recruit-resolution
    // time (`info.unitLocation`/`leaderLocation`), NOT re-read from the
    // live `.location` field -- the leader in particular routinely takes
    // a LATER action (moving) this same AI turn after recruiting, and an
    // AI-played recruit's cue is only built after the WHOLE rest of that
    // turn already resolved. See `AiAnimationEvent`'s recruit variant
    // (engine package) for the full rationale.
    const unitHex = { x: info.unitLocation.x, y: info.unitLocation.y };
    const leaderHex = { x: info.leaderLocation.x, y: info.leaderLocation.y };

    const unitContext: AnimationContext = {
      loc: info.unitLocation,
      secondLoc: info.leaderLocation,
      myUnit: info.unit,
      event: 'recruited',
      value: 0,
      value2: 0,
      hit: 'invalid',
      terrainAtLoc: terrainAt(info.unitLocation),
      secondUnit: info.leader,
    };
    const leaderContext: AnimationContext = {
      loc: info.leaderLocation,
      secondLoc: info.unitLocation,
      myUnit: info.leader,
      event: 'recruiting',
      value: 0,
      value2: 0,
      hit: 'invalid',
      terrainAtLoc: terrainAt(info.leaderLocation),
      secondUnit: info.unit,
    };

    return [
      [
        {
          key: unitKey,
          anim: chooseAnimation(animationsFor(info.unit.type.id), unitContext),
          direction: info.unit.facing,
          srcHex: unitHex,
          dstHex: leaderHex,
          holdInPlace: true,
        },
        {
          key: leaderKey,
          anim: chooseAnimation(animationsFor(info.leader.type.id), leaderContext),
          direction: directionBetween(info.leaderLocation, info.unitLocation) ?? info.leader.facing,
          srcHex: leaderHex,
          dstHex: unitHex,
          holdInPlace: true,
        },
      ],
    ];
  }

  /**
   * Real, reported bug (bugs4.md #7): turn-start heal/poison/regenerate
   * outcomes (`GameSession.lastHealAnimations`) never played anything at
   * all -- no unit animation, no floating HP-change numeral. Mirrors
   * `units/udisplay.cpp`'s `unit_healing()`: the healed unit itself plays
   * `poisoned` (amount < 0) or `healed` (amount >= 0, including a
   * poison-cure-only outcome with amount 0), and each contributing healer
   * (if any -- empty for a plain poison tick or rest heal) plays `healing`
   * facing the healed unit, all in ONE beat (upstream's own
   * `unit_animator` plays every participant of one `add_animation` batch
   * concurrently, not sequentially -- same convention already used by
   * `buildRecruitAnimationCues`).
   */
  function buildHealAnimationCues(outcome: HealOutcome): UnitAnimationCue[][] {
    const terrainAt = terrainLookup(session.board);
    const healedHex = { x: outcome.unit.location.x, y: outcome.unit.location.y };
    const healedKey = spriteKey({
      underlyingId: session.renderKeyFor(outcome.unit),
      typeId: outcome.unit.type.id,
      x: outcome.unit.location.x,
      y: outcome.unit.location.y,
    });
    const healedContext: AnimationContext = {
      loc: outcome.unit.location,
      secondLoc: Location.NULL,
      myUnit: outcome.unit,
      event: outcome.amount < 0 ? 'poisoned' : 'healed',
      value: Math.abs(outcome.amount),
      value2: 0,
      hit: 'invalid',
      terrainAtLoc: terrainAt(outcome.unit.location),
    };
    const beat: UnitAnimationCue[] = [
      {
        key: healedKey,
        anim: chooseAnimation(animationsFor(outcome.unit.type.id), healedContext),
        direction: outcome.unit.facing,
        srcHex: healedHex,
        dstHex: healedHex,
        holdInPlace: true,
      },
    ];
    for (const healer of outcome.healers) {
      const healerHex = { x: healer.location.x, y: healer.location.y };
      const healerKey = spriteKey({
        underlyingId: session.renderKeyFor(healer),
        typeId: healer.type.id,
        x: healer.location.x,
        y: healer.location.y,
      });
      const healerContext: AnimationContext = {
        loc: healer.location,
        secondLoc: outcome.unit.location,
        myUnit: healer,
        event: 'healing',
        value: outcome.amount,
        value2: 0,
        hit: 'invalid',
        terrainAtLoc: terrainAt(healer.location),
        secondUnit: outcome.unit,
      };
      beat.push({
        key: healerKey,
        anim: chooseAnimation(animationsFor(healer.type.id), healerContext),
        direction: directionBetween(healer.location, outcome.unit.location) ?? healer.facing,
        srcHex: healerHex,
        dstHex: healedHex,
        holdInPlace: true,
      });
    }
    return [beat];
  }

  /** Plays every turn-start heal/poison outcome in order, spawning the same floating HP-change numeral/HP-bar update a combat blow gets (bugs4.md #7's own explicit ask: "associate the HP change numeric label with a change in HP in general, not combat hits specifically"). */
  async function playHealAnimations(outcomes: readonly HealOutcome[]): Promise<void> {
    if (!boardView) return;
    for (const outcome of outcomes) {
      if (skipOtherSidesAnimations) return;
      const key = spriteKey({
        underlyingId: session.renderKeyFor(outcome.unit),
        typeId: outcome.unit.type.id,
        x: outcome.unit.location.x,
        y: outcome.unit.location.y,
      });
      await followAction([outcome.unit.location]);
      await boardView.playAnimationSequence(buildHealAnimationCues(outcome), 1, () => {
        if (!boardView) return;
        boardView.previewHitpoints(key, outcome.unit.hitpoints);
        if (outcome.amount !== 0) {
          boardView.spawnFloatingNumber(key, Math.abs(outcome.amount), outcome.amount > 0 ? 'heal' : 'damage');
        }
      });
    }
  }

  /**
   * Real, reported bug (bugs4.md #1): the AttackDialog modal used to stay
   * open (blocking the view of the board) for the ENTIRE combat animation,
   * only closing once the full `sync(message)` below ran afterward.
   * `session.confirmAttack()` already clears `session.pendingAttack`
   * synchronously (so `pendingPreview`/`attackerWeaponOptions` are already
   * stale the instant it returns) -- close the dialog immediately by
   * setting those two `$state` vars directly, before awaiting the
   * animation, rather than waiting for the full `sync()` that also updates
   * `units`/HP bars/etc. (which must stay deferred until AFTER the
   * animation finishes, or the board would jump straight to the final
   * post-combat state and the animation would have nothing left to show).
   */
  async function handleConfirmAttack(): Promise<void> {
    if (!canAct()) return;
    const message = await runPlayerAction(async () => {
      const result = await session.confirmAttack();
      pendingPreview = null;
      attackerWeaponOptions = [];
      const anim = session.lastAttackAnimation;
      session.lastAttackAnimation = null;
      if (anim && boardView) {
        await followAttack(anim.attacker.location, anim.defender.location);
        await boardView.playAnimationSequence(buildBlowAnimationCues(anim), 1, makeBlowPreview(anim));
      }
      return result;
    });
    sync(message);
    // `last breath`/`die` fire from inside the attack choreography, where
    // nothing can stop for the player -- their dialogue waits until the
    // blows have been shown.
    await showDeferredInteractions();
  }

  function handleCancelAttack(): void {
    if (phase !== 'playing') return;
    session.cancelAttack();
    sync();
  }

  function handleChooseAdvancement(typeId: string): void {
    session.chooseAdvancement(typeId);
    sync();
  }

  function handleSelectAttackerWeapon(index: number): void {
    if (phase !== 'playing') return;
    session.selectAttackerWeapon(index);
    sync();
  }

  function handleSelectRecruitType(typeId: string): void {
    if (phase !== 'playing') return;
    session.selectRecruitType(typeId);
    sync();
  }

  function handleSelectRecallUnit(index: number): void {
    if (phase !== 'playing') return;
    session.selectRecallUnit(index);
    sync();
  }

  /**
   * Phase 13: `RecruitDialog`'s "Recruit" button. Real, reported bug
   * (bugs4.md #5): if the dialog was opened by right-clicking a specific
   * empty castle tile (`recruitOriginHex` set), place the recruit there
   * immediately (through the exact same `handleHexClick` path a manual
   * tile click would take) instead of arming a pending choice and making
   * the player click that same tile again. Opened without one (Ctrl+R or
   * the Actions menu), the recruit goes to `session.autoRecruitTile`, the
   * first vacant tile by x, y (bugs6.md); arm-and-wait-for-a-click remains
   * only for the case where no tile is free.
   *
   * Deliberately arms via `session.selectRecruitType` directly here, NOT
   * `handleSelectRecruitType` (which also calls `sync()`) -- real,
   * reported bug (bugs5.md, found while fixing #3): that extra `sync()`
   * reassigns `units`, which `GameBoardView`'s reactive effect turns into
   * a fire-and-forget `updateUnits()`/`renderUnits()` pass over the board
   * BEFORE the recruit itself has even happened. Immediately afterward
   * (same tick), `handleHexClick` below performs the actual recruit and
   * calls `ensureUnitVisual` for the brand-new unit -- racing that still
   * in-flight, now-stale pass, whose own cleanup loop (built from a
   * `units` snapshot that predates the recruit) doesn't know the new
   * unit's key and destroys the visual `ensureUnitVisual` just created
   * out from under it (a real crash: "Cannot set properties of null
   * (setting 'x')", `SnapshotBoard.updateOneUnit` mid-flight). Skipping
   * the redundant sync when we're about to place the unit immediately
   * anyway removes the race outright.
   */
  async function handleConfirmRecruit(typeId: string): Promise<void> {
    recruitDialogOpen = false;
    const origin = recruitOriginHex ?? session.autoRecruitTile;
    recruitOriginHex = null;
    if (origin) {
      session.selectRecruitType(typeId);
      await handleHexClick(origin.x, origin.y);
    } else {
      handleSelectRecruitType(typeId);
    }
  }

  /** Phase 13: `RecallDialog`'s "Recall" button -- same shape as `handleConfirmRecruit`, including the same deliberate no-intermediate-sync reasoning. */
  async function handleConfirmRecall(index: number): Promise<void> {
    recallDialogOpen = false;
    const origin = recruitOriginHex ?? session.autoRecruitTile;
    recruitOriginHex = null;
    if (origin) {
      session.selectRecallUnit(index);
      await handleHexClick(origin.x, origin.y);
    } else {
      handleSelectRecallUnit(index);
    }
  }

  /** Phase 13: `RecallDialog`'s real "Dismiss unit" button (`GameSession.dismissRecallUnit`) -- permanently removes the entry, no placement follows. */
  function handleDismissRecall(index: number): void {
    if (phase !== 'playing') return;
    session.dismissRecallUnit(index);
    sync();
  }

  /** Phase 13: `RecallDialog`'s real "Rename" action (`GameSession.renameRecallUnit`). */
  function handleRenameRecall(index: number, name: string): void {
    if (phase !== 'playing') return;
    session.renameRecallUnit(index, name);
    sync();
  }

  /**
   * Real, reported bug: an AI-controlled side's whole turn used to resolve
   * with zero animation (a deliberate simplification at the time -- see
   * `LastAttackAnimation`'s own doc comment -- since reversed:
   * `GameSession.lastAiAnimations`). `session.endTurn()` has already fully
   * resolved every AI action by the time it returns (board is at its final
   * state), so each event here is played back against `boardView` using
   * the exact same cue builders a human's own actions use -- `
   * AiAnimationEvent`'s attack/move/recruit variants are structurally
   * identical to `LastAttackAnimation`/`LastMoveAnimation`/
   * `LastRecruitAnimation`, so the same builders apply directly.
   *
   * Known simplification: there's no incremental `sync()` between events
   * (other than the explicit `removeUnitVisual` death cleanup below, and
   * `buildBlowAnimationCues`/`buildRecruitAnimationCues` now reading each
   * event's own FROZEN location fields rather than live `.location` --
   * see bugs4.md #2/#3 and `AiAnimationEvent`'s own doc comment) -- a
   * unit's HP bar/position otherwise only reconciles with `board`'s live
   * state at the single `sync()` after the whole turn finishes. An
   * acceptable rough edge for a first cut given real per-action board
   * reconciliation would need `GameSession` to expose intermediate board
   * snapshots, not just the final one.
   */
  async function playAiAnimations(events: readonly AiAnimationEvent[]): Promise<void> {
    if (!boardView) return;
    for (const event of events) {
      // Skip Animation: the final sync() shows where everything ended up.
      if (skipOtherSidesAnimations) return;
      if (event.kind === 'attack') {
        await followAttack(event.attackerLocation, event.defenderLocation);
        await boardView.playAnimationSequence(buildBlowAnimationCues(event), 1, makeBlowPreview(event));
        // Real, reported bug (bugs4.md #3): without this, a unit that died
        // on an early event of this same AI turn kept its stale sprite on
        // screen through every later event's animation too (only actually
        // disappearing at the final `sync()`), so a later event's own unit
        // moving onto/through that hex could visually overlap with it --
        // "units standing on the same hex". Remove it the instant its own
        // death animation finishes, same as `previewHitpoints`/
        // `spawnFloatingNumber`'s "poke the renderer directly" convention.
        if (event.result.attackerDied) {
          boardView.removeUnitVisual(
            spriteKey({ underlyingId: session.renderKeyFor(event.attacker), typeId: event.attackerTypeId, x: event.attackerLocation.x, y: event.attackerLocation.y }),
          );
        }
        if (event.result.defenderDied) {
          boardView.removeUnitVisual(
            spriteKey({ underlyingId: session.renderKeyFor(event.defender), typeId: event.defenderTypeId, x: event.defenderLocation.x, y: event.defenderLocation.y }),
          );
        }
      } else if (event.kind === 'move') {
        await followMove(event.path);
        await boardView.playAnimationSequence(buildMoveAnimationCues(event));
      } else {
        // Real, reported bug (bugs5.md #3): without this, an AI recruit's
        // new unit had no visual until the WHOLE turn's worth of
        // animations finished playing and the deferred `sync()` finally
        // ran -- so its own "recruited" cue silently did nothing, and
        // every unit an AI side recruited that turn seemed to pop into
        // existence all at once, well after the fact. See
        // `SnapshotBoard.ensureUnitVisual`'s own doc comment.
        //
        // At `event.unitLocation`, NOT the unit's live hex: the whole AI
        // turn has already resolved by the time any of it is animated
        // (see `AiAnimationEvent`), so a unit that was recruited and then
        // marched would otherwise have its sprite created at the far end
        // of that march, flash back to the keep for its "recruited" cue,
        // and walk the route again -- the reported "jumps back and forth
        // between hexes" on Dead Water 1's first AI turn.
        await boardView.ensureUnitVisual(session.snapshotUnitFor(event.unit, event.unitLocation), { hidden: true });
        // unit_recruited: the new unit and its leader.
        await followAction([event.unitLocation, event.leaderLocation]);
        await boardView.playAnimationSequence(buildRecruitAnimationCues(event));
      }
    }
  }

  /**
   * `menu_handler::end_turn`: asks first when the side has not done anything yet this turn and still has
   * units (upstream's default `confirm_end_turn=no_moves`).
   */
  function requestEndTurn(): void {
    if (!canAct()) return;
    const side = session.activeSide;
    if (!session.playerActed && session.board.unitsForSide(side).length > 0) {
      endTurnConfirmOpen = true;
      return;
    }
    void handleEndTurn();
  }

  /** Skip Animation: finish the animation on screen at once and drop the rest of the other sides' moves. */
  function skipAnimations(): void {
    if (otherSidesTurn !== 'animating') return;
    skipOtherSidesAnimations = true;
    boardView?.skipAnimations();
  }

  async function handleEndTurn(): Promise<void> {
    if (!canAct()) return;
    const message = await runPlayerAction(async () => {
      otherSidesTurn = 'thinking';
      skipOtherSidesAnimations = false;
      try {
        // The AI computes synchronously inside endTurn: let the greyed-out button paint first.
        // (A hidden tab gets no animation frames, hence the timeout.)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 100);
          requestAnimationFrame(() => requestAnimationFrame(() => (clearTimeout(timer), resolve())));
        });
        const result = await session.endTurn();
        otherSidesTurn = 'animating';
        const healOutcomes = session.lastHealAnimations;
        session.lastHealAnimations = null;
        // Heals/poison happen at the START of each side's turn, before that
        // side's own actions -- played first, ahead of aiAnimations below (see
        // `lastHealAnimations`'s own doc comment on why this isn't fully
        // interleaved turn-by-turn across multiple AI sides).
        if (healOutcomes) await playHealAnimations(healOutcomes);
        const aiAnimations = session.lastAiAnimations;
        session.lastAiAnimations = null;
        if (aiAnimations) await playAiAnimations(aiAnimations);
        return result;
      } finally {
        otherSidesTurn = null;
        skipOtherSidesAnimations = false;
      }
    });
    sync(message);
    await showDeferredInteractions();
    // Upstream autosaves once per player turn, *before* that turn begins
    // (`playsingle_controller::before_human_turn`) -- which, after
    // `endTurn` has cycled through every AI side and come back round, is
    // here.
    await autosave();
    await continueStandingOrders();
    // Then, as `play_human_turn` does, the objectives if WML changed them.
    if (phase !== 'ended' && session.takeObjectivesChanged()) objectivesDialogOpen = true;
  }

  /**
   * Writes this turn's autosave and prunes old ones, mirroring
   * `autosave_savegame::autosave` (`savegame.cpp:511`): one per player
   * turn, named `<label>-Auto-Save<turn>`, keeping the newest
   * `autoSaveMax` (0 disables autosaving entirely, as upstream's
   * `auto_save_max() > 0` guard does).
   *
   * Deliberately never throws into the caller: losing an autosave must
   * not interrupt play, so a failure is reported in the status line and
   * the game carries on.
   */
  async function autosave(kind: SaveKind = 'autosave'): Promise<void> {
    if (phase === 'ended') return;
    try {
      const max = await readSetting('autoSaveMax', DEFAULT_AUTO_SAVE_MAX);
      if (max <= 0) return;
      const details = saveDetails(kind);
      const name =
        kind === 'scenario-start'
          ? scenarioStartSaveName(details.label ?? '')
          : autosaveName(details.label ?? '', session.turnNumber);
      await saveGame(name, details, session.toSaveData());
      for (const stale of autosavesToDelete(await listSaves(), max)) await deleteSave(stale);
    } catch (err) {
      console.error('[autosave] failed:', err);
      sync(`Autosave failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The metadata every save carries so the manager can list, filter and
   * resume it without decompressing the payload -- and so an export knows
   * which campaign it belongs to.
   */
  function saveDetails(kind: SaveKind): SaveDetails {
    return {
      scenarioId: activeSnapshot.scenario.id,
      scenarioName: session.scenarioName,
      campaignId: campaign?.id,
      label: scenarioLabel(campaignAbbrev(campaign), session.scenarioName),
      turnNumber: session.turnNumber,
      kind,
    };
  }

  /** Opens the save manager, refreshing the list first so it is never stale. */
  async function openSaveManager(which: 'save' | 'load'): Promise<void> {
    try {
      savesList = await listSaves();
    } catch (err) {
      sync(`Could not read saves: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (which === 'save') saveDialogOpen = true;
    else loadDialogOpen = true;
  }

  async function handleSaveAs(name: string): Promise<void> {
    // The dialog closes only once the write has actually landed: closing
    // first looks finished while the IndexedDB transaction is still in
    // flight, and anything that tears the page down in that window (a
    // navigation, a reload) loses the save silently.
    try {
      await saveGame(name, saveDetails('manual'), session.toSaveData());
      sync(`Saved as "${name}" (turn ${session.turnNumber}).`);
    } catch (err) {
      sync(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      saveDialogOpen = false;
    }
  }

  /**
   * Loads a save from the manager. A save for *this* scenario is applied
   * to the live session; one for another scenario needs its own snapshot
   * fetched first, which is what makes a save resumable from anywhere
   * rather than only inside the scenario it was taken in.
   */
  async function handleLoadNamed(name: string, showReplay = false): Promise<void> {
    loadDialogOpen = false;
    if (replay) {
      // Leaving a replay: let its current action finish, then drop it.
      replay.playing = false;
      await replayLoop;
      replay = null;
    }
    try {
      const found = await loadGame<SaveGameData>(name);
      if (!found) {
        sync(tx('That save no longer exists.'));
        return;
      }
      // Real, reported bug: loading a save switched the scenario but left
      // the campaign alone -- the page URL still named the campaign the
      // session had been opened with, and since `saveDetails` reads the
      // campaign from that same context, the NEXT save was filed under
      // the wrong campaign (and named with its abbreviation). A save that
      // belongs to another campaign is therefore handed back to the host
      // to open properly, rather than being squeezed into this one --
      // checked before `showReplay` below: `startReplay` fetches through
      // *this* shell's own campaign directory (`snapshotFor`), which is
      // wrong once the target save belongs to a different one.
      const targetCampaign = found.data.campaignId ?? found.meta.campaignId;
      if (targetCampaign && targetCampaign !== campaign?.id) {
        if (!onOpenSave) {
          sync(`"${name}" belongs to another campaign; open it from the main menu.`);
          return;
        }
        onOpenSave(targetCampaign, name, showReplay);
        return;
      }
      if (showReplay) {
        await startReplay(found.data);
        return;
      }
      const targetScenario = found.data.scenarioId ?? found.meta.scenarioId;
      if (targetScenario && (targetScenario !== activeSnapshot.scenario.id || savedDifficulty(found.data) !== activeSnapshot.difficulty)) {
        await loadIntoScenario(targetScenario, found.data);
      } else {
        session.loadSaveData(found.data);
        phase = session.scenarioResult ? 'ended' : 'playing';
        sync(`Loaded "${name}" (turn ${found.data.turnNumber}).`);
      }
      // Keep the address bar honest about what is actually loaded, so a
      // reload or a shared link reopens this game rather than the
      // campaign's first scenario.
      onOpenSave?.(campaign?.id ?? '', name);
    } catch (err) {
      sync(`Load failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 18b R5: the replay viewer (minimal, by the user's call) -- upstream's
  // "Show replay": the saved game played again from its start on the normal
  // board, with its walks, fights and dialogue; play/pause and restart.
  // ---------------------------------------------------------------------------

  /** The replay being shown: the save it comes from, how far it has got, and whether it is running. */
  let replay = $state<{ data: SaveGameData; index: number; total: number; playing: boolean } | null>(
    initialReplaySession ? { data: initialSave!, index: 0, total: initialSave!.replay!.commands.length, playing: true } : null,
  );
  /** The running playback loop, so Restart can wait for it to stop. */
  let replayLoop: Promise<void> | null = null;

  /**
   * Starts the loop for a replay `session`/`phase`/`replay` were already built into at mount (`startInReplay`),
   * once the board has had its first render -- `startReplay` (below) does the same wait via `runStartupEvents`'s
   * own `boardReady`, but this shell has no board yet at the point the constructor-time code above runs.
   */
  async function beginInitialReplay(): Promise<void> {
    await boardReady();
    sync(fmt(tx('Replay of $name: $total actions.'), { name: session.scenarioName, total: replay!.total }));
    replayLoop = runReplayLoop();
  }

  /** Opens `data`'s replay from its first command, paused at the start and then playing. */
  async function startReplay(data: SaveGameData): Promise<void> {
    if (!data.replay) {
      sync('This save has no replay to show (it was made before replays were recorded).');
      return;
    }
    const scenarioId = data.scenarioId ?? activeSnapshot.scenario.id;
    let replaySnapshot = activeSnapshot;
    if (scenarioId !== activeSnapshot.scenario.id || savedDifficulty(data) !== activeSnapshot.difficulty) {
      replaySnapshot = await snapshotFor(scenarioId, savedDifficulty(data));
    }
    const replaySession = GameSession.forReplay(replaySnapshot, data, { ...SESSION_OPTIONS, onSound: undefined, onVolume: undefined });
    if (!replaySession) return;
    activeSnapshot = replaySnapshot;
    cursorHex = null; // the keyboard cursor belongs to the board it was on
    session = replaySession;
    session.interactionHost = interactionHost;
    storyParts = [];
    currentMessage = null;
    screenTint = null;
    phase = 'replay';
    replay = { data, index: 0, total: data.replay.commands.length, playing: true };
    sync(fmt(tx('Replay of $name: $total actions.'), { name: session.scenarioName, total: replay.total }));
    await tick();
    replayLoop = runReplayLoop();
  }

  /** Plays recorded commands one by one, animating each, until paused or done. */
  async function runReplayLoop(): Promise<void> {
    while (replay && replay.playing && replay.index < replay.total) {
      const rec = replay.data.replay!.commands[replay.index]!;
      eventsRunning = true;
      try {
        await session.replayCommandShown(rec);
        const heals = session.lastHealAnimations;
        session.lastHealAnimations = null;
        if (heals) await playHealAnimations(heals);
        const anim = session.lastAttackAnimation;
        session.lastAttackAnimation = null;
        if (anim && boardView) {
          await followAttack(anim.attacker.location, anim.defender.location);
          await boardView.playAnimationSequence(buildBlowAnimationCues(anim), 1, makeBlowPreview(anim));
        }
      } finally {
        eventsRunning = false;
      }
      if (!replay) return;
      replay.index += 1;
      sync(replayStatus());
      await showDeferredInteractions();
    }
    if (replay && replay.index >= replay.total) {
      replay.playing = false;
      sync(replayStatus());
    }
  }

  function replayStatus(): string {
    if (!replay) return '';
    const issue = session.syncIssues[0];
    if (issue) return fmt(tx('Replay out of sync at action $index ($command): $message'), { index: issue.index + 1, command: issue.command, message: issue.message });
    return replay.index >= replay.total ? tx('Replay finished.') : fmt(tx('Replay: action $index of $total.'), { index: replay.index, total: replay.total });
  }

  function toggleReplayPlaying(): void {
    if (!replay || replay.index >= replay.total) return;
    replay.playing = !replay.playing;
    if (replay.playing && !eventsRunning) replayLoop = runReplayLoop();
    else sync(replay.playing ? replayStatus() : tx('Replay paused.'));
  }

  /** Back to the start: waits for the current action to finish, then rebuilds the session from the save's starting point. */
  async function restartReplay(): Promise<void> {
    if (!replay) return;
    const data = replay.data;
    replay.playing = false;
    await replayLoop;
    replay = null;
    await startReplay(data);
  }

  /** Upstream's end-of-replay offer: take over and play on from where the replay ended. */
  function continueFromReplay(): void {
    if (!replay || replay.playing) return;
    replay = null;
    phase = session.scenarioResult ? 'ended' : 'playing';
    sync(tx('Playing on from the end of the replay.'));
  }

  /**
   * Switches to another scenario's snapshot and resumes `data` in it --
   * the same wholesale replacement `continueToNextScenario` does, minus
   * the carryover computation (the save already holds the resulting
   * state) and minus the story screen (this game is in progress).
   */
  async function loadIntoScenario(scenarioId: string, data: SaveGameData): Promise<void> {
    const [nextSnapshot, assets] = await Promise.all([snapshotFor(scenarioId, savedDifficulty(data)), storyAssetsFor(scenarioId)]);
    activeSnapshot = nextSnapshot;
    cursorHex = null; // the keyboard cursor belongs to the board it was on
    session = GameSession.fromSaveData(nextSnapshot, data, SESSION_OPTIONS);
    session.interactionHost = interactionHost;
    storyParts = [];
    storyAssets = assets;
    currentMessage = null;
    screenTint = null;
    phase = session.scenarioResult ? 'ended' : 'playing';
    sync(fmt(tx('Loaded $name (turn $turn).'), { name: session.scenarioName, turn: data.turnNumber }));
  }

  async function handleDeleteSave(name: string): Promise<void> {
    try {
      await deleteSave(name);
      savesList = await listSaves();
      sync(`Deleted "${name}".`);
    } catch (err) {
      sync(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleRenameSave(from: string, to: string): Promise<void> {
    try {
      await renameSave(from, to);
      savesList = await listSaves();
      sync(`Renamed to "${to}".`);
    } catch (err) {
      sync(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Downloads a save as a real Wesnoth `.gz` file (`save/saveManager.ts`). */
  async function handleDownloadSave(name: string): Promise<void> {
    saveBusy = true;
    try {
      const file = await downloadSave(name, [...campaigns, ...(campaign ? [campaign] : [])], activeSnapshot);
      sync(`Downloaded "${file}".`);
    } catch (err) {
      sync(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      saveBusy = false;
    }
  }

  /** Uploads a save file: a real Wesnoth `.gz` or one of this port's own (`save/saveManager.ts`). */
  async function handleUploadSave(file: File): Promise<void> {
    saveBusy = true;
    try {
      const { name, data } = await importSaveFile(file);
      savesList = await listSaves();
      sync(`Imported "${name}" (turn ${data.turnNumber}).`);
    } catch (err) {
      sync(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      saveBusy = false;
    }
  }

  /** The difficulty a save was played at: its own, else the campaign's default (a save from before difficulties; a debug scenario has none). */
  function savedDifficulty(data: SaveGameData): string | undefined {
    return data.difficulty ?? defaultDifficulty(campaign);
  }

  /**
   * `scenarioId`'s snapshot at `difficulty` (default: this game's own), through the overlay-aware fetch.
   * Always the *current* campaign's own directory: a scenario next-, continue-, replay- or load-transitioned
   * to here never leaves the campaign this shell was opened for (a save whose own campaign differs is handed
   * to `onOpenSave` instead -- see `handleLoadNamed`).
   */
  function snapshotFor(scenarioId: string, difficulty: string | undefined = activeSnapshot.difficulty): Promise<GameBoardSnapshot> {
    if (!campaign) throw new Error(`cannot fetch scenario "${scenarioId}": this game was not opened with a campaign`);
    return fetchScenarioSnapshot(scenarioId, campaign.assetDir, difficulty, defaultDifficulty(campaign));
  }

  /** `scenarioId`'s story assets, in the current campaign's own directory -- see `snapshotFor`. */
  function storyAssetsFor(scenarioId: string): Promise<StoryAssets | null> {
    if (!campaign) return Promise.resolve(null);
    return fetchStoryAssets(scenarioId, campaign.assetDir);
  }

  // Phase 16: [message] highlights its speaker (the scroll to it, Phase 22, happens before the dialog opens -- `scrollToSpeaker`).
  // bugs6.md: and selects it for as long as the message is up -- message.lua's
  // `highlight_hex`, which also shows the unit in the sidebar
  // (`display_unit_hex`). Only the highlight and the sidebar: the speaker's
  // reach is not drawn, and the player's own selection comes back afterwards.
  // A narrator line clears it (`deselect_hex`).
  $effect(() => {
    const message = currentMessage?.message;
    const at = message?.speakerLocation;
    const speaker = at && message.highlight ? session.board.unitAt(new Location(at.x, at.y)) : undefined;
    untrack(() => {
      speakerHex = speaker ? { x: speaker.location.x, y: speaker.location.y } : null;
      if (speaker) session.inspectedUnit = speaker;
      syncHighlights();
    });
  });

  /** The story screen closed (last part passed, or skipped): now run the startup events, as upstream does after `story_viewer`. */
  function finishStory(): void {
    if (phase !== 'story') return;
    phase = 'playing';
    void runStartupEvents();
  }

  /**
   * Fetches the real next scenario (`session.nextScenarioId`, from the just-
   * finished scenario's own `[scenario] next_scenario=`) and transitions
   * this same `GameShell` instance into it via the real
   * `GameSession.startNextScenario` (real gold + recall-list carryover) --
   * see this file's module doc comment. Only callable from
   * `ScenarioEndOverlay`'s Continue button, which is itself only shown when
   * `session.scenarioResult === 'victory'` and a next scenario exists.
   */
  async function continueToNextScenario(): Promise<void> {
    if (session.scenarioResult !== 'victory') return;
    const nextId = session.nextScenarioId;
    if (!nextId) return;
    continuing = true;
    continueError = null;
    try {
      // The campaign carries its difficulty into every following scenario, as the real game does.
      const [nextSnapshot, nextStoryAssets] = await Promise.all([snapshotFor(nextId), storyAssetsFor(nextId)]);
      const nextSession = GameSession.startNextScenario(session, nextSnapshot, SESSION_OPTIONS);
      const nextStoryParts = nextSession.storyParts();

      activeSnapshot = nextSnapshot;
      cursorHex = null; // the keyboard cursor belongs to the board it was on
      session = nextSession;
      storyParts = nextStoryParts;
      storyAssets = nextStoryAssets;

      session.interactionHost = interactionHost;
      currentMessage = null;
      answerInteraction = null;
      screenTint = null;
      if (nextStoryParts.length === 0) {
        phase = 'playing';
        sync();
        void runStartupEvents();
      } else {
        phase = 'story';
        sync();
      }
    } catch (err) {
      continueError = err instanceof Error ? err.message : String(err);
    } finally {
      continuing = false;
    }
  }

  /**
   * Phase 14: the command registry (`commands.ts`) -- built here, not in
   * `commands.ts` itself, since every command closes over live session
   * state/handlers this module owns (see that file's own doc comment).
   * `menuCommands`/`actionCommands` feed `TopBar`'s two dropdowns exactly
   * as the old individual props did; `contextMenuCommands` feeds the new
   * right-click `ContextMenu`, reusing the very same handlers so both
   * surfaces can never drift apart.
   */
  // Phase 15: bindings are upstream's own (`wesnoth/data/core/hotkeys.cfg`); `ctrl` is Command on macOS,
  // matching that file's {IF_APPLE_CMD_ELSE_CTRL} macro.
  let menuCommands = $derived<Command[]>([
    {
      id: 'save',
      label: `${t('Save Game')}...`,
      enabled: phase === 'playing',
      handler: () => void openSaveManager('save'),
      hotkey: { key: 's', ctrl: true },
    },
    {
      id: 'load',
      label: `${t('Load Game')}...`,
      enabled: phase === 'playing' || phase === 'ended' || phase === 'replay',
      handler: () => void openSaveManager('load'),
      hotkey: { key: 'o', ctrl: true },
    },
    ...(onQuitToMenu
      ? [
          {
            id: 'quit-to-menu',
            label: t('Quit to Menu'),
            enabled: true,
            handler: () => (quitConfirmOpen = true),
          },
        ]
      : []),
    {
      id: 'mute',
      label: audioSettings.muted ? tx('Unmute') : t('Mute'),
      enabled: true,
      handler: () => changeAudio({ muted: !audioSettings.muted }),
    },
    {
      id: 'preferences',
      label: `${t('Preferences')}...`,
      enabled: true,
      handler: () => (preferencesOpen = true),
      hotkey: { key: 'p', ctrl: true },
    },
    {
      id: 'language',
      label: `${t('Language')}...`,
      enabled: true,
      handler: () => (languageDialogOpen = true),
    },
  ]);
  let actionCommands = $derived<Command[]>([
    // Upstream's Actions menu starts with it (`data/themes/default.cfg`); `t` in `hotkeys.cfg`.
    {
      id: 'continue',
      label: t('Continue Interrupted Move'),
      enabled: phase === 'playing' && canContinueMove,
      hotkey: { key: 't' },
      handler: () => void handleContinueMove(pointerHex ?? cursorHex),
    },
    {
      id: 'recruit',
      label: `${t('Recruit')}...`,
      enabled: recruitOptions.length > 0,
      hotkey: { key: 'r', ctrl: true },
      handler: () => {
        recruitOriginHex = null; // no specific hex -- lands on `session.autoRecruitTile` (see `handleConfirmRecruit`)
        recruitDialogOpen = true;
      },
    },
    {
      id: 'recall',
      label: `${t('Recall')}...`,
      enabled: recallOptions.length > 0,
      hotkey: { key: 'r', alt: true },
      handler: () => {
        recruitOriginHex = null;
        recallDialogOpen = true;
      },
    },
    // Upstream's Actions menu lists these right after recruit/recall (`data/themes/default.cfg`).
    { id: 'show-enemy-moves', label: t('Show Enemy Moves'), enabled: phase === 'playing', hotkey: { key: 'v', ctrl: true }, handler: () => showEnemyMoves(false) },
    { id: 'best-enemy-moves', label: t('Best Possible Enemy Moves'), enabled: phase === 'playing', hotkey: { key: 'b', ctrl: true }, handler: () => showEnemyMoves(true) },
    {
      id: 'label-team',
      label: `${tx('Place Label (Team)')}...`,
      enabled: phase === 'playing',
      hotkey: { key: 'l', ctrl: true },
      handler: () => openLabelDialog(lastHoveredHex ?? cursorHex, true),
    },
    {
      id: 'label',
      label: `${t('Place Label')}...`,
      enabled: phase === 'playing',
      hotkey: { key: 'l', alt: true },
      handler: () => openLabelDialog(lastHoveredHex ?? cursorHex, false),
    },
    {
      id: 'clear-labels',
      label: t('Clear Labels'),
      enabled: phase === 'playing',
      hotkey: { key: 'c', ctrl: true },
      handler: () => (clearLabelsConfirmOpen = true),
    },
    {
      id: 'label-settings',
      label: `${tx('Label Settings')}...`,
      enabled: phase === 'playing',
      handler: () => (labelSettingsOpen = true),
    },
    {
      id: 'objectives',
      label: t('Objectives'),
      enabled: session.scenarioObjectives !== null,
      hotkey: { key: 'j', ctrl: true },
      handler: () => (objectivesDialogOpen = true),
    },
    // Upstream's own bindings (hotkeys.cfg: undo=u, redo=r).
    { id: 'undo', label: t('Undo'), enabled: phase === 'playing' && canUndo, handler: () => void handleUndo(), hotkey: { key: 'u' } },
    { id: 'redo', label: t('Redo'), enabled: phase === 'playing' && canRedo, handler: () => void handleRedo(), hotkey: { key: 'r' } },
    { id: 'end-turn', label: t('End Turn'), enabled: phase === 'playing' && otherSidesTurn === null, handler: requestEndTurn, hotkey: { key: ' ', ctrl: true } },
  ]);

  /**
   * Real Wesnoth's right-click menu is per-hex context-sensitive (a
   * castle tile shows Recruit/Recall, a reachable hex shows Move Here, an
   * adjacent enemy shows Attack, ...) -- built fresh from `contextMenuAt`
   * each time the menu opens, delegating the actual move/attack/select
   * logic to `handleHexClick` (the exact same code path a real left click
   * on that hex already takes) rather than duplicating it.
   */
  let contextMenuCommands = $derived.by((): Command[] => {
    const at = contextMenuAt;
    const hexCommands: Command[] = [];
    if (at && phase === 'playing') {
      const { x, y } = at;
      const loc = new Location(x, y);
      const unitHere = session.board.unitAt(loc);
      const isReachable = !!session.selectedUnit && reachable.some((h) => h.x === x && h.y === y);
      const isAttackTarget = attackTargets.some((h) => h.x === x && h.y === y);
      const isRecruitTile = recruitTiles.some((h) => h.x === x && h.y === y);
      if (session.canContinueMove(x, y)) {
        hexCommands.push({ id: 'ctx-continue', label: t('Continue Interrupted Move'), enabled: true, handler: () => void handleContinueMove({ x, y }) });
      }
      if (unitHere && unitHere.side === activeSide && unitHere !== session.selectedUnit) {
        hexCommands.push({ id: 'ctx-select', label: tx('Select Unit'), enabled: true, handler: () => handleHexClick(x, y) });
      }
      if (unitHere && unitHere.side !== activeSide) {
        hexCommands.push({ id: 'ctx-inspect', label: tx('Unit Description'), enabled: true, handler: () => handleHexClick(x, y) });
      }
      hexCommands.push({ id: 'ctx-move', label: tx('Move Here'), enabled: isReachable, handler: () => handleHexClick(x, y) });
      hexCommands.push({ id: 'ctx-attack', label: t('Attack'), enabled: isAttackTarget, handler: () => handleHexClick(x, y) });
      hexCommands.push({
        id: 'ctx-recruit',
        label: `${t('Recruit')}...`,
        enabled: recruitOptions.length > 0 && isRecruitTile,
        handler: () => {
          recruitOriginHex = { x, y }; // bugs4.md #5: place directly on the hex the menu was opened from
          recruitDialogOpen = true;
        },
      });
      hexCommands.push({
        id: 'ctx-recall',
        label: `${t('Recall')}...`,
        enabled: recallOptions.length > 0 && isRecruitTile,
        handler: () => {
          recruitOriginHex = { x, y };
          recallDialogOpen = true;
        },
      });
      hexCommands.push({ id: 'ctx-label', label: `${t('Place Label')}...`, enabled: true, handler: () => openLabelDialog({ x, y }, false) });
      // Real `[set_menu_item]` entries the scenario's own WML declared --
      // see `GameSession.menuItems`'s own doc comment on why these are
      // offered unconditionally rather than per-hex-filtered.
      for (const item of session.menuItems) {
        hexCommands.push({
          id: `wml-${item.id}`,
          label: item.label,
          enabled: true,
          handler: () => void runPlayerAction(() => session.runMenuItem(item.id, x, y)).then((m) => sync(m)),
        });
      }
    }
    return [...hexCommands, ...actionCommands.filter((c) => c.id === 'objectives' || c.id === 'end-turn')];
  });

  /**
   * Phase 15 H2: the player's own units that can still do something this
   * turn, in the order `n`/`shift+n` walk them. Upstream cycles in unit
   * order; this sorts by hex (top-left to bottom-right) so the order is
   * stable and predictable rather than depending on spawn order.
   */
  function cyclableUnits(): Unit[] {
    return session.board
      .unitsForSide(activeSide)
      .filter((u) => {
        const { canMove, canAttackHere } = unitCanAct(session.board, u);
        return canMove || canAttackHere;
      })
      .sort((a, b) => a.location.y - b.location.y || a.location.x - b.location.x);
  }

  /** `n` / `shift+n` (upstream `cycle`/`cycleback`): select the next unit that can act and bring it into view. */
  function cycleUnit(step: 1 | -1): void {
    const candidates = cyclableUnits();
    if (candidates.length === 0) return;
    const current = session.selectedUnit;
    const currentIndex = current ? candidates.indexOf(current) : -1;
    // From no selection, `n` starts at the first unit and `shift+n` at the last.
    const nextIndex =
      currentIndex === -1
        ? step === 1
          ? 0
          : candidates.length - 1
        : (currentIndex + step + candidates.length) % candidates.length;
    const unit = candidates[nextIndex]!;
    session.selectUnit(unit);
    boardView?.centerOnHex(unit.location.x, unit.location.y);
    sync();
  }

  /** `l` (upstream `leader`): centre the view on this side's leader, without changing the selection. */
  function scrollToLeader(): void {
    const leader = session.board.unitsForSide(activeSide).find((u) => u.canRecruit);
    if (leader) boardView?.centerOnHex(leader.location.x, leader.location.y);
  }

  /**
   * Phase 15 H3: the keyboard hex cursor -- `null` until an arrow key
   * first summons it, so a mouse-only player never sees it. Arrow keys
   * move it, Enter does exactly what a left click on that hex does, and
   * Escape puts it away again.
   *
   * Arrows map to the storage grid, not to hex directions: left/right
   * step one column (which zig-zags half a hex vertically on screen, as
   * offset coordinates do), up/down step one row. That keeps four keys
   * enough to reach every hex, which six hex directions on four arrows
   * could not.
   */
  let cursorHex = $state<HexPoint | null>(null);

  /** Where the cursor appears when summoned: the selected unit, else this side's leader, else the map's top-left. */
  function cursorAnchor(): HexPoint {
    const unit = session.selectedUnit ?? session.board.unitsForSide(activeSide).find((u) => u.canRecruit);
    return unit ? { x: unit.location.x, y: unit.location.y } : { x: 0, y: 0 };
  }

  function moveCursor(dx: number, dy: number): void {
    const width = session.board.map.w();
    const height = session.board.map.h();
    if (!cursorHex) {
      // First press only summons it, at the anchor -- jumping a hex away from
      // where the player is looking would be disorienting.
      cursorHex = cursorAnchor();
    } else {
      cursorHex = {
        x: Math.min(width - 1, Math.max(0, cursorHex.x + dx)),
        y: Math.min(height - 1, Math.max(0, cursorHex.y + dy)),
      };
    }
    hoveredHexInfo = session.hoveredHexInfo(cursorHex.x, cursorHex.y);
    cursorAnnouncement = session.describeHex(cursorHex.x, cursorHex.y);
    // Upstream's keyboard cursor is the mouse's hex: the same footsteps and attack direction follow it.
    pointerMovedTo(cursorHex);
    // Instant: a held arrow key would otherwise restart a glide from rest on every repeat.
    void boardView?.scrollToHexIfOffscreen(cursorHex.x, cursorHex.y, true);
  }

  /**
   * Phase 15: commands with no menu entry -- upstream has no menu entry
   * for these either (`data/themes/default.cfg` lists none of them),
   * they exist purely as hotkeys.
   */
  let hotkeyOnlyCommands = $derived<Command[]>([
    { id: 'next-unit', label: t('Next Unit'), enabled: phase === 'playing', hotkey: { key: 'n' }, handler: () => cycleUnit(1) },
    { id: 'previous-unit', label: t('Previous Unit'), enabled: phase === 'playing', hotkey: { key: 'n', shift: true }, handler: () => cycleUnit(-1) },
    { id: 'leader', label: t('Scroll to Leader'), enabled: phase === 'playing', hotkey: { key: 'l' }, handler: scrollToLeader },
    { id: 'zoom-in', label: t('Zoom In'), enabled: true, hotkey: { key: '=' }, handler: () => boardView?.zoomStep(true) },
    // Upstream binds zoomin twice, to both `=` and `+` (the shifted key on most layouts).
    { id: 'zoom-in-shifted', label: t('Zoom In'), enabled: true, hotkey: { key: '+', shift: true }, handler: () => boardView?.zoomStep(true) },
    { id: 'zoom-out', label: t('Zoom Out'), enabled: true, hotkey: { key: '-' }, handler: () => boardView?.zoomStep(false) },
    { id: 'zoom-default', label: t('Default Zoom'), enabled: true, hotkey: { key: '0' }, handler: () => boardView?.zoomDefault() },
    // The game theme has no menu entry for the grid either; upstream's is a hotkey (and a preference).
    { id: 'toggle-grid', label: t('Toggle Grid'), enabled: true, hotkey: { key: 'g', ctrl: true }, handler: () => displayPrefs.update({ grid: !displayPrefs.peek().grid }) },
    { id: 'cursor-left', label: tx('Cursor Left'), enabled: phase === 'playing', hotkey: { key: 'ArrowLeft' }, handler: () => moveCursor(-1, 0) },
    { id: 'cursor-right', label: tx('Cursor Right'), enabled: phase === 'playing', hotkey: { key: 'ArrowRight' }, handler: () => moveCursor(1, 0) },
    { id: 'cursor-up', label: tx('Cursor Up'), enabled: phase === 'playing', hotkey: { key: 'ArrowUp' }, handler: () => moveCursor(0, -1) },
    { id: 'cursor-down', label: tx('Cursor Down'), enabled: phase === 'playing', hotkey: { key: 'ArrowDown' }, handler: () => moveCursor(0, 1) },
    {
      id: 'cursor-act',
      label: tx('Select / Move / Attack'),
      enabled: phase === 'playing' && cursorHex !== null,
      hotkey: { key: 'Enter' },
      // The same path a left click takes, so keyboard and mouse can never diverge.
      handler: () => {
        if (cursorHex) void handleHexClick(cursorHex.x, cursorHex.y, { attackFrom: session.attackFrom(cursorHex, previousHex, previousFreeHex) });
      },
    },
    {
      id: 'deselect',
      label: tx('Deselect'),
      enabled: phase === 'playing',
      hotkey: { key: 'Escape' },
      handler: () => {
        session.clearSelection();
        cursorHex = null;
        hoveredHexInfo = null;
        cursorAnnouncement = '';
        sync();
      },
    },
  ]);

  /**
   * Phase 15: the commands a keypress can reach right now. The context
   * menu's are left out: they are per-hex and reached by right-clicking
   * that hex, exactly as upstream (its entries have no hotkeys either).
   */
  let hotkeyCommands = $derived<Command[]>([...menuCommands, ...actionCommands, ...hotkeyOnlyCommands]);

  /** A dialog owns the keyboard while it's open (`Modal` handles Escape/Tab/focus itself). */
  function dialogOpen(): boolean {
    return (
      recruitDialogOpen ||
      recallDialogOpen ||
      objectivesDialogOpen ||
      saveDialogOpen ||
      loadDialogOpen ||
      labelDialog !== null ||
      clearLabelsConfirmOpen ||
      endTurnConfirmOpen ||
      quitConfirmOpen ||
      labelSettingsOpen ||
      preferencesOpen ||
      languageDialogOpen ||
      pendingAdvancement !== null ||
      pendingPreview !== null ||
      // Phase 17: a suspended event's own dialogue owns the keyboard
      // while it is up (`MessageViewer` handles arrows/Enter/Escape).
      currentMessage !== null
    );
  }

  /** Typing in a field must never trigger a game hotkey -- Phase 17's `[text_input]` is the first one. */
  function isTypingTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || typeof el.tagName !== 'string') return false;
    const tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
  }

  /**
   * Phase 15: the one global hotkey dispatcher. Everything goes through
   * the same `Command` objects the menu bar and context menu use, so a
   * binding can never drift from what the menu entry does.
   *
   * A disabled command still swallows its key (`preventDefault`) rather
   * than letting the browser act on it -- Ctrl+S must not open "save
   * page" just because saving happens to be unavailable this moment.
   */
  function handleGlobalKeydown(e: KeyboardEvent): void {
    if (e.repeat || e.defaultPrevented) return;
    // 'story'/'ended' have their own keyboard handling (StoryViewer, Outro);
    // a suspended event's dialogue is handled by MessageViewer.
    if (phase !== 'playing' || eventsRunning) return;
    if (dialogOpen() || contextMenuAt !== null || isTypingTarget(e.target)) return;
    // Enter or Space on a focused button is that button's own activation (a keyboard user who Tabbed to
    // Menu or End Turn), not the cursor's "select / move / attack".
    const target = e.target as HTMLElement | null;
    if ((e.key === 'Enter' || e.key === ' ') && !e.ctrlKey && !e.metaKey && !e.altKey && target?.closest?.('button, a[href], [role="button"]')) return;
    const command = hotkeyCommands.find((c) => c.hotkey && matchesHotkey(e, c.hotkey));
    if (!command) return;
    e.preventDefault();
    if (command.enabled) command.handler();
  }
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="game-shell">
  <!-- Polite live region for the keyboard cursor's hex; visually hidden. -->
  <div class="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="cursor-announcement">{cursorAnnouncement}</div>
  <TopBar
    scenarioName={ts(session.scenarioNameT)}
    {turnNumber}
    {activeSide}
    {scenarioTurnsLimit}
    {timeOfDay}
    {gold}
    {economyInfo}
    {menuCommands}
    {actionCommands}
    muted={audioSettings.muted}
    onToggleMute={() => changeAudio({ muted: !audioSettings.muted })}
    collapsed={displayPrefs.value.topBarCollapsed}
    onToggleCollapsed={() => displayPrefs.update({ topBarCollapsed: !displayPrefs.peek().topBarCollapsed })}
  />
  <div class="main">
    <!--
      Keyed on scenario id: GameBoardView's own doc comment says its
      `snapshot` prop is "read once at mount, never re-applied after" --
      true by design for ordinary play, but `continueToNextScenario`
      reassigns `activeSnapshot` to a genuinely different scenario (own
      map/terrain/teams), which that mount effect has no way to notice
      (it only tracks `canvasHost`, not `snapshot`). `{#key}` forces Svelte
      to destroy and recreate the whole component -- and so its PixiJS
      app/SnapshotBoard -- on a real scenario change, giving a clean fresh
      mount against the RIGHT map instead of silently reusing the previous
      scenario's stale terrain underneath the new scenario's units. (Scenario
      1 and 2 happen to share the same map file, so this bug was invisible
      in a 1->2 Playwright check specifically -- confirmed by inspection,
      not by a screenshot that would've looked identical either way.)
    -->
    {#key activeSnapshot.scenario.id}
      <GameBoardView
        bind:this={boardView}
        snapshot={activeSnapshot}
        onViewportResize={() => boardResizeTick++}
        onSound={(files) => audio.playSound({ files, repeats: 0, group: 'sound' })}
        {units}
        {selectedHex}
        cursorHex={cursorHex ?? armedMove}
        reachable={enemyReach?.hexes ?? hoverReach ?? reachable}
        {attackTargets}
        {route}
        {attackIndicator}
        grid={displayPrefs.value.grid}
        {villageOwners}
        terrain={terrainHexes}
        items={mapItems}
        labels={mapLabels}
        {hexVisibility}
        {timeOfDay}
        onHexClick={handleBoardHexClick}
        onHexRightClick={handleHexRightClick}
        onHexHoverChange={handleHexHoverChange}
        hoverDefensePercent={(x, y) => session.defensePercentAt(x, y)}
        paused={phase === 'story'}
        onViewChange={(state) => (cameraState = state)}
        edgeScroll={(phase === 'playing' || phase === 'replay') && !dialogOpen() && contextMenuAt === null}
      />
    {/key}
    <SidePanel {selected} {inspected} {statusMessage} {log} {recruitOptions} {recallOptions} {hoveredHexInfo} onEndTurn={requestEndTurn} {turnButton} onSkipAnimation={skipAnimations}
      collapsed={displayPrefs.value.infoboxCollapsed}
      onToggleCollapsed={() => displayPrefs.update({ infoboxCollapsed: !displayPrefs.peek().infoboxCollapsed })}
    >
      {#snippet top()}
        <Minimap
          input={minimapInput}
          options={displayPrefs.value.minimap}
          style={minimapStyle}
          camera={cameraState}
          onNavigate={(point) => boardView?.centerOnWorldPoint(point)}
          onToggle={(key) => displayPrefs.update({ minimap: { [key]: !displayPrefs.peek().minimap[key] } })}
          onZoomDefault={() => boardView?.zoomDefault()}
        />
      {/snippet}
    </SidePanel>
  </div>

  {#if contextMenuAt}
    <ContextMenu x={contextMenuAt.clientX} y={contextMenuAt.clientY} commands={contextMenuCommands} onClose={closeContextMenu} />
  {/if}

  {#if pendingPreview}
    <AttackDialog
      preview={pendingPreview}
      {attackerWeaponOptions}
      onConfirm={handleConfirmAttack}
      onCancel={handleCancelAttack}
      onSelectAttackerWeapon={handleSelectAttackerWeapon}
    />
  {/if}

  {#if recruitDialogOpen}
    <RecruitDialog
      options={recruitOptions}
      {gold}
      onRecruit={handleConfirmRecruit}
      onCancel={() => {
        recruitDialogOpen = false;
        recruitOriginHex = null;
      }}
    />
  {/if}

  {#if recallDialogOpen}
    <RecallDialog
      options={recallOptions}
      {gold}
      onRecall={handleConfirmRecall}
      onDismiss={handleDismissRecall}
      onRename={handleRenameRecall}
      onCancel={() => {
        recallDialogOpen = false;
        recruitOriginHex = null;
      }}
    />
  {/if}

  {#if currentMessage}
    <!-- Phase 17: one line at a time, with the event that raised it suspended behind it. -->
    <MessageViewer
      interaction={currentMessage}
      onAnswer={answerMessage}
      assets={storyAssets}
      getMapRect={() => boardView?.viewportRect() ?? null}
      layoutTick={boardResizeTick}
    />
  {/if}

  {#if screenTint}
    <!-- [color_adjust]/[screen_fade]: a plain overlay, transitioned over the fade's own duration. -->
    <div
      class="screen-tint"
      style:background="rgb({screenTint.r}, {screenTint.g}, {screenTint.b})"
      style:opacity={screenTint.a}
      style:transition-duration="{screenTint.ms}ms"
    ></div>
  {/if}

  {#if objectivesDialogOpen && session.scenarioObjectives}
    <!-- Phase 14: reopened on demand from the top bar's Actions menu, independent of the `phase` state machine's own one-time automatic showing (below). -->
    <ObjectivesDialog
      scenarioName={ts(session.scenarioNameT)}
      objectives={session.scenarioObjectives}
      currentTurn={turnNumber}
      turnsLimit={scenarioTurnsLimit}
      onClose={() => (objectivesDialogOpen = false)}
    />
  {/if}

  {#if labelDialog}
    <LabelDialog
      initialText={labelDialog.text}
      initialTeamOnly={labelDialog.teamOnly}
      onPlace={placeLabel}
      onCancel={() => (labelDialog = null)}
    />
  {/if}
  {#if labelSettingsOpen}
    <LabelSettingsDialog
      categories={session.labelCategories}
      sideColors={new Map(
        activeSnapshot.teams.map((t) => [t.side, `rgb(${sideColorRgb(ImageCache.getColorData(), t.color ?? '', t.side) ?? '255,255,255'})`]),
      )}
      onApply={(hidden) => {
        labelSettingsOpen = false;
        session.hiddenLabelCategories = hidden;
        sync();
      }}
      onCancel={() => (labelSettingsOpen = false)}
    />
  {/if}
  {#if quitConfirmOpen}
    <ConfirmDialog
      title={tw('Quit')}
      message={tw('Do you really want to quit?')}
      onYes={() => {
        quitConfirmOpen = false;
        onQuitToMenu?.();
      }}
      onNo={() => (quitConfirmOpen = false)}
    />
  {/if}
  {#if endTurnConfirmOpen}
    <ConfirmDialog
      title={t('End Turn')}
      message={tw('You have not started your turn yet. Do you really want to end your turn?')}
      onYes={() => {
        endTurnConfirmOpen = false;
        void handleEndTurn();
      }}
      onNo={() => (endTurnConfirmOpen = false)}
    />
  {/if}
  {#if clearLabelsConfirmOpen}
    <ConfirmDialog
      title={t('Clear Labels')}
      message={tx('Are you sure you want to clear map labels?')}
      onYes={() => {
        clearLabelsConfirmOpen = false;
        session.clearLabels();
        sync();
      }}
      onNo={() => (clearLabelsConfirmOpen = false)}
    />
  {/if}
  {#if saveDialogOpen}
    <SaveGameDialog
      suggestedName={manualSaveName(
        scenarioLabel(campaignAbbrev(campaign), session.scenarioName),
        session.turnNumber,
      )}
      existingNames={savesList.map((s) => s.name)}
      onSave={(name) => void handleSaveAs(name)}
      onCancel={() => (saveDialogOpen = false)}
    />
  {/if}

  {#if loadDialogOpen}
    <LoadGameDialog
      saves={savesList}
      campaignNames={Object.fromEntries(
        [...campaigns, ...(campaign ? [campaign] : [])].map((c) => [c.id, c.nameT ? ts(c.nameT) : c.name]),
      )}
      busy={saveBusy}
      onLoad={(name, showReplay) => void handleLoadNamed(name, showReplay)}
      onDelete={(name) => void handleDeleteSave(name)}
      onRename={(from, to) => void handleRenameSave(from, to)}
      onDownload={(name) => void handleDownloadSave(name)}
      onUpload={(file) => void handleUploadSave(file)}
      onCancel={() => (loadDialogOpen = false)}
    />
  {/if}

  {#if languageDialogOpen}
    <LanguageDialog onClose={() => (languageDialogOpen = false)} />
  {/if}
  {#if preferencesOpen}
    <PreferencesDialog audioSettings={audioSettings} onAudioChange={changeAudio} onClose={() => (preferencesOpen = false)} />
  {/if}

  {#if phase === 'story'}
    {#key session}
      <StoryViewer parts={storyParts} assets={storyAssets} onDone={finishStory} onPartShown={playStoryPartSounds} />
    {/key}
  {:else if phase === 'objectives' && session.scenarioObjectives}
    <ObjectivesDialog
      scenarioName={ts(session.scenarioNameT)}
      objectives={session.scenarioObjectives}
      currentTurn={turnNumber}
      turnsLimit={scenarioTurnsLimit}
      onClose={advanceObjectives}
    />
  {:else if phase === 'ended' && session.scenarioResult && !pendingAdvancement}
    <!--
      `!pendingAdvancement` guard: a kill that both wins the scenario AND
      grants the killer a level-up choice is real (GameSession.confirmAttack
      checks advancement before checkForGameEnd, mirroring real Wesnoth's
      attack_unit_and_advance) -- without this, ScenarioEndOverlay (z-index
      200) would render on top of AdvancementDialog (100) and leave the
      player unable to ever resolve the pending choice. Once
      chooseAdvancement clears it, this branch shows normally.
    -->
    {#if showOutro}
      <!-- Phase 16 N7: the campaign's last victory rolls the outro first, as playcampaign.cpp does. -->
      <Outro
        screens={buildOutroScreens(session.endLevelPresentation?.endText, true, outroCredits)}
        holdMs={outroHoldMs(session.endLevelPresentation?.endTextDuration)}
        onDone={() => (outroDone = true)}
      />
    {:else}
      <ScenarioEndOverlay
        result={session.scenarioResult}
        {turnNumber}
        {gold}
        nextScenarioAvailable={session.scenarioResult === 'victory' && session.nextScenarioId !== null}
        {continuing}
        {continueError}
        onContinue={continueToNextScenario}
        {onQuitToMenu}
      />
    {/if}
  {/if}

  <AdvancementDialog pending={pendingAdvancement} onChoose={handleChooseAdvancement} />

  {#if phase === 'replay' && replay}
    <div class="replay-bar" role="toolbar" aria-label={tx('Replay controls')} data-testid="replay-bar">
      <span class="replay-label">{t('Replay')}</span>
      <button onclick={toggleReplayPlaying} disabled={replay.index >= replay.total} data-testid="replay-play">
        {replay.playing ? tx('Pause') : tw('Play')}
      </button>
      <button onclick={() => void restartReplay()} data-testid="replay-restart">{tx('Restart')}</button>
      <span class="replay-progress" data-testid="replay-progress">{replay.index} / {replay.total}</span>
      {#if !replay.playing && replay.index >= replay.total}
        <button onclick={continueFromReplay} data-testid="replay-continue">{tx('Continue playing')}</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* Phase 17: [color_adjust]/[screen_fade] over the whole shell. */
  .screen-tint {
    position: fixed;
    inset: 0;
    z-index: 300;
    pointer-events: none;
    transition-property: opacity;
    transition-timing-function: linear;
  }

  /* Phase 18b R5: the replay viewer's controls, floating over the top of the board. */
  .replay-bar {
    position: fixed;
    top: 3rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 250;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.6rem;
    background: rgba(14, 20, 32, 0.92);
    border: 1px solid #4a4432;
    border-radius: 4px;
    color: #eee;
    font-size: 0.9rem;
  }
  .replay-label {
    font-weight: 700;
    color: #e4c860;
  }
  .replay-progress {
    min-width: 5rem;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  .game-shell {
    direction: ltr; /* Wesnoth does not mirror its GUI for right-to-left languages; text runs pick their own direction (dir="auto") */
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .main {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }
  /* A phone: the side panel goes under the board instead of squeezing it into a strip. */
  @media (max-width: 720px) {
    .main {
      flex-direction: column;
    }
  }
</style>
