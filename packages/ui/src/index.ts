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
  SaveGameData,
} from './gameSession.js';

export { saveGame, loadGame, listSaves, deleteSave, type SaveMeta } from './persistence.js';

export { default as GameShell } from './GameShell.svelte';
