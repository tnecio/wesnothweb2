/**
 * The help browser's data (Phase 24): what upstream's help reads from the game config, as built by
 * `apps/web/scripts/build-help.mjs` into `help/core.json`, and, in a game, the scenario snapshot's own
 * tables laid over it (they include the campaign's units and races, which upstream's help lists while the
 * campaign is loaded).
 */
import type { GameBoardSnapshot, TimeOfDayEntry, WmlConfigJson } from '@wesnothweb2/engine';
import { dataUrl } from '../dataUrls.js';

export interface RegistryEntryJson {
  tag: string;
  config: WmlConfigJson;
}

export interface HelpData {
  /** The `[help]` config: `[toplevel]`, `[section]`s and `[topic]`s. */
  help: WmlConfigJson;
  /** Flattened `[unit_type]` configs with their resolved trait pools, by id. */
  unitTypeConfigs: Record<string, WmlConfigJson>;
  movementTypeConfigs: Record<string, WmlConfigJson>;
  raceConfigs: Record<string, WmlConfigJson>;
  /** The global `[units][trait]`s. */
  traitConfigs: WmlConfigJson[];
  weaponSpecialConfigs: Record<string, RegistryEntryJson>;
  abilityConfigs: Record<string, RegistryEntryJson>;
  terrainTypeConfigs: WmlConfigJson[];
  eraConfigs: WmlConfigJson[];
  /** Upstream's `string_table` (`data/english.cfg`'s `[language]`): damage type and range names and the like. */
  stringTable: WmlConfigJson['attrs'];
  /** The images only the engine's own `images/` directory has, relative to it (see `helpImages.ts`). */
  engineImages: string[];
}

/** What the help knows about the game in progress, if any. */
export interface HelpGameContext {
  /** The current time-of-day schedule (`tod_manager::times()`), for the "Time of Day Schedule" pages. */
  times?: readonly TimeOfDayEntry[];
  maxLiminalBonus?: number;
  /** Every terrain code on the current map (`Gg^Fp`...): the mixed ones get their own (hidden) pages, as upstream. */
  mapTerrainCodes?: readonly string[];
}

let corePromise: Promise<HelpData> | null = null;

/** `help/core.json`, fetched once, on first use. */
export function fetchCoreHelpData(): Promise<HelpData> {
  corePromise ??= fetch(dataUrl('help/core.json')).then(async (res) => {
    if (!res.ok) throw new Error(`help/core.json: HTTP ${res.status}`);
    return (await res.json()) as HelpData;
  });
  corePromise.catch(() => {
    corePromise = null;
  });
  return corePromise;
}

/** The core data with a scenario snapshot's own unit types, races, movetypes and registries laid over it. */
export function withSnapshot(core: HelpData, snapshot: GameBoardSnapshot | null | undefined): HelpData {
  if (!snapshot) return core;
  return {
    ...core,
    unitTypeConfigs: { ...core.unitTypeConfigs, ...(snapshot.unitTypeConfigs ?? {}) },
    movementTypeConfigs: { ...core.movementTypeConfigs, ...(snapshot.movementTypeConfigs ?? {}) },
    raceConfigs: { ...core.raceConfigs, ...(snapshot.raceConfigs ?? {}) },
    weaponSpecialConfigs: { ...core.weaponSpecialConfigs, ...(snapshot.weaponSpecialConfigs ?? {}) },
    abilityConfigs: { ...core.abilityConfigs, ...(snapshot.abilityConfigs ?? {}) },
  };
}
