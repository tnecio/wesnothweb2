import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GameBoard } from '../../src/model/GameBoard.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { EventManager, EventPump } from '../../src/events/pump.js';
import { VariableStore } from '../../src/events/variables.js';
import type { EventContext } from '../../src/events/context.js';
import { parseWml } from '../../src/wml/index.js';
import { WmlConfig, type WmlConfigJson } from '../../src/wml/config.js';
import type { UnitType } from '../../src/model/UnitType.js';
import { resolveStory } from '../../src/story/storyParser.js';

function makeCtx(vars: Record<string, string | number> = {}, log?: EventContext['log']): EventContext {
  const board = new GameBoard(GameMap.fromMapString('Gg, Gg\nGg, Gg', TerrainTypeData.fromConfigs([])));
  const variables = new VariableStore();
  for (const [k, v] of Object.entries(vars)) variables.set(k, v);
  const pump = new EventPump(new EventManager(), {
    board,
    variables,
    resolveType: (id: string): UnitType => {
      throw new Error(`no unit types in this test (${id})`);
    },
    log,
  });
  return pump.ctx;
}

describe('resolveStory', () => {
  it('builds the shortcut background layer first, then [background_layer]s and [image]s in order', () => {
    const cfg = parseWml(`
      [story]
        [part]
          story="Once upon a time"
          background=story/bg.webp
          scale_background=no
          [background_layer]
            image=maps/map.webp
            scale_horizontally=no
            base_layer=yes
          [/background_layer]
          [image]
            file=misc/dot.png
            x=100
            y=200
            delay=300
            centered=yes
          [/image]
        [/part]
      [/story]`);
    const [part] = resolveStory(cfg, 'The Scenario', makeCtx());
    expect(part!.text).toBe('Once upon a time');
    expect(part!.backgroundLayers).toEqual([
      { image: 'story/bg.webp', scaleHorizontally: false, scaleVertically: false, tileHorizontally: false, tileVertically: false, keepAspectRatio: true, baseLayer: false },
      { image: 'maps/map.webp', scaleHorizontally: false, scaleVertically: true, tileHorizontally: false, tileVertically: false, keepAspectRatio: true, baseLayer: true },
    ]);
    expect(part!.floatingImages).toEqual([{ file: 'misc/dot.png', x: 100, y: 200, delay: 300, resizeWithBackground: false, centered: true }]);
    expect(part!.showTitle).toBe(false);
    expect(part!.textLayout).toBe('bottom');
    expect(part!.textAlignment).toBe('left');
  });

  it('adds an empty shortcut layer even when the part has no background attributes', () => {
    const [part] = resolveStory(parseWml('[story]\n[part]\nstory=hi\n[/part]\n[/story]'), 'S', makeCtx());
    expect(part!.backgroundLayers).toHaveLength(1);
    expect(part!.backgroundLayers[0]!.image).toBe('');
  });

  it('keeps the upstream quirk where tile_background_horizontally sets the vertical flag', () => {
    const [part] = resolveStory(parseWml('[story]\n[part]\ntile_background_horizontally=yes\n[/part]\n[/story]'), 'S', makeCtx());
    expect(part!.backgroundLayers[0]!.tileHorizontally).toBe(false);
    expect(part!.backgroundLayers[0]!.tileVertically).toBe(true);
  });

  it('shows the scenario name as title when show_title=yes has no title, and title= implies show_title', () => {
    const parts = resolveStory(
      parseWml(`
        [story]
          [part]
            show_title=yes
          [/part]
          [part]
            title="Chapter One"
          [/part]
          [part]
            title="Hidden"
            show_title=no
          [/part]
        [/story]`),
      'Invasion!',
      makeCtx(),
    );
    expect(parts.map((p) => [p.showTitle, p.title])).toEqual([
      [true, 'Invasion!'],
      [true, 'Chapter One'],
      [false, 'Hidden'],
    ]);
  });

  it('decodes title_position relative to the text layout', () => {
    const titles = (attrs: string) => resolveStory(parseWml(`[story]\n[part]\nstory=x\n${attrs}\n[/part]\n[/story]`), 'S', makeCtx())[0]!.titlePosition;
    expect(titles('title_position=centered')).toEqual({ x: 50, y: 50 });
    expect(titles('title_position=right')).toEqual({ x: 100, y: 0 });
    expect(titles('title_position=center,bottom')).toEqual({ x: 50, y: 50 });
    expect(titles('title_position=center,bottom\ntext_layout=top')).toEqual({ x: 50, y: 100 });
    expect(titles('title_position=left,top\ntext_layout=top')).toEqual({ x: 0, y: 50 });
    expect(titles('title_position=left,middle\ntext_layout=middle')).toEqual({ x: 0, y: 0 });
  });

  it('branches with [if]/[elseif]/[else] at story and part level against variables', () => {
    const wml = `
      [story]
        [if]
          [variable]
            name=path
            equals=north
          [/variable]
          [then]
            [part]
              story="north"
            [/part]
          [/then]
          [elseif]
            [variable]
              name=path
              equals=south
            [/variable]
            [then]
              [part]
                story="south"
              [/part]
            [/then]
          [/elseif]
          [else]
            [part]
              story="nowhere"
            [/part]
          [/else]
        [/if]
        [part]
          story="common"
          [if]
            [variable]
              name=path
              equals=north
            [/variable]
            [then]
              [image]
                file=misc/north.png
              [/image]
            [/then]
          [/if]
        [/part]
      [/story]`;
    const texts = (vars: Record<string, string>) => resolveStory(parseWml(wml), 'S', makeCtx(vars)).map((p) => p.text);
    expect(texts({ path: 'north' })).toEqual(['north', 'common']);
    expect(texts({ path: 'south' })).toEqual(['south', 'common']);
    expect(texts({})).toEqual(['nowhere', 'common']);
    expect(resolveStory(parseWml(wml), 'S', makeCtx({ path: 'north' }))[1]!.floatingImages.map((i) => i.file)).toEqual(['misc/north.png']);
    expect(resolveStory(parseWml(wml), 'S', makeCtx({ path: 'south' }))[1]!.floatingImages).toEqual([]);
  });

  it('enters every matching [case] of a [switch], and all [else]s when none match', () => {
    const wml = `
      [story]
        [switch]
          variable=ending
          [case]
            value=good
            [part]
              story="good 1"
            [/part]
          [/case]
          [case]
            value=good
            [part]
              story="good 2"
            [/part]
          [/case]
          [else]
            [part]
              story="other"
            [/part]
          [/else]
        [/switch]
      [/story]`;
    expect(resolveStory(parseWml(wml), 'S', makeCtx({ ending: 'good' })).map((p) => p.text)).toEqual(['good 1', 'good 2']);
    expect(resolveStory(parseWml(wml), 'S', makeCtx({ ending: 'bad' })).map((p) => p.text)).toEqual(['other']);
  });

  it('substitutes $variables in attribute values and concatenates every [story]', () => {
    const parts = resolveStory(
      parseWml(`
        [story]
          [part]
            story="Welcome back, $hero_name."
          [/part]
        [/story]
        [story]
          [part]
          [/part]
          [part]
            story="Second story block"
          [/part]
        [/story]`),
      'S',
      makeCtx({ hero_name: 'Kai' }),
    );
    expect(parts.map((p) => p.text)).toEqual(['Welcome back, Kai.', 'Second story block']);
  });

  it('forwards [wml_message] to the log', () => {
    const logged: string[] = [];
    resolveStory(
      parseWml('[story]\n[wml_message]\nlogger=warn\nmessage="careful"\n[/wml_message]\n[/story]'),
      'S',
      makeCtx({}, (level, msg) => logged.push(`${level}:${msg}`)),
    );
    expect(logged).toEqual(['warn:careful']);
  });

  it("resolves Dead Water 1's real opening: five map parts plus the journey part with its battle markers", () => {
    const snapshot = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../../apps/web/public/scenarios/01_Invasion.json', import.meta.url)), 'utf8'),
    ) as { scenarioConfigJson: WmlConfigJson };
    const parts = resolveStory(WmlConfig.fromJSON(snapshot.scenarioConfigJson), 'Invasion!', makeCtx());
    expect(parts).toHaveLength(6);
    for (const part of parts.slice(0, 5)) {
      expect(part.text).not.toBe('');
      expect(part.backgroundLayers.map((l) => [l.image, l.baseLayer])).toEqual([
        ['', false],
        ['maps/background.webp', false],
        ['maps/dw.webp', true],
      ]);
    }
    const journey = parts[5]!;
    expect(journey.text).toBe('');
    expect([journey.showTitle, journey.title]).toEqual([true, 'Invasion!']);
    expect(journey.backgroundLayers[2]).toMatchObject({ image: 'maps/dw.webp', baseLayer: true, scaleVertically: true, scaleHorizontally: false });
    expect(journey.floatingImages).toHaveLength(5);
    expect(journey.floatingImages[0]).toEqual({ file: 'misc/new-battle2.png', x: 593, y: 740, delay: 500, resizeWithBackground: false, centered: true });
  });
});
