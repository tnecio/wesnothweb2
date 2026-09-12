<script lang="ts">
  /**
   * Top-level game shell: owns one `GameSession` (see gameSession.ts) and
   * bridges it into Svelte's reactivity for TurnBanner/GameBoardView/
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
  import type { GameBoardSnapshot, SnapshotUnit, RecordedMessage, TimeOfDayEntry, Unit, AiAnimationEvent, ScenarioObjectives } from '@wesnothweb2/engine';
  import { WmlConfig, directionBetween } from '@wesnothweb2/engine';
  import {
    type HexPoint,
    type UnitAnimationCue,
    type AnimationContext,
    parseUnitAnimations,
    chooseAnimation,
    buildAttackAnimationContexts,
    buildMovementAnimationContexts,
    terrainLookup,
    spriteKey,
  } from '@wesnothweb2/renderer';
  import {
    GameSession,
    parseScenarioTurnsLimit,
    type CombatPreview,
    type SelectedUnitInfo,
    type RecruitOption,
    type RecallOption,
    type AttackerWeaponOption,
    type SaveGameData,
    type EconomyInfo,
    type VillageOwnerInfo,
    type ReachableHexPoint,
    type LastAttackAnimation,
    type LastMoveAnimation,
    type LastRecruitAnimation,
    type PendingAdvancement,
  } from './gameSession.js';
  import { saveGame, loadGame } from './persistence.js';
  import TurnBanner from './TurnBanner.svelte';
  import GameBoardView from './GameBoardView.svelte';
  import SidePanel from './SidePanel.svelte';
  import StoryViewer from './StoryViewer.svelte';
  import MessageViewer from './MessageViewer.svelte';
  import AdvancementDialog from './AdvancementDialog.svelte';
  import ObjectivesDialog from './ObjectivesDialog.svelte';
  import ScenarioEndOverlay from './ScenarioEndOverlay.svelte';

  let { snapshot }: { snapshot: GameBoardSnapshot } = $props();

  /** The scenario currently being played -- reassigned by `continueToNextScenario`. Everything below that used to read the `snapshot` prop directly now reads this instead. */
  let activeSnapshot = $state(snapshot);
  /** Bound `GameBoardView` instance, so `handleConfirmAttack`/`handleHexClick` can await its imperative `playAnimationSequence` before applying a resolved attack's/move's final state -- see that method's own doc comment. Reassigned across a scenario transition (the `{#key}` block around `<GameBoardView>` remounts it), so `$state`, not a plain `let`, same reasoning as `board` in `GameBoardView.svelte` itself. */
  let boardView: GameBoardView | undefined = $state();
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
  let session = $state.raw(new GameSession(activeSnapshot));
  let storyParts = $derived(activeSnapshot.story ?? []);
  /** Single fixed slot for MVP simplicity -- see persistence.ts's doc comment; keyed by scenario so a future multi-scenario build doesn't collide saves across scenarios. */
  let saveSlot = $derived(`quicksave:${activeSnapshot.scenario.id}`);
  let scenarioTurnsLimit = $derived(parseScenarioTurnsLimit(activeSnapshot.scenarioConfigJson.attrs['turns']));

  let continuing = $state(false);
  let continueError = $state<string | null>(null);

  let phase = $state<'story' | 'objectives' | 'messages' | 'playing' | 'ended'>(storyParts.length > 0 ? 'story' : 'messages');
  let storyIndex = $state(0);
  let startupMessages = $state<RecordedMessage[]>([]);
  let messageIndex = $state(0);

  let units = $state<SnapshotUnit[]>(session.renderUnits);
  let selected = $state<SelectedUnitInfo | null>(null);
  /** The currently-inspected unit's view-model (see `GameSession.inspectedUnit`) -- any unit clicked purely to view its info, independent of `selected`. */
  let inspected = $state<SelectedUnitInfo | null>(null);
  let selectedHex = $state<HexPoint | null>(null);
  let reachable = $state<ReachableHexPoint[]>([]);
  let attackTargets = $state<HexPoint[]>([]);
  let recruitTiles = $state<HexPoint[]>([]);
  let recruitOptions = $state<RecruitOption[]>([]);
  let pendingRecruitTypeId = $state<string | null>(null);
  let recallOptions = $state<RecallOption[]>([]);
  let pendingRecallIndex = $state<number | null>(null);
  let pendingPreview = $state<CombatPreview | null>(null);
  let pendingAdvancement = $state<PendingAdvancement | null>(null);
  let attackerWeaponOptions = $state<AttackerWeaponOption[]>([]);
  let log = $state<string[]>([]);
  let turnNumber = $state(session.turnNumber);
  let activeSide = $state(session.activeSide);
  let gold = $state(session.board.getTeam(session.activeSide)?.gold ?? 0);
  let economyInfo = $state<EconomyInfo>(session.economyInfo);
  let villageOwners = $state<VillageOwnerInfo[]>(session.villageOwnership);
  let timeOfDay = $state<TimeOfDayEntry>(session.currentTimeOfDay);
  let statusMessage = $state('Click one of your units to select it.');

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

  /** Re-derives every `$state` view from `session`'s current (just-mutated) state. Call after every session mutation. */
  function sync(message?: string | null): void {
    units = session.renderUnits;
    selected = selectedInfo();
    inspected = inspectedInfo();
    selectedHex = session.selectedUnit ? { x: session.selectedUnit.location.x, y: session.selectedUnit.location.y } : null;
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
    turnNumber = session.turnNumber;
    activeSide = session.activeSide;
    gold = session.board.getTeam(session.activeSide)?.gold ?? 0;
    economyInfo = session.economyInfo;
    villageOwners = session.villageOwnership;
    timeOfDay = session.currentTimeOfDay;

    if (session.scenarioResult) {
      statusMessage = session.scenarioResult === 'victory' ? 'Victory!' : 'Defeat.';
    } else if (message) {
      statusMessage = message;
    } else if (pendingPreview) {
      statusMessage = 'Review the attack prediction, then confirm or cancel.';
    } else if (pendingRecruitTypeId) {
      statusMessage = 'Click a green-highlighted castle tile to place your recruit.';
    } else if (pendingRecallIndex !== null) {
      statusMessage = 'Click a green-highlighted castle tile to place your recalled unit.';
    } else if (selected) {
      statusMessage = `${selected.name} selected.`;
    } else {
      statusMessage = 'Click one of your units to select it.';
    }

    // Latches once `session.checkForGameEnd()` (run after any kill --
    // see `confirmAttack`) sets a result; `phase` only ever moves forward
    // to 'ended' from here, never back (scenarioResult itself never
    // un-latches either -- see GameSession's own doc comment).
    if (session.scenarioResult && phase !== 'ended') phase = 'ended';
  }

  /**
   * Real, reported bug (bugs2.md "Lua events/narration ... not synced
   * with the narrative messages"): while `phase === 'messages'`, `units`
   * should reflect `startupMessages[messageIndex]`'s own checkpoint (see
   * `GameSession.messageUnitSnapshot`'s doc comment) -- e.g. Gwabbo only
   * appears from the message where his `[unit]` spawn already precedes
   * it, not from message 0. `sync()` itself always sets the board's
   * fully-resolved final state (needed for every OTHER phase and for
   * every non-`units` field `sync()` touches), so this runs right after
   * it to override just `units`, specifically for this phase.
   */
  function applyMessagePhaseUnits(): void {
    if (phase !== 'messages') return;
    const message = startupMessages[messageIndex];
    units = message ? session.messageUnitSnapshot(message) : session.renderUnits;
  }

  /**
   * Real, reported bug (bugs3.md "objectives dialog"): a scenario's real
   * `[objectives]` (see `GameSession.scenarioObjectives`'s own doc
   * comment) used to have no dialog to show it in at all. Ordered before
   * 'messages': real Wesnoth's own event order fires `[objectives]`
   * (usually in `prestart`) before the dialogue that follows it (usually
   * in `start`), so this reads chronologically first here too, even
   * though both already fully ran by the time either phase shows
   * anything (`runStartupEvents` is synchronous -- see that method's own
   * doc comment).
   */
  function decidePostEventsPhase(): 'objectives' | 'messages' | 'playing' {
    if (session.scenarioObjectives) return 'objectives';
    if (startupMessages.length > 0) return 'messages';
    return 'playing';
  }

  function advanceObjectives(): void {
    phase = startupMessages.length > 0 ? 'messages' : 'playing';
    applyMessagePhaseUnits();
  }

  // No story: run the startup events immediately so the board/side panel
  // reflect the real event-spawned units from the very first render, and
  // go straight to 'objectives' (if the events set any), else 'messages',
  // else 'playing'.
  if (storyParts.length === 0) {
    startupMessages = session.runStartupEvents();
    phase = decidePostEventsPhase();
    sync();
    applyMessagePhaseUnits();
  }

  /** Shows `[message]`s that in-play events (moveto, sighted, turn N, ...) recorded during the last action. */
  function showEventMessages(): void {
    const pending = session.takeEventMessages();
    if (pending.length === 0) return;
    startupMessages = pending;
    messageIndex = 0;
    phase = 'messages';
    applyMessagePhaseUnits();
  }

  async function handleHexClick(x: number, y: number): Promise<void> {
    if (phase !== 'playing') return;
    const message = session.handleHexClick(x, y);
    const move = session.lastMoveAnimation;
    session.lastMoveAnimation = null;
    if (move && boardView) {
      // 2x speed: real authored movement_anim timing (e.g. a 600ms walk
      // cycle per hex) reads as sluggish for a UI where the player is
      // routinely moving units several hexes at once -- unlike an
      // attack blow, there's no real per-frame content (damage numbers,
      // hit/miss) worth lingering on here.
      await boardView.playAnimationSequence(buildMoveAnimationCues(move), 2);
    }
    const recruit = session.lastRecruitAnimation;
    session.lastRecruitAnimation = null;
    if (recruit && boardView) {
      await boardView.playAnimationSequence(buildRecruitAnimationCues(recruit));
    }
    sync(message);
    showEventMessages();
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

    const attackerAnims = animationsFor(info.attacker.type.id);
    const defenderAnims = animationsFor(info.defender.type.id);
    const attackerKey = spriteKey({
      underlyingId: session.renderKeyFor(info.attacker),
      typeId: info.attacker.type.id,
      x: info.attacker.location.x,
      y: info.attacker.location.y,
    });
    const defenderKey = spriteKey({
      underlyingId: session.renderKeyFor(info.defender),
      typeId: info.defender.type.id,
      x: info.defender.location.x,
      y: info.defender.location.y,
    });
    const attackerHex = { x: info.attacker.location.x, y: info.attacker.location.y };
    const defenderHex = { x: info.defender.location.x, y: info.defender.location.y };

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

    const cues = contexts.map(({ attackerContext, defenderContext }) => {
      const strikerRes = resourcesFor(attackerContext.myUnit);
      const receiverRes = resourcesFor(defenderContext.myUnit);
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
   * Builds one cue per real step of `info.path` (each hex-to-hex leg its
   * own "movement" `AnimationContext`, matching real per-step animation
   * re-selection -- terrain/direction can differ leg to leg), for
   * `GameBoardView.playAnimationSequence`. Each cue's `direction` is the
   * REAL direction of travel for THAT specific leg, computed directly
   * from the path -- not `unit.facing`, which `executeMove` only ever
   * sets ONCE, from the last two hexes of the whole move (a documented
   * simplification of this project's `move.ts`, never exercised until
   * movement animation needed a real per-step facing). `restAt: 'dst'`
   * on every cue: unlike an attack's lunge-and-return, each leg of a
   * move actually relocates the unit.
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

    return contexts.map((ctx, i) => {
      const from = info.path[i]!;
      const to = info.path[i + 1]!;
      const direction = directionBetween(from, to) ?? info.unit.facing;
      return [
        {
          key,
          anim: chooseAnimation(anims, ctx),
          direction,
          srcHex: { x: from.x, y: from.y },
          dstHex: { x: to.x, y: to.y },
          restAt: 'dst' as const,
        },
      ];
    });
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
      x: info.unit.location.x,
      y: info.unit.location.y,
    });
    const leaderKey = spriteKey({
      underlyingId: session.renderKeyFor(info.leader),
      typeId: info.leader.type.id,
      x: info.leader.location.x,
      y: info.leader.location.y,
    });
    const unitHex = { x: info.unit.location.x, y: info.unit.location.y };
    const leaderHex = { x: info.leader.location.x, y: info.leader.location.y };

    const unitContext: AnimationContext = {
      loc: info.unit.location,
      secondLoc: info.leader.location,
      myUnit: info.unit,
      event: 'recruited',
      value: 0,
      value2: 0,
      hit: 'invalid',
      terrainAtLoc: terrainAt(info.unit.location),
    };
    const leaderContext: AnimationContext = {
      loc: info.leader.location,
      secondLoc: info.unit.location,
      myUnit: info.leader,
      event: 'recruiting',
      value: 0,
      value2: 0,
      hit: 'invalid',
      terrainAtLoc: terrainAt(info.leader.location),
    };

    return [
      [
        {
          key: unitKey,
          anim: chooseAnimation(animationsFor(info.unit.type.id), unitContext),
          direction: info.unit.facing,
          srcHex: unitHex,
          dstHex: leaderHex,
        },
        {
          key: leaderKey,
          anim: chooseAnimation(animationsFor(info.leader.type.id), leaderContext),
          direction: directionBetween(info.leader.location, info.unit.location) ?? info.leader.facing,
          srcHex: leaderHex,
          dstHex: unitHex,
        },
      ],
    ];
  }

  async function handleConfirmAttack(): Promise<void> {
    if (phase !== 'playing') return;
    const message = session.confirmAttack();
    const anim = session.lastAttackAnimation;
    session.lastAttackAnimation = null;
    if (anim && boardView) {
      await boardView.playAnimationSequence(buildBlowAnimationCues(anim));
    }
    sync(message);
    showEventMessages();
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
   * Known simplification: there's no incremental `sync()` between events,
   * so a unit that died mid-turn keeps its sprite on screen (other
   * animations still play correctly around it, cue positions are always
   * explicit) until the single `sync()` at the end reconciles everything
   * -- an acceptable rough edge for a first cut given real per-action
   * board reconciliation would need `GameSession` to expose intermediate
   * board snapshots, not just the final one.
   */
  async function playAiAnimations(events: readonly AiAnimationEvent[]): Promise<void> {
    if (!boardView) return;
    for (const event of events) {
      if (event.kind === 'attack') {
        await boardView.playAnimationSequence(buildBlowAnimationCues(event));
      } else if (event.kind === 'move') {
        await boardView.playAnimationSequence(buildMoveAnimationCues(event), 2);
      } else {
        await boardView.playAnimationSequence(buildRecruitAnimationCues(event));
      }
    }
  }

  async function handleEndTurn(): Promise<void> {
    if (phase !== 'playing') return;
    const message = session.endTurn();
    const aiAnimations = session.lastAiAnimations;
    session.lastAiAnimations = null;
    if (aiAnimations) await playAiAnimations(aiAnimations);
    sync(message);
    showEventMessages();
  }

  async function handleSave(): Promise<void> {
    if (phase !== 'playing') return;
    try {
      await saveGame(saveSlot, activeSnapshot.scenario.id, session.toSaveData());
      sync(`Saved (turn ${session.turnNumber}).`);
    } catch (err) {
      sync(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleLoad(): Promise<void> {
    if (phase !== 'playing') return;
    try {
      const found = await loadGame<import('./gameSession.js').SaveGameData>(saveSlot);
      if (!found || found.scenarioId !== activeSnapshot.scenario.id) {
        sync('No save found.');
        return;
      }
      session.loadSaveData(found.data);
      if (session.scenarioResult) phase = 'ended';
      sync(`Loaded save from turn ${found.data.turnNumber}.`);
    } catch (err) {
      sync(`Load failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function advanceStory(): void {
    storyIndex += 1;
    if (storyIndex >= storyParts.length) {
      startupMessages = session.runStartupEvents();
      messageIndex = 0;
      sync();
      phase = decidePostEventsPhase();
      applyMessagePhaseUnits();
    }
  }

  function advanceMessage(): void {
    messageIndex += 1;
    if (messageIndex >= startupMessages.length) {
      phase = session.scenarioResult ? 'ended' : 'playing';
      units = session.renderUnits;
    } else {
      units = session.messageUnitSnapshot(startupMessages[messageIndex]!);
    }
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
      const res = await fetch(`/scenarios/${nextId}.json`);
      if (!res.ok) throw new Error(`fetch scenarios/${nextId}.json: ${res.status}`);
      const nextSnapshot: GameBoardSnapshot = await res.json();
      const nextSession = GameSession.startNextScenario(session, nextSnapshot);

      activeSnapshot = nextSnapshot;
      session = nextSession;

      const nextStoryParts = nextSnapshot.story ?? [];
      storyIndex = 0;
      messageIndex = 0;
      startupMessages = [];
      if (nextStoryParts.length === 0) {
        startupMessages = session.runStartupEvents();
        phase = decidePostEventsPhase();
      } else {
        phase = 'story';
      }
      sync();
      applyMessagePhaseUnits();
    } catch (err) {
      continueError = err instanceof Error ? err.message : String(err);
    } finally {
      continuing = false;
    }
  }
</script>

<div class="game-shell">
  <TurnBanner scenarioName={activeSnapshot.scenario.name} {turnNumber} {activeSide} {scenarioTurnsLimit} {timeOfDay} />
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
        {units}
        {selectedHex}
        {reachable}
        {attackTargets}
        {recruitTiles}
        {villageOwners}
        onHexClick={handleHexClick}
        hoverDefensePercent={(x, y) => session.defensePercentAt(x, y)}
      />
    {/key}
    <SidePanel
      {selected}
      {inspected}
      {pendingPreview}
      {attackerWeaponOptions}
      {statusMessage}
      {log}
      {recruitOptions}
      {pendingRecruitTypeId}
      {recallOptions}
      {pendingRecallIndex}
      {turnNumber}
      {scenarioTurnsLimit}
      {activeSide}
      {gold}
      {economyInfo}
      onConfirmAttack={handleConfirmAttack}
      onCancelAttack={handleCancelAttack}
      onSelectAttackerWeapon={handleSelectAttackerWeapon}
      onSelectRecruitType={handleSelectRecruitType}
      onSelectRecallUnit={handleSelectRecallUnit}
      onEndTurn={handleEndTurn}
      onSave={handleSave}
      onLoad={handleLoad}
    />
  </div>

  {#if phase === 'story'}
    <StoryViewer parts={storyParts} index={storyIndex} onNext={advanceStory} />
  {:else if phase === 'objectives' && session.scenarioObjectives}
    <ObjectivesDialog
      scenarioName={activeSnapshot.scenario.name}
      objectives={session.scenarioObjectives}
      currentTurn={turnNumber}
      turnsLimit={scenarioTurnsLimit}
      onClose={advanceObjectives}
    />
  {:else if phase === 'messages'}
    <MessageViewer messages={startupMessages} index={messageIndex} onNext={advanceMessage} />
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
    <ScenarioEndOverlay
      result={session.scenarioResult}
      {turnNumber}
      {gold}
      nextScenarioAvailable={session.scenarioResult === 'victory' && session.nextScenarioId !== null}
      {continuing}
      {continueError}
      onContinue={continueToNextScenario}
    />
  {/if}

  <AdvancementDialog pending={pendingAdvancement} onChoose={handleChooseAdvancement} />
</div>

<style>
  .game-shell {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .main {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }
</style>
