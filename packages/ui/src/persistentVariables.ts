/**
 * Phase 28c: where `[set_global_variable]` values and achievements live between games. Upstream writes
 * a file per namespace in the player's data directory (`persist_manager`) and saves achievements with
 * the preferences (`game_config_manager` / `achievements.cpp`); a browser has `localStorage`, per
 * browser like our other preferences. Every access is guarded: storage can be unavailable (a private
 * window, blocked site data), and then values last only as long as the page, as in memory.
 */
import { WmlConfig, memoryPersistentVariables, type AchievementSink, type PersistentVariables } from '@wesnothweb2/engine';

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

/** Achievements earned, by `content_for` then id: `true`, sub-achievement ids, or progress. */
type AchievementRecord = Record<string, Record<string, { done?: boolean; subs?: string[]; progress?: number }>>;

/** Records achievements in `localStorage`. There is no achievements screen yet (Phase 25). */
export function browserAchievements(onEarned?: (contentFor: string, id: string) => void): AchievementSink {
  const store = storage();
  const read = (): AchievementRecord => {
    try {
      return JSON.parse(store?.getItem(ACHIEVEMENTS_KEY) ?? '{}') as AchievementRecord;
    } catch {
      return {};
    }
  };
  const update = (contentFor: string, id: string, change: (entry: { done?: boolean; subs?: string[]; progress?: number }) => void): void => {
    const all = read();
    const entry = ((all[contentFor] ??= {})[id] ??= {});
    change(entry);
    try {
      store?.setItem(ACHIEVEMENTS_KEY, JSON.stringify(all));
    } catch {
      /* not kept */
    }
  };
  return {
    set(contentFor, id) {
      update(contentFor, id, (e) => (e.done = true));
      onEarned?.(contentFor, id);
    },
    setSub(contentFor, id, subId) {
      update(contentFor, id, (e) => (e.subs = [...new Set([...(e.subs ?? []), subId])]));
    },
    progress(contentFor, id, amount, limit) {
      update(contentFor, id, (e) => (e.progress = Math.min(limit, (e.progress ?? 0) + amount)));
    },
  };
}
