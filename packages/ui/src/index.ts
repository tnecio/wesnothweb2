// Public API barrel for @wesnothweb2/ui, consumed by apps/web.
export { GameSession, parseScenarioTurnsLimit } from './gameSession.js';
export type {
  HexPoint,
  CombatantPreview,
  CombatPreview,
  SelectedUnitInfo,
  PendingAttack,
  RecruitOption,
  RecallOption,
  AttackerWeaponOption,
  EconomyInfo,
  VillageOwnerInfo,
  GameSessionOptions,
  SaveGameData,
} from './gameSession.js';

export { saveGame, loadGame, listSaves, deleteSave, type SaveMeta } from './persistence.js';

export { default as GameShell } from './GameShell.svelte';

export { fetchStoryAssets, pickStoryImage, type StoryAssets, type StoryImageEntry } from './story/storyImages.js';
