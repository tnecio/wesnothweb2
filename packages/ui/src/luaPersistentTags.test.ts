/**
 * Lua's `wesnoth.persistent_tags` across a save and a load (`game_lua_kernel::save_game`/`load_game`): Heir to the
 * Throne Classic's tutorial hint (`lua/hint_message.lua`, an overlay shown until replaced) comes back when the game
 * is loaded, as upstream restores it.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFlow, type FloatingLabelRequest, type Flow } from '@wesnothweb2/engine';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';
import { GameSession } from './gameSession.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tutorial = () => readScenarioSnapshot(path.join(repoRoot, 'apps/web/public/scenarios/Heir_To_The_Throne_Classic/tutorial.json'));

const overlays = (labels: FloatingLabelRequest[]) =>
  labels.flatMap((l) => (l.kind === 'overlay' ? [{ text: typeof l.text === 'string' ? l.text : l.text.str(), duration: l.duration }] : []));

describe('Lua persistent tags in saves', () => {
  it("the tutorial's hint is saved, and shown again when the game is loaded", async () => {
    const shown: FloatingLabelRequest[] = [];
    const s = new GameSession(tutorial(), { onFloatingLabel: (r) => shown.push(r) });
    await s.runStartupEvents();
    const runtime = (s as unknown as { luaRuntime: { runChunk(code: string, name: string): Flow } }).luaRuntime;
    runFlow(runtime.runChunk(`wesnoth.wml_actions.hint_message { caption = "Victory", message = "The scenario is over." }`, '=hint'));
    expect(overlays(shown).at(-1)?.text).toContain('The scenario is over.');

    const data = s.toSaveData();
    const tags = data.luaTags?.children?.map((c) => c.tag) ?? [];
    expect(tags).toContain('hint_message');
    // The tags this port saves itself are not in it twice.
    expect(tags.filter((t) => ['item', 'next_item_name', 'used_items', 'objectives'].includes(t))).toEqual([]);

    const loadedLabels: FloatingLabelRequest[] = [];
    const loaded = GameSession.fromSaveData(tutorial(), JSON.parse(JSON.stringify(data)), { onFloatingLabel: (r) => loadedLabels.push(r) });
    const restored = overlays(loadedLabels);
    expect(restored.at(-1)?.text).toContain('Victory');
    expect(restored.at(-1)?.text).toContain('The scenario is over.');
    expect(restored.at(-1)?.duration).toBe(-1);
    expect(loaded.toSaveData().luaTags).toEqual(data.luaTags);
  }, 120_000);
});
