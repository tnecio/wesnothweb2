/**
 * Fetching a scenario's snapshot for a campaign difficulty (Phase 21).
 *
 * The campaign's default difficulty ships whole as `/scenarios/<campaignDir>/<id>.json`; every other one
 * ships as a small overlay, `/scenarios/<campaignDir>/<id>@<DEFINE>.json` (see
 * `engine/snapshot/snapshotOverlay.ts`), applied to the base. Every place that opens a scenario goes
 * through here, so none can forget the difficulty -- or the campaign directory: a bare `[scenario] id=` is
 * only unique *within* its own campaign (Dead Water and Under the Burning Suns both ship a `13_Epilogue`),
 * so `campaignDir` (a `CampaignInfo.assetDir`) is required, not inferred from the id.
 */
import {
  applySnapshotOverlay,
  assembleSnapshot,
  scenarioFileName,
  type GameBoardSnapshot,
  type SnapshotDatabase,
  type SnapshotOverlay,
  type StoredSnapshot,
} from '@wesnothweb2/engine';

async function fetchJson<T>(name: string): Promise<T> {
  const res = await fetch(`/scenarios/${name}`);
  if (!res.ok) throw new Error(`fetch scenarios/${name}: ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Phase 28: the shared unit/terrain databases a scenario file names (`_core.json`, `<campaignDir>/_campaign.json`,
 * see `engine/snapshot/snapshotDatabase.ts`), fetched once per page and shared by every scenario that uses them.
 */
const databases = new Map<string, Promise<SnapshotDatabase>>();

function fetchDatabase(name: string): Promise<SnapshotDatabase> {
  let db = databases.get(name);
  if (!db) {
    db = fetchJson<SnapshotDatabase>(name);
    db.catch(() => databases.delete(name));
    databases.set(name, db);
  }
  return db;
}

/** A scenario file with its databases merged back in: the complete snapshot. */
async function fetchSnapshot(name: string): Promise<GameBoardSnapshot> {
  const stored = await fetchJson<StoredSnapshot>(name);
  if (!stored.databases) return stored;
  return assembleSnapshot(stored, await Promise.all(stored.databases.map(fetchDatabase)));
}

/**
 * `scenarioId`'s snapshot (`campaignDir`'s own, i.e. `CampaignInfo.assetDir`) at `difficulty`.
 * `defaultDifficulty` is the campaign's default, when known: with it the overlay is fetched alongside the
 * base; without it the base is read first to learn its own difficulty. Omitting `difficulty` gives the
 * base (the default difficulty; the only one a debug scenario has).
 */
export async function fetchScenarioSnapshot(scenarioId: string, campaignDir: string, difficulty?: string, defaultDifficulty?: string): Promise<GameBoardSnapshot> {
  const baseName = `${campaignDir}/${scenarioId}.json`;
  if (!difficulty) return fetchSnapshot(baseName);
  if (defaultDifficulty !== undefined) {
    const overlayName = scenarioFileName(campaignDir, scenarioId, difficulty, defaultDifficulty);
    if (overlayName === baseName) return fetchSnapshot(overlayName);
    const [base, overlay] = await Promise.all([fetchSnapshot(baseName), fetchJson<SnapshotOverlay>(overlayName)]);
    return applySnapshotOverlay(base, overlay);
  }
  const base = await fetchSnapshot(baseName);
  if (base.difficulty === difficulty) return base;
  return applySnapshotOverlay(base, await fetchJson<SnapshotOverlay>(scenarioFileName(campaignDir, scenarioId, difficulty, base.difficulty)));
}
