<script lang="ts">
  /**
   * Top-level Phase 5 game shell: owns one `GameSession` (see gameSession.ts)
   * and bridges it into Svelte's reactivity for TurnBanner/GameBoardView/
   * SidePanel. `GameSession` is a plain, rune-free class (see its own doc
   * comment for why); this component is the one place that mutates it and
   * mirrors the bits each child needs into `$state` variables afterward
   * (`sync()`) -- a deliberate, explicit "reactivity bridge" rather than
   * relying on Svelte's `$state(...)` deep-proxying a custom class instance
   * (which only reliably works for plain objects/arrays and classes whose
   * own fields are declared with `$state()`, neither of which apply to a
   * plain-TS domain class written for `tsc`-only environments).
   */
  import type { GameBoardSnapshot, SnapshotUnit } from '@wesnothweb2/engine';
  import type { HexPoint } from '@wesnothweb2/renderer';
  import { GameSession, type CombatPreview, type SelectedUnitInfo } from './gameSession.js';
  import TurnBanner from './TurnBanner.svelte';
  import GameBoardView from './GameBoardView.svelte';
  import SidePanel from './SidePanel.svelte';

  let { snapshot }: { snapshot: GameBoardSnapshot } = $props();

  const session = new GameSession(snapshot);

  let units = $state<SnapshotUnit[]>(session.renderUnits);
  let selected = $state<SelectedUnitInfo | null>(null);
  let selectedHex = $state<HexPoint | null>(null);
  let reachable = $state<HexPoint[]>([]);
  let attackTargets = $state<HexPoint[]>([]);
  let pendingPreview = $state<CombatPreview | null>(null);
  let log = $state<string[]>([]);
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
    pendingPreview = session.pendingAttack?.preview ?? null;
    log = session.log;

    if (message) {
      statusMessage = message;
    } else if (pendingPreview) {
      statusMessage = 'Review the attack prediction, then confirm or cancel.';
    } else if (selected) {
      statusMessage = `${selected.name} selected.`;
    } else {
      statusMessage = 'Click one of your units to select it.';
    }
  }

  function handleHexClick(x: number, y: number): void {
    const message = session.handleHexClick(x, y);
    sync(message);
  }

  function handleConfirmAttack(): void {
    const message = session.confirmAttack();
    sync(message);
  }

  function handleCancelAttack(): void {
    session.cancelAttack();
    sync();
  }
</script>

<div class="game-shell">
  <TurnBanner scenarioName={snapshot.scenario.name} />
  <div class="main">
    <GameBoardView {snapshot} {units} {selectedHex} {reachable} {attackTargets} onHexClick={handleHexClick} />
    <SidePanel {selected} {pendingPreview} {statusMessage} {log} onConfirmAttack={handleConfirmAttack} onCancelAttack={handleCancelAttack} />
  </div>
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
