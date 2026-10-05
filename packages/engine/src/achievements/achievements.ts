/**
 * Phase 25: achievements, a port of `achievements.cpp` (the `[achievement_group]` data), the achievement
 * half of `preferences.cpp` (what the player has earned) and `game_lua_kernel`'s `wesnoth.achievements`
 * functions, which `[set_achievement]`, `[set_sub_achievement]`, `[progress_achievement]` and the
 * `[has_achievement]`/`[has_sub_achievement]` conditions go through.
 *
 * The definitions come from `data/achievements.cfg` (built into JSON at build time); what was earned comes
 * from an `AchievementStore` the host provides (the browser's storage). A newly completed achievement
 * returns its `AchievementUnlock` -- what upstream's `gui.show_popup` and sound show -- for the caller to
 * present. While a replay is shown nothing is saved, as upstream's `is_replay()` checks.
 */
import { TString, type TStringJson } from '../i18n/tstring.js';
import { WmlConfig } from '../wml/config.js';

type Text = TStringJson | string;

/** One `[sub_achievement]`. */
export interface SubAchievementDef {
  readonly id: string;
  readonly description: Text;
  readonly icon: string;
}

/** One `[achievement]`. */
export interface AchievementDef {
  readonly id: string;
  readonly name: Text;
  readonly nameCompleted?: Text;
  readonly description: Text;
  readonly descriptionCompleted?: Text;
  readonly icon: string;
  readonly iconCompleted?: string;
  readonly hidden?: boolean;
  readonly maxProgress?: number;
  readonly sound?: string;
  readonly subAchievements?: readonly SubAchievementDef[];
}

/** One `[achievement_group]`. */
export interface AchievementGroupDef {
  readonly contentFor: string;
  readonly displayName: Text;
  readonly achievements: readonly AchievementDef[];
}

/** What the player has of one achievement (`[achievements]` in upstream's preferences). */
export interface AchievementRecord {
  done?: boolean;
  subs?: string[];
  /** `[in_progress] progress_at=`. */
  progress?: number;
}

/** Earned achievements, by `content_for` then id. */
export type AchievementRecords = Record<string, Record<string, AchievementRecord>>;

/** Where earned achievements are kept between games. */
export interface AchievementStore {
  read(): AchievementRecords;
  write(records: AchievementRecords): void;
}

/** An in-memory store, for tests and when the browser keeps nothing. */
export function memoryAchievementStore(initial: AchievementRecords = {}): AchievementStore {
  let records: AchievementRecords = structuredClone(initial);
  return {
    read: () => structuredClone(records),
    write: (r) => (records = structuredClone(r)),
  };
}

/** A completed achievement as upstream announces it: `gui.show_popup(name_completed, description_completed, icon_completed)` and its sound. */
export interface AchievementUnlock {
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly sound: string;
}

const text = (t: Text | undefined): string => (t === undefined ? '' : typeof t === 'string' ? t : TString.fromJSON(t).str());

/** One achievement as the dialog shows it (`achievements_dialog::set_achievements_row`). */
export interface AchievementView {
  readonly id: string;
  readonly achieved: boolean;
  readonly hidden: boolean;
  /** `name_completed` once achieved, else `name` (the dialog adds `($count/$total)` while in progress). */
  readonly name: string;
  /** While in progress (`max_progress` set and not achieved): how far, out of how much. */
  readonly progress: { readonly current: number; readonly max: number } | null;
  readonly description: string;
  /** The completed icon once achieved, else the icon greyed (`~GS()`). */
  readonly icon: string;
  /** 0-100 while in progress, else null. */
  readonly progressPercent: number | null;
  readonly subAchievements: readonly { id: string; description: string; icon: string; achieved: boolean }[];
}

export interface AchievementGroupView {
  readonly contentFor: string;
  readonly displayName: string;
  readonly achievements: readonly AchievementView[];
  readonly completed: number;
  readonly total: number;
}

export interface AchievementsOptions {
  /** `play_controller::is_replay`: nothing is saved while true. */
  isReplay?: () => boolean;
  /** `ERR_LUA`/`ERR_CONFIG` messages. */
  log?: (message: string) => void;
}

