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
  import type { GameBoardSnapshot, SnapshotUnit, RecordedMessage, WmlAttributeValue } from '@wesnothweb2/engine';
  import type { HexPoint } from '@wesnothweb2/renderer';
  import { GameSession, type CombatPreview, type SelectedUnitInfo, type RecruitOption, type SaveGameData } from './gameSession.js';
  import { saveGame, loadGame } from './persistence.js';
  import TurnBanner from './TurnBanner.svelte';
  import GameBoardView from './GameBoardView.svelte';
  import SidePanel from './SidePanel.svelte';
  import StoryViewer from './StoryViewer.svelte';
  import MessageViewer from './MessageViewer.svelte';
  import ScenarioEndOverlay from './ScenarioEndOverlay.svelte';

  let { snapshot }: { snapshot: GameBoardSnapshot } = $props();

  const session = new GameSession(snapshot);
  const storyParts = snapshot.story ?? [];
  /** Single fixed slot for MVP simplicity -- see persistence.ts's doc comment; keyed by scenario so a future multi-scenario build doesn't collide saves across scenarios. */
  const saveSlot = `quicksave:${snapshot.scenario.id}`;

  /** The scenario's real `turns=` attribute (from `scenarioConfigJson`), if it set one. `WmlConfig` stores WML attribute values as string|number|boolean depending on how the parser read them, so this normalizes either representation. */
  function parseTurnsLimit(raw: WmlAttributeValue | undefined): number | null {
    if (raw === undefined) return null;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const scenarioTurnsLimit = parseTurnsLimit(snapshot.scenarioConfigJson.attrs['turns']);

  let phase = $state<'story' | 'messages' | 'playing' | 'ended'>(storyParts.length > 0 ? 'story' : 'messages');
  let storyIndex = $state(0);
  let startupMessages = $state<RecordedMessage[]>([]);
  let messageIndex = $state(0);

  let units = $state<SnapshotUnit[]>(session.renderUnits);
  let selected = $state<SelectedUnitInfo | null>(null);
  let selectedHex = $state<HexPoint | null>(null);
  let reachable = $state<HexPoint[]>([]);
  let attackTargets = $state<HexPoint[]>([]);
  let recruitTiles = $state<HexPoint[]>([]);
  let recruitOptions = $state<RecruitOption[]>([]);
  let pendingRecruitTypeId = $state<string | null>(null);
  let pendingPreview = $state<CombatPreview | null>(null);
  let log = $state<string[]>([]);
  let turnNumber = $state(session.turnNumber);
  let activeSide = $state(session.activeSide);
  let gold = $state(session.board.getTeam(session.activeSide)?.gold ?? 0);
  let statusMessage = $state('Click one of your units to select it.');

  function selectedInfo(): SelectedUnitInfo | null {
    const u = session.selectedUnit;
    if (!u) return null;
    return {
      name: session.unitDisplayName(u),
      typeId: u.type.id,
      side: u.side,
      hp: u.hitpoints,
      maxHp: u.maxHitpoints,
      movesLeft: u.movesLeft,
      maxMoves: u.maxMoves,
      attacksLeft: u.attacksLeft,
    };
  }

  /** Re-derives every `$state` view from `session`'s current (just-mutated) state. Call after every session mutation. */
  function sync(message?: string | null): void {
    units = session.renderUnits;
    selected = selectedInfo();
    selectedHex = session.selectedUnit ? { x: session.selectedUnit.location.x, y: session.selectedUnit.location.y } : null;
    reachable = session.reachable;
    attackTargets = session.attackCandidates.map((u) => ({ x: u.location.x, y: u.location.y }));
    recruitTiles = session.recruitTiles;
    recruitOptions = session.recruitOptions;
    pendingRecruitTypeId = session.pendingRecruitTypeId;
    pendingPreview = session.pendingAttack?.preview ?? null;
    log = session.log;
    turnNumber = session.turnNumber;
    activeSide = session.activeSide;
    gold = session.board.getTeam(session.activeSide)?.gold ?? 0;

    if (session.scenarioResult) {
      statusMessage = session.scenarioResult === 'victory' ? 'Victory!' : 'Defeat.';
    } else if (message) {
      statusMessage = message;
    } else if (pendingPreview) {
      statusMessage = 'Review the attack prediction, then confirm or cancel.';
    } else if (pendingRecruitTypeId) {
      statusMessage = 'Click a green-highlighted castle tile to place your recruit.';
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

  // No story: run the startup events immediately so the board/side panel
  // reflect the real event-spawned units from the very first render, and
  // go straight to 'messages' (or 'playing' if the events recorded none).
  if (storyParts.length === 0) {
    startupMessages = session.runStartupEvents();
    if (startupMessages.length === 0) phase = 'playing';
    sync();
  }

  function handleHexClick(x: number, y: number): void {
    if (phase !== 'playing') return;
    const message = session.handleHexClick(x, y);
    sync(message);
  }

  // The `phase !== 'playing'` guards below are defensive: StoryViewer/
  // MessageViewer are full-screen `position:fixed` overlays that should
  // already block pointer events from reaching SidePanel's buttons while
  // shown, but that couldn't be visually confirmed in a real browser in
  // this environment (see top-level report) -- these guards make sure a
  // stray click/keyboard-focus during 'story'/'messages' can't end a turn
  // or place a recruit before the player has actually taken control.
  function handleConfirmAttack(): void {
    if (phase !== 'playing') return;
    const message = session.confirmAttack();
    sync(message);
  }

  function handleCancelAttack(): void {
    if (phase !== 'playing') return;
    session.cancelAttack();
    sync();
  }

  function handleSelectRecruitType(typeId: string): void {
    if (phase !== 'playing') return;
    session.selectRecruitType(typeId);
    sync();
  }

  function handleEndTurn(): void {
    if (phase !== 'playing') return;
    const message = session.endTurn();
    sync(message);
  }

  async function handleSave(): Promise<void> {
    if (phase !== 'playing') return;
    try {
      await saveGame(saveSlot, snapshot.scenario.id, session.toSaveData());
      sync(`Saved (turn ${session.turnNumber}).`);
    } catch (err) {
      sync(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleLoad(): Promise<void> {
    if (phase !== 'playing') return;
    try {
      const found = await loadGame<import('./gameSession.js').SaveGameData>(saveSlot);
      if (!found || found.scenarioId !== snapshot.scenario.id) {
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
      phase = startupMessages.length > 0 ? 'messages' : 'playing';
    }
  }

  function advanceMessage(): void {
    messageIndex += 1;
    if (messageIndex >= startupMessages.length) {
      phase = 'playing';
    }
  }
</script>

<div class="game-shell">
  <TurnBanner scenarioName={snapshot.scenario.name} {turnNumber} {activeSide} {scenarioTurnsLimit} />
  <div class="main">
    <GameBoardView {snapshot} {units} {selectedHex} {reachable} {attackTargets} {recruitTiles} onHexClick={handleHexClick} />
    <SidePanel
      {selected}
      {pendingPreview}
      {statusMessage}
      {log}
      {recruitOptions}
      {pendingRecruitTypeId}
      {turnNumber}
      {scenarioTurnsLimit}
      {activeSide}
      {gold}
      onConfirmAttack={handleConfirmAttack}
      onCancelAttack={handleCancelAttack}
      onSelectRecruitType={handleSelectRecruitType}
      onEndTurn={handleEndTurn}
      onSave={handleSave}
      onLoad={handleLoad}
    />
  </div>

  {#if phase === 'story'}
    <StoryViewer parts={storyParts} index={storyIndex} onNext={advanceStory} />
  {:else if phase === 'messages'}
    <MessageViewer messages={startupMessages} index={messageIndex} onNext={advanceMessage} />
  {:else if phase === 'ended' && session.scenarioResult}
    <ScenarioEndOverlay result={session.scenarioResult} {turnNumber} {gold} />
  {/if}
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
