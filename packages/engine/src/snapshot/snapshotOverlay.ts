/**
 * Per-difficulty scenario snapshots (Phase 21).
 *
 * A campaign's difficulty is resolved by the WML preprocessor (`#ifdef EASY`), so each difficulty is its
 * own build of a scenario. But the builds barely differ: of a ~3.4 MB snapshot only `teams`, `units` and
 * `scenarioConfigJson` (~50 KB) change; the unit-type and terrain tables (most of the size) are identical.
 * So only the campaign's default difficulty ships whole (`scenarios/<campaignDir>/<id>.json`); every other
 * one ships as an *overlay* (`scenarios/<campaignDir>/<id>@<DEFINE>.json`): just the top-level keys that
 * differ, replaced wholesale when applied.
 *
 * Snapshots are nested under `<campaignDir>` (a campaign's own directory name, e.g. `Dead_Water`; see
 * `CampaignInfo.assetDir`) rather than sitting flat under `scenarios/`, because a bare `[scenario] id=` is
 * only unique *within* its own campaign (Dead Water and Under the Burning Suns both ship a `13_Epilogue`) --
 * a flat namespace let one campaign's build silently overwrite another's (found 2026-09-27, a real bug: one
 * campaign's `13_Epilogue` was simply missing, replaced by the other's at build time).
 *
 * A few campaigns (Under the Burning Suns) also change a handful of unit types per difficulty. Those tables
 * are large records keyed by id, so for them the overlay carries only the entries that differ
 * (`patches`; `null` marks an entry the difficulty removes) instead of the whole table.
 *
 * `diffSnapshots` refuses to build an overlay that changes a key outside these two lists, so the
 * assumption "difficulty only touches the scenario's own content" cannot silently go wrong: if a
 * difficulty ever changes the terrain tables, say, the build fails and the lists here are a decision
 * to revisit.
 */
import type { GameBoardSnapshot } from './gameBoardSnapshot.js';

/** The top-level snapshot keys a difficulty may change. */
export const OVERLAY_KEYS = ['difficulty', 'teams', 'units', 'scenarioConfigJson', 'map', 'terrain', 'story', 'textdomains'] as const;

/** The keyed tables a difficulty may change entry by entry. */
export const PATCH_KEYS = ['unitTypes', 'unitTypeConfigs', 'movementTypeConfigs', 'weaponSpecialConfigs', 'abilityConfigs', 'raceConfigs'] as const;
type PatchKey = (typeof PATCH_KEYS)[number];

export type SnapshotOverlay = Partial<Pick<GameBoardSnapshot, (typeof OVERLAY_KEYS)[number]>> & {
  /** Per table, the entries that differ; `null` removes an entry. */
  patches?: Partial<Record<PatchKey, Record<string, unknown>>>;
};

/** `base` with every key of `overlay` replaced and every patched table's entries updated. Neither argument is modified. */
export function applySnapshotOverlay(base: GameBoardSnapshot, overlay: SnapshotOverlay): GameBoardSnapshot {
  const { patches, ...whole } = overlay;
  const out = { ...base, ...whole } as unknown as Record<string, unknown>;
  for (const key of PATCH_KEYS) {
    const patch = patches?.[key];
    if (!patch) continue;
    const table = { ...((base as unknown as Record<string, Record<string, unknown>>)[key] ?? {}) };
    for (const [id, value] of Object.entries(patch)) {
      if (value === null) delete table[id];
      else table[id] = value;
    }
    out[key] = table;
  }
  return out as unknown as GameBoardSnapshot;
}

/**
 * The overlay that turns `base` into `full`. Throws if `full` differs from `base` in a key that overlays
 * do not carry (`generatedBy` is ignored: it is a comment, not content).
 */
export function diffSnapshots(base: GameBoardSnapshot, full: GameBoardSnapshot): SnapshotOverlay {
  const overlay: Record<string, unknown> = {};
  const patches: Record<string, Record<string, unknown>> = {};
  const forbidden: string[] = [];
  const keys = new Set([...Object.keys(base), ...Object.keys(full)]);
  for (const key of keys) {
    if (key === 'generatedBy') continue;
    const a = (base as unknown as Record<string, unknown>)[key];
    const b = (full as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if ((OVERLAY_KEYS as readonly string[]).includes(key)) overlay[key] = b;
    else if ((PATCH_KEYS as readonly string[]).includes(key)) patches[key] = diffTable(a as Record<string, unknown>, b as Record<string, unknown>);
    else forbidden.push(key);
  }
  if (forbidden.length > 0) {
    throw new Error(
      `a difficulty changes snapshot key(s) that overlays do not carry: ${forbidden.join(', ')}. ` +
        `Either they belong in OVERLAY_KEYS (snapshotOverlay.ts) or this campaign needs full per-difficulty snapshots.`,
    );
  }
  if (Object.keys(patches).length > 0) overlay.patches = patches;
  return overlay as SnapshotOverlay;
}

/** The entries of `b` that differ from `a`, with `null` for those `b` lacks. */
function diffTable(a: Record<string, unknown> = {}, b: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[id]) === JSON.stringify(b[id])) continue;
    out[id] = id in b ? b[id] : null;
  }
  return out;
}

/**
 * The URL of a scenario's snapshot for a difficulty, under its campaign's own directory (`campaignDir`,
 * e.g. `Dead_Water`; see `CampaignInfo.assetDir`): the whole file for the default difficulty, an overlay
 * file otherwise.
 */
export function scenarioFileName(campaignDir: string, scenarioId: string, difficulty: string | undefined, defaultDifficulty: string | undefined): string {
  const base = !difficulty || difficulty === defaultDifficulty ? `${scenarioId}.json` : `${scenarioId}@${difficulty}.json`;
  return `${campaignDir}/${base}`;
}