/** `achievement::max_progress_`: `max_progress=`, plus one per sub-achievement. */
function maxProgressOf(def: AchievementDef): number {
  return (def.maxProgress ?? 0) + (def.subAchievements?.length ?? 0);
}

export class Achievements {
  private records: AchievementRecords;

  constructor(
    readonly groups: readonly AchievementGroupDef[],
    private readonly store: AchievementStore,
    private readonly options: AchievementsOptions = {},
  ) {
    this.records = store.read();
  }

  private find(contentFor: string, id: string): { group?: AchievementGroupDef; def?: AchievementDef } {
    const group = this.groups.find((g) => g.contentFor === contentFor);
    return { group, def: group?.achievements.find((a) => a.id === id) };
  }

  private record(contentFor: string, id: string): AchievementRecord {
    return this.records[contentFor]?.[id] ?? {};
  }

  private update(contentFor: string, id: string, change: (r: AchievementRecord) => void): void {
    const group = (this.records[contentFor] ??= {});
    change((group[id] ??= {}));
    if (!this.options.isReplay?.()) {
      try {
        this.store.write(this.records);
      } catch {
        /* the browser keeps nothing: this page remembers */
      }
    }
  }

  /** `prefs::achievement`. */
  has(contentFor: string, id: string): boolean {
    return this.record(contentFor, id).done === true;
  }

  /** `prefs::sub_achievement`: true for every sub-achievement of a completed achievement. */
  hasSub(contentFor: string, id: string, subId: string): boolean {
    const r = this.record(contentFor, id);
    return r.done === true || (r.subs ?? []).includes(subId);
  }

  /** Current progress as `achievement::current_progress_` holds it: -1 once achieved. */
  private currentProgress(contentFor: string, id: string, def: AchievementDef): number {
    const r = this.record(contentFor, id);
    if (r.done) return -1;
    if (def.subAchievements && def.subAchievements.length > 0) return (r.subs ?? []).filter((s) => def.subAchievements!.some((d) => d.id === s)).length;
    return r.progress ?? 0;
  }

  /** `intf_get_achievement`: the achievement as WML, or an empty config when there is none. */
  get(contentFor: string, id: string): WmlConfig {
    const cfg = new WmlConfig();
    const { group, def } = this.find(contentFor, id);
    if (!group) {
      this.options.log?.(`Achievement group ${contentFor} not found`);
      return cfg;
    }
    if (!def) {
      this.options.log?.(`Achievement ${id} not found for achievement group ${contentFor}`);
      return cfg;
    }
    const achieved = this.has(contentFor, id);
    const set = (key: string, value: Text | undefined, fallback: Text): void => {
      const v = value ?? fallback;
      cfg.setAttribute(key, typeof v === 'string' ? v : TString.fromJSON(v));
    };
    cfg.setAttribute('id', def.id);
    set('name', def.name, '');
    set('name_completed', def.nameCompleted, def.name);
    set('description', def.description, '');
    set('description_completed', def.descriptionCompleted, def.description);
    cfg.setAttribute('icon', `${def.icon}~GS()`);
    cfg.setAttribute('icon_completed', def.iconCompleted || def.icon);
    cfg.setAttribute('hidden', def.hidden === true);
    cfg.setAttribute('achieved', achieved);
    cfg.setAttribute('max_progress', maxProgressOf(def));
    cfg.setAttribute('current_progress', this.currentProgress(contentFor, id, def));
    for (const sub of def.subAchievements ?? []) {
      const s = cfg.addChild('sub_achievement');
      s.setAttribute('id', sub.id);
      s.setAttribute('description', typeof sub.description === 'string' ? sub.description : TString.fromJSON(sub.description));
      s.setAttribute('icon', `${sub.icon}~GS()`);
      s.setAttribute('achieved', achieved || this.hasSub(contentFor, id, sub.id));
    }
    return cfg;
  }

  /** `intf_set_achievement`: completes it; returns the popup to show, or null if nothing changed. */
  set(contentFor: string, id: string): AchievementUnlock | null {
    const { group, def } = this.find(contentFor, id);
    if (!group) {
      this.options.log?.(`Achievement group ${contentFor} not found`);
      return null;
    }
    if (!def) {
      this.options.log?.(`Achievement ${id} not found for achievement group ${contentFor}`);
      return null;
    }
    if (this.has(contentFor, id)) return null;
    this.update(contentFor, id, (r) => (r.done = true));
    return {
      name: text(def.nameCompleted ?? def.name),
      description: text(def.descriptionCompleted ?? def.description),
      icon: def.iconCompleted || def.icon,
      sound: def.sound ?? '',
    };
  }

