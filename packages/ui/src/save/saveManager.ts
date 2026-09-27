/**
 * The file half of the save manager (Phase 26, shared with the title screen in Phase 21): export a stored
 * save as a real Wesnoth `.gz`, import a `.gz` (Wesnoth's or this port's own), and hand a blob to the
 * browser as a download. `GameShell` and the title screen's Load dialog both call these, so a save
 * behaves the same whichever screen it is opened from.
 */
import { parseConfig, writeWml, type GameBoardSnapshot } from '@wesnothweb2/engine';
import type { SaveGameData } from '../gameSession.js';
import { listSaves, loadGame, saveGame } from '../persistence.js';
import { fetchScenarioSnapshot } from '../scenarioFetch.js';
import { defaultDifficulty, wesnothCampaignInfo, type CampaignInfo } from './campaign.js';
import { downloadFileName, uniqueName } from './naming.js';
import { fromWesnothSave, toWesnothSave } from './wesnothSave.js';

/** Same native `CompressionStream` route `persistence.ts` uses -- no gzip library anywhere in this project. */
export async function gzipText(text: string): Promise<Blob> {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  void writer.write(new TextEncoder().encode(text)).then(() => writer.close());
  return await new Response(cs.readable).blob();
}

export async function gunzipToText(blob: Blob): Promise<string> {
  return await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // Must be in the document: a detached anchor's click is ignored by
  // some browsers (and by headless Chromium, which is how this is
  // verified). Revoking is deferred for the same reason -- revoking the
  // URL in the same tick can cancel the download that just started.
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 30_000);
}

/**
 * Downloads save `name` as a real Wesnoth `.gz` -- converted on the way out (`wesnothSave.ts`), so what lands
 * in the downloads folder is a file the actual game can open, not this port's JSON. Needs the save's own
 * scenario snapshot (for the scenario config a `[snapshot]` embeds), at the difficulty it was played at:
 * `current` is reused when it is that one, else it is fetched. Returns the file name.
 */
export async function downloadSave(name: string, campaigns: readonly CampaignInfo[], current?: GameBoardSnapshot): Promise<string> {
  const found = await loadGame<SaveGameData>(name);
  if (!found) throw new Error('that save no longer exists');
  const campaignId = found.meta.campaignId ?? found.data.campaignId;
  const campaign = campaigns.find((c) => c.id === campaignId) ?? null;
  const wesnoth = wesnothCampaignInfo(campaign);
  if (!wesnoth || !campaign) throw new Error('this campaign has no Wesnoth counterpart, so its saves cannot be exported');
  const scenarioId = found.data.scenarioId ?? found.meta.scenarioId;
  const difficulty = found.data.difficulty ?? defaultDifficulty(campaign);
  const snapshot =
    current && current.scenario.id === scenarioId && current.difficulty === difficulty
      ? current
      : await fetchScenarioSnapshot(scenarioId, campaign.assetDir, difficulty, defaultDifficulty(campaign));
  const gz = await gzipText(writeWml(toWesnothSave(found.data, snapshot, wesnoth)));
  downloadBlob(gz, downloadFileName(name));
  return downloadFileName(name);
}

/**
 * Imports a save file into storage. Accepts a real Wesnoth `.gz` (gzipped WML) or one of this port's own
 * saves, sniffed by content rather than by extension: both are gzip, and what is inside tells them apart.
 * Returns the (uniquified) name it was stored under, and the save.
 */
export async function importSaveFile(file: File): Promise<{ name: string; data: SaveGameData }> {
  const text = await gunzipToText(file);
  let data: SaveGameData;
  let name: string;
  if (text.trimStart().startsWith('{')) {
    data = JSON.parse(text) as SaveGameData;
    name = file.name.replace(/\.gz$/i, '');
  } else {
    const imported = fromWesnothSave(parseConfig(text));
    data = imported.save;
    name = imported.label || file.name.replace(/\.gz$/i, '');
  }
  if (!data.scenarioId) throw new Error('that file has no scenario in it');
  const unique = uniqueName(name, (await listSaves()).map((s) => s.name));
  await saveGame(
    unique,
    {
      scenarioId: data.scenarioId,
      scenarioName: data.scenarioName,
      campaignId: data.campaignId,
      label: name,
      turnNumber: data.turnNumber,
      kind: 'manual',
    },
    data,
  );
  return { name: unique, data };
}
