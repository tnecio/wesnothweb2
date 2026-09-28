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

export {
  saveGame,
  loadGame,
  listSaves,
  deleteSave,
  renameSave,
  readSetting,
  writeSetting,
  type SaveMeta,
  type SaveDetails,
  type SaveKind,
} from './persistence.js';

// Save-file conversion and naming (Phase 26). `wesnothSave` is the only
// module that knows the real save format; `campaign.ts` carries the
// upstream identity a file needs, from `campaigns.json`.
export { fromWesnothSave, toWesnothSave, type WesnothCampaignInfo, type ImportedWesnothSave } from './save/wesnothSave.js';
export { wesnothCampaignInfo, campaignAbbrev, defaultDifficulty, type CampaignInfo, type CampaignDifficulty } from './save/campaign.js';
export { fetchCampaigns, parseCampaigns, type Campaign } from './campaigns.js';
export { default as MainMenu } from './menu/MainMenu.svelte';
export { fetchScenarioSnapshot } from './scenarioFetch.js';
export {
  scenarioLabel,
  autosaveName,
  manualSaveName,
  scenarioStartSaveName,
  autosavesToDelete,
  downloadFileName,
  uniqueName,
  DEFAULT_AUTO_SAVE_MAX,
  INFINITE_AUTO_SAVES,
} from './save/naming.js';

export { default as GameShell } from './GameShell.svelte';

export { fetchStoryAssets, pickStoryImage, type StoryAssets, type StoryImageEntry } from './story/storyImages.js';

// Phase 20: accessibility preferences, language and translation lookup.
export { accessibility, AccessibilityManager, FONT_SCALE_MIN, FONT_SCALE_MAX, DEFAULT_ORB_COLORS } from './accessibility.js';
export { default as LanguageDialog } from './LanguageDialog.svelte';
export {
  locale,
  LocaleManager,
  detectLanguage,
  languageTag,
  t,
  tw,
  th,
  tx,
  tn,
  twn,
  td,
  ts,
  fmt,
  formatDateTime,
  CORE_DOMAINS,
  SOURCE_LANGUAGE,
  type LanguageInfo,
  type LocaleHost,
} from './i18n/locale.js';
export { dataUrl, loadDataManifest } from './dataUrls.js';
export { default as ErrorScreen } from './errors/ErrorScreen.svelte';
export { installErrorReporting, reportError, setGameContext, buildInfo } from './errors/errorReporting.svelte.js';
