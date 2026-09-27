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
import { applySnapshotOverlay, scenarioFileName, type GameBoardSnapshot, type SnapshotOverlay } from '@wesnothweb2/engine';

async function fetchJson<T>(name: string): Promise<T> {
  const res = await fetch(`/scenarios/${name}`);
  if (!res.ok) throw new Error(`fetch scenarios/${name}: ${res.status}`);
  return (await res.json()) as T;
}

/**
 * `scenarioId`'s snapshot (`campaignDir`'s own, i.e. `CampaignInfo.assetDir`) at `difficulty`.
 * `defaultDifficulty` is the campaign's default, when known: with it the overlay is fetched alongside the
 * base; without it the base is read first to learn its own difficulty. Omitting `difficulty` gives the
 * base (the default difficulty; the only one a debug scenario has).
 */
export async function fetchScenarioSnapshot(scenarioId: string, campaignDir: string, difficulty?: string, defaultDifficulty?: string): Promise<GameBoardSnapshot> {
  const baseName = `${campaignDir}/${scenarioId}.json`;
  if (!difficulty) return fetchJson<GameBoardSnapshot>(baseName);
  if (defaultDifficulty !== undefined) {
    const overlayName = scenarioFileName(campaignDir, scenarioId, difficulty, defaultDifficulty);
    if (overlayName === baseName) return fetchJson<GameBoardSnapshot>(overlayName);
    const [base, overlay] = await Promise.all([fetchJson<GameBoardSnapshot>(baseName), fetchJson<SnapshotOverlay>(overlayName)]);
    return applySnapshotOverlay(base, overlay);
  }
  const base = await fetchJson<GameBoardSnapshot>(baseName);
  if (base.difficulty === difficulty) return base;
  return applySnapshotOverlay(base, await fetchJson<SnapshotOverlay>(scenarioFileName(campaignDir, scenarioId, difficulty, base.difficulty)));
}
