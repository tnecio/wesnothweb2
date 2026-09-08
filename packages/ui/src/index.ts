// Public API barrel for @wesnothweb2/ui, consumed by apps/web.
export { GameSession } from './gameSession.js';
export type {
  HexPoint,
  CombatantPreview,
  CombatPreview,
  SelectedUnitInfo,
  PendingAttack,
  RecruitOption,
  GameSessionOptions,
} from './gameSession.js';

export { default as GameShell } from './GameShell.svelte';
