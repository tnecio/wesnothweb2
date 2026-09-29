/**
 * Shared unit/terrain databases for scenario snapshots (Phase 28, `docs/ASSETS.md` §4.1).
 *
 * A built snapshot carries every unit type, movement type, terrain type, weapon special and ability a
 * scenario could need -- ~3 MB of the ~3.5 MB file, and byte-identical from one scenario to the next. So the
 * build splits those tables out:
 *
 * - `scenarios/_core.json`: every entry that is identical in all real campaigns' scenarios (core units);
 * - `scenarios/<campaignDir>/_campaign.json`: every other entry identical across that campaign's scenarios
 *   (its own units, and any core type it redefines);
 * - the scenario file keeps only what differs between scenarios of one campaign, plus `databases`: the
 *   files above it needs, in merge order (later entries win).
 *
 * `assembleSnapshot` puts a scenario back together, so everything after loading sees the same complete
 * `GameBoardSnapshot` as before. Difficulty overlays apply to the assembled snapshot.
 */
import type { GameBoardSnapshot } from './gameBoardSnapshot.js';

/** Keyed tables whose entries move to a shared database. */
export const DATABASE_TABLES = ['unitTypes', 'unitTypeConfigs', 'movementTypeConfigs', 'weaponSpecialConfigs', 'abilityConfigs'] as const;
type DatabaseTable = (typeof DATABASE_TABLES)[number];

/** Keys moved whole (not entry by entry) when every scenario has the same value. */
export const DATABASE_WHOLE_KEYS = ['terrainTypeConfigs', 'luaSources'] as const;
type DatabaseWholeKey = (typeof DATABASE_WHOLE_KEYS)[number];

/** One shared database file: some entries of the tables, and possibly whole keys. */
export type SnapshotDatabase = Partial<Pick<GameBoardSnapshot, DatabaseTable | DatabaseWholeKey>>;

/** File name of the core database, relative to `scenarios/`. */
export const CORE_DATABASE_FILE = '_core.json';

/** File name of a campaign's database, relative to `scenarios/`. */
export function campaignDatabaseFile(campaignDir: string): string {
  return `${campaignDir}/_campaign.json`;
}

/** Whether a file under `scenarios/` is a shared database rather than a scenario or an overlay. */
export function isDatabaseFile(name: string): boolean {
  return (name.split('/').pop() ?? name).startsWith('_');
}

/** A scenario file as stored: a snapshot missing its shared entries, naming the databases that hold them. */
export type StoredSnapshot = GameBoardSnapshot & { databases?: string[] };

/** `file` with its `databases` merged back in (in order; the file's own entries win). Arguments are not modified. */
export function assembleSnapshot(file: StoredSnapshot, databases: readonly SnapshotDatabase[]): GameBoardSnapshot {
  const { databases: _names, ...rest } = file;
  const out = rest as unknown as Record<string, unknown>;
  for (const key of DATABASE_TABLES) {
    const parts = [...databases.map((db) => db[key]), file[key]].filter((t): t is NonNullable<typeof t> => !!t);
    if (parts.length > 0) out[key] = Object.assign({}, ...parts);
  }
  for (const key of DATABASE_WHOLE_KEYS) {
    if (file[key] !== undefined) continue;
    const from = [...databases].reverse().find((db) => db[key] !== undefined);
    if (from) out[key] = from[key];
  }
  return out as unknown as GameBoardSnapshot;
}

export interface SplitInput {
  /** The campaign directory the scenario is filed under (`CampaignInfo.assetDir`). */
  campaignDir: string;
  /** Real campaigns decide what is core; debug (synthetic) campaigns only use it. */
  real: boolean;
  snapshot: GameBoardSnapshot;
}

export interface SplitOutput {
  core: SnapshotDatabase;
  /** Per campaign directory; only campaigns with entries of their own. */
  campaigns: Map<string, SnapshotDatabase>;
  /** The scenario files, in input order, without the entries the databases hold. */
  files: StoredSnapshot[];
}

type Json = Record<string, unknown>;
const table = (s: GameBoardSnapshot, key: DatabaseTable): Json | undefined => s[key] as Json | undefined;

/**
 * Entries whose serialized value is the same in every one of `snapshots` that has the key, and present in
 * all of them. (An id missing from one snapshot stays out, so a database never adds an id a scenario lacked.)
 */
