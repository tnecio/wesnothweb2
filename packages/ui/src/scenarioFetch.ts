/**
 * Fetching a scenario's snapshot for a campaign difficulty (Phase 21).
 *
 * The campaign's default difficulty ships whole as `/scenarios/<id>.json`; every other one ships as a
 * small overlay, `/scenarios/<id>@<DEFINE>.json` (see `engine/snapshot/snapshotOverlay.ts`), applied to
 * the base. Every place that opens a scenario goes through here, so none can forget the difficulty.
 */
import { applySnapshotOverlay, scenarioFileName, type GameBoardSnapshot, type SnapshotOverlay } from '@wesnothweb2/engine';

async function fetchJson<T>(name: string): Promise<T> {
  const res = await fetch(`/scenarios/${name}`);
  if (!res.ok) throw new Error(`fetch scenarios/${name}: ${res.status}`);
  return (await res.json()) as T;
}

/**
 * `scenarioId`'s snapshot at `difficulty`. `defaultDifficulty` is the campaign's default, when known: with it
 * the overlay is fetched alongside the base; without it the base is read first to learn its own difficulty.
 * Omitting `difficulty` gives the base (the default difficulty; the only one a debug scenario has).
 */
export async function fetchScenarioSnapshot(scenarioId: string, difficulty?: string, defaultDifficulty?: string): Promise<GameBoardSnapshot> {
  if (!difficulty) return fetchJson<GameBoardSnapshot>(`${scenarioId}.json`);
  if (defaultDifficulty !== undefined) {
    const overlayName = scenarioFileName(scenarioId, difficulty, defaultDifficulty);
    if (overlayName === `${scenarioId}.json`) return fetchJson<GameBoardSnapshot>(overlayName);
    const [base, overlay] = await Promise.all([fetchJson<GameBoardSnapshot>(`${scenarioId}.json`), fetchJson<SnapshotOverlay>(overlayName)]);
    return applySnapshotOverlay(base, overlay);
  }
  const base = await fetchJson<GameBoardSnapshot>(`${scenarioId}.json`);
  if (base.difficulty === difficulty) return base;
  return applySnapshotOverlay(base, await fetchJson<SnapshotOverlay>(scenarioFileName(scenarioId, difficulty, base.difficulty)));
}
