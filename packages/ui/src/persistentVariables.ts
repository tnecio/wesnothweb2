/**
 * Phase 28c: where `[set_global_variable]` values and achievements live between games. Upstream writes
 * a file per namespace in the player's data directory (`persist_manager`) and saves achievements with
 * the preferences (`game_config_manager` / `achievements.cpp`); a browser has `localStorage`, per
 * browser like our other preferences. Every access is guarded: storage can be unavailable (a private
 * window, blocked site data), and then values last only as long as the page, as in memory.
 */
import {
  Achievements,
  WmlConfig,
  memoryPersistentVariables,
  type AchievementGroupDef,
  type AchievementRecords,
  type AchievementStore,
  type AchievementsOptions,
  type PersistentVariables,
} from '@wesnothweb2/engine';
import achievementsJson from './achievements.json';

const VARIABLES_KEY = 'wesnothweb2.persist.';
const ACHIEVEMENTS_KEY = 'wesnothweb2.achievements';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** `[set_global_variable]` storage in `localStorage` (one entry per namespace), or in memory without it. */
export function browserPersistentVariables(): PersistentVariables {
  const store = storage();
  if (!store) return memoryPersistentVariables();
  const read = (ns: string): Record<string, unknown> => {
    try {
      return JSON.parse(store.getItem(VARIABLES_KEY + ns) ?? '{}') as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const write = (ns: string, values: Record<string, unknown>): void => {
    try {
      store.setItem(VARIABLES_KEY + ns, JSON.stringify(values));
    } catch {
      /* storage full or blocked: the value lasts this page only */
    }
  };
  return {
    get(ns, name) {
      const json = read(ns)[name];
      return json ? WmlConfig.fromJSON(json as ReturnType<WmlConfig['toJSON']>) : undefined;
    },
    set(ns, name, value) {
      write(ns, { ...read(ns), [name]: value.toJSON() });
    },
    clear(ns, name) {
      const values = read(ns);
      delete values[name];
      write(ns, values);
    },
  };
}

/**
 * Phase 25: where earned achievements are kept (upstream: the `[achievements]` of the player's preferences),
 * in `localStorage`. Nothing is kept when storage is unavailable; the game still remembers this page's.
 */
export function browserAchievementStore(): AchievementStore {
  const store = storage();
  return {
    read() {
      try {
        const parsed: unknown = JSON.parse(store?.getItem(ACHIEVEMENTS_KEY) ?? '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as AchievementRecords) : {};
      } catch {
        return {};
      }
    },
    write(records) {
      try {
        store?.setItem(ACHIEVEMENTS_KEY, JSON.stringify(records));
      } catch {
        /* not kept */
      }
    },
  };
}

/** The shipped achievement groups (`data/achievements.cfg`, built into `achievements.json`). */
export const ACHIEVEMENT_GROUPS = (achievementsJson as unknown as { groups: AchievementGroupDef[] }).groups;

/** The player's achievements, as the game and the achievements dialog read and record them. */
export function browserAchievements(options: AchievementsOptions = {}): Achievements {
  return new Achievements(ACHIEVEMENT_GROUPS, browserAchievementStore(), options);
}