function commonEntries(snapshots: readonly GameBoardSnapshot[], key: DatabaseTable): Json {
  const first = snapshots[0] && table(snapshots[0], key);
  if (!first) return {};
  const common: Json = {};
  for (const [id, value] of Object.entries(first)) {
    const text = JSON.stringify(value);
    if (snapshots.every((s) => { const t = table(s, key); return !!t && Object.prototype.hasOwnProperty.call(t, id) && JSON.stringify(t[id]) === text; })) {
      common[id] = value;
    }
  }
  return common;
}

function commonWhole(snapshots: readonly GameBoardSnapshot[], key: DatabaseWholeKey): unknown {
  if (snapshots.length === 0 || snapshots[0]![key] === undefined) return undefined;
  const text = JSON.stringify(snapshots[0]![key]);
  return snapshots.every((s) => JSON.stringify(s[key]) === text) ? snapshots[0]![key] : undefined;
}

function isEmpty(db: SnapshotDatabase): boolean {
  return Object.values(db).every((v) => v === undefined || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0));
}

/**
 * Splits built snapshots into the core database, per-campaign databases and slimmed scenario files, such that
 * `assembleSnapshot(files[i], <its databases>)` equals `inputs[i].snapshot` exactly.
 */
export function splitSnapshotDatabases(inputs: readonly SplitInput[]): SplitOutput {
  const real = inputs.filter((i) => i.real).map((i) => i.snapshot);
  const core: SnapshotDatabase = {};
  for (const key of DATABASE_TABLES) {
    const entries = commonEntries(real, key);
    if (Object.keys(entries).length > 0) (core as Json)[key] = entries;
  }
  for (const key of DATABASE_WHOLE_KEYS) {
    const value = commonWhole(real, key);
    if (value !== undefined) (core as Json)[key] = value;
  }

  const byCampaign = new Map<string, GameBoardSnapshot[]>();
  for (const i of inputs) byCampaign.set(i.campaignDir, [...(byCampaign.get(i.campaignDir) ?? []), i.snapshot]);
  const campaigns = new Map<string, SnapshotDatabase>();
  for (const [dir, snapshots] of byCampaign) {
    const db: SnapshotDatabase = {};
    for (const key of DATABASE_TABLES) {
      const coreTable = (core[key] ?? {}) as Json;
      const own: Json = {};
      for (const [id, value] of Object.entries(commonEntries(snapshots, key))) {
        if (JSON.stringify(coreTable[id]) !== JSON.stringify(value)) own[id] = value;
      }
      if (Object.keys(own).length > 0) (db as Json)[key] = own;
    }
    for (const key of DATABASE_WHOLE_KEYS) {
      const value = commonWhole(snapshots, key);
      if (value !== undefined && JSON.stringify(value) !== JSON.stringify(core[key])) (db as Json)[key] = value;
    }
    if (!isEmpty(db)) campaigns.set(dir, db);
  }

  const files = inputs.map(({ campaignDir, snapshot }) => {
    const dbs: [string, SnapshotDatabase][] = [[CORE_DATABASE_FILE, core]];
    const own = campaigns.get(campaignDir);
    if (own) dbs.push([campaignDatabaseFile(campaignDir), own]);
    const merged = assembleSnapshot({} as StoredSnapshot, dbs.map(([, db]) => db));
    const file = { ...snapshot } as unknown as Json;
    for (const key of DATABASE_TABLES) {
      const t = table(snapshot, key);
      if (!t) continue;
      const shared = (merged[key] ?? {}) as Json;
      const rest: Json = {};
      for (const [id, value] of Object.entries(t)) {
        if (!Object.prototype.hasOwnProperty.call(shared, id) || JSON.stringify(shared[id]) !== JSON.stringify(value)) rest[id] = value;
      }
      // A database entry the scenario does not have would appear on assembly; that cannot happen, since
      // every shared entry is present in every scenario it is shared with.
      if (Object.keys(rest).length > 0) file[key] = rest;
      else delete file[key];
    }
    for (const key of DATABASE_WHOLE_KEYS) {
      if (snapshot[key] !== undefined && JSON.stringify(snapshot[key]) === JSON.stringify(merged[key])) delete file[key];
    }
    file['databases'] = dbs.map(([name]) => name);
    return file as unknown as StoredSnapshot;
  });

  return { core, campaigns, files };
}