  /** `intf_set_sub_achievement`: completing the last one completes the achievement. Throws as Lua's `lua_error`. */
  setSub(contentFor: string, id: string, subId: string): AchievementUnlock | null {
    const { group, def } = this.find(contentFor, id);
    if (!group) throw new Error(`Achievement group ${contentFor} not found`);
    if (!def) throw new Error(`Achievement ${id} not found for achievement group ${contentFor}`);
    if (this.has(contentFor, id)) return null;
    if (!(def.subAchievements ?? []).some((s) => s.id === subId)) throw new Error(`Sub-achievement ${id} not found for achievement${id} in achievement group ${contentFor}`);
    if (this.hasSub(contentFor, id, subId)) return null;
    this.update(contentFor, id, (r) => (r.subs = [...(r.subs ?? []), subId]));
    return this.currentProgress(contentFor, id, def) === maxProgressOf(def) ? this.set(contentFor, id) : null;
  }

  /**
   * `intf_progress_achievement`: adds `amount` (clamped to `limit` and the maximum, never lowering what a
   * `limit` already passed); reaching the maximum completes it. Returns the progress (-1 once achieved or
   * for an achievement that cannot progress), the maximum (-1 for one that cannot), and the popup if any.
   */
  progress(contentFor: string, id: string, amount: number, limit = 999999999): { progress: number; max: number; unlock: AchievementUnlock | null } {
    const { group, def } = this.find(contentFor, id);
    if (!group) throw new Error(`Achievement group ${contentFor} not found`);
    if (!def) throw new Error(`Achievement ${id} not found for achievement group ${contentFor}`);
    const max = maxProgressOf(def);
    if (max === 0 || (def.subAchievements?.length ?? 0) > 0) {
      this.options.log?.(`Attempted to progress achievement ${id} for achievement group ${contentFor}, is not a progressible achievement.`);
      return { progress: -1, max: -1, unlock: null };
    }
    if (this.has(contentFor, id)) return { progress: -1, max, unlock: null };
    // `prefs::progress_achievement`; in a replay nothing is recorded and the progress reads 0.
    let progress = 0;
    if (!this.options.isReplay?.()) {
      const before = this.record(contentFor, id).progress;
      if (before !== undefined && before >= limit) progress = before;
      else if (before === undefined && amount === 0) progress = 0;
      else {
        progress = Math.min(Math.max((before ?? 0) + amount, 0), Math.min(limit, max));
        this.update(contentFor, id, (r) => (r.progress = progress));
      }
    }
    const unlock = progress >= max ? this.set(contentFor, id) : null;
    return { progress, max, unlock };
  }

  /** `achievements_dialog`: every group, with what the player has. */
  view(): AchievementGroupView[] {
    return this.groups.map((group) => {
      let completed = 0;
      const achievements: AchievementView[] = [];
      for (const def of group.achievements) {
        const achieved = this.has(group.contentFor, def.id);
        if (achieved) completed++;
        else if (def.hidden) continue;
        const max = maxProgressOf(def);
        const current = this.currentProgress(group.contentFor, def.id, def);
        const inProgress = max !== 0 && current !== -1;
        achievements.push({
          id: def.id,
          achieved,
          hidden: def.hidden === true,
          name: achieved ? text(def.nameCompleted ?? def.name) : text(def.name),
          progress: inProgress ? { current, max } : null,
          description: achieved ? text(def.descriptionCompleted ?? def.description) : text(def.description),
          icon: achieved ? def.iconCompleted || def.icon : `${def.icon}~GS()`,
          progressPercent: inProgress ? (current / max) * 100 : null,
          subAchievements: (def.subAchievements ?? []).map((s) => {
            const has = achieved || this.hasSub(group.contentFor, def.id, s.id);
            return { id: s.id, description: text(s.description), icon: has ? s.icon : `${s.icon}~GS()`, achieved: has };
          }),
        });
      }
      return { contentFor: group.contentFor, displayName: text(group.displayName), achievements, completed, total: group.achievements.length };
    });
  }
}
