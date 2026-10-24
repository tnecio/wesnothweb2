/**
 * Phase 27c S2: what a unit's effects change in how the board draws it -- `apply_to=image_mod` (its sprite, as
 * `absolute_image() + image_mods()`), `apply_to=halo` and abilities' `halo_image=`/`overlay_image=`
 * (`units/drawer.cpp`), and `apply_to=new_animation` (its animations join its type's).
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameSession } from './gameSession.js';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';
import { parseWml } from '@wesnothweb2/engine/src/wml/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const snapshot = () => readScenarioSnapshot(path.join(repoRoot, 'apps/web/public/scenarios/combat/synth_combat_01.json'));
const object = (wml: string) => parseWml(`[object]\n${wml}\n[/object]`).child('object')!;

async function sessionWithUnit() {
  const session = new GameSession(snapshot());
  await session.runStartupEvents();
  const unit = session.board.allUnits()[0]!;
  const drawn = () => session.renderUnits.find((u) => u.x === unit.location.x && u.y === unit.location.y)!;
  return { session, unit, drawn };
}

describe('a unit as the board draws it', () => {
  it('apply_to=image_mod: the sprite carries the functions, and animation frames get them too', async () => {
    const { session, unit, drawn } = await sessionWithUnit();
    const plain = drawn().image!;
    unit.addModification('object', object('[effect]\napply_to=image_mod\nadd="GS()"\n[/effect]'));
    expect(drawn().image).toBe(`${plain}~GS()`);
    expect(drawn().imageMods).toBe('GS()');
    expect(session.unitInfo(unit).image).toBe(`${plain}~GS()`);
  });

  it("apply_to=halo and an ability's halo_image/overlay_image are drawn with the unit", async () => {
    const { unit, drawn } = await sessionWithUnit();
    expect(drawn().halos).toEqual([]);
    unit.addModification('object', object('[effect]\napply_to=halo\nhalo=halo/elven/shaman-heal-halo.png\n[/effect]'));
    unit.addModification(
      'object',
      object('[effect]\napply_to=new_ability\n[abilities]\n[illuminates]\nid=lit\nvalue=25\nmax_value=25\naffect_self=yes\nhalo_image=halo/illuminates-aura.png\noverlay_image=misc/hero-icon.png\n[/illuminates]\n[/abilities]\n[/effect]'),
    );
    expect(drawn().halos).toEqual(['halo/elven/shaman-heal-halo.png', 'halo/illuminates-aura.png']);
    expect(drawn().overlays).toContain('misc/hero-icon.png');
  });

  it("apply_to=new_animation: the unit's own animations are kept for it, not its type", async () => {
    const { session, unit } = await sessionWithUnit();
    unit.addModification('object', object('[effect]\napply_to=new_animation\n[extra_anim]\nflag=glow\n[frame]\nimage=units/human-loyalists/spearman.png:100\n[/frame]\n[/extra_anim]\n[/effect]'));
    expect(unit.newAnimations.map((e) => e.child('extra_anim')?.getString('flag'))).toEqual(['glow']);
    const other = session.board.allUnits().find((u) => u !== unit && u.type === unit.type);
    if (other) expect(other.newAnimations).toEqual([]);
  });
});
