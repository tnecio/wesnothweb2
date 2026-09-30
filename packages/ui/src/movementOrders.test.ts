import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Location, WmlConfig, distanceBetween, getAdjacentTiles, recalculateFog, type Unit } from '@wesnothweb2/engine';
import { GameSession } from './gameSession.js';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';

/**
 * Phase 28b: route previews (footsteps with turn numbers), the reach of a
 * hovered unit, multi-turn orders (`goto`) and move-and-attack, on real
 * Dead Water scenario 1.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const snapshotPath = path.join(repoRoot, 'apps/web/public/scenarios/Dead_Water/01_Invasion.json');

async function start(): Promise<{ session: GameSession; kai: Unit; malKevek: Unit }> {
  const session = new GameSession(readScenarioSnapshot(snapshotPath));
  await session.runStartupEvents();
  const kai = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
  const malKevek = session.board.allUnits().find((u) => u.id === 'Mal-Kevek')!;
  return { session, kai, malKevek };
}

function place(session: GameSession, unit: Unit, x: number, y: number): void {
  session.board.moveUnit(unit.location, new Location(x, y));
}

/** A hex `turns` or more turns away for `unit` along row `y`, searching west from its own column. */
function farHex(session: GameSession, unit: Unit, turns: number, y: number): Location {
  session.selectUnit(unit);
  for (let x = unit.location.x - 1; x >= 0; x--) {
    const route = session.routePreview(x, y);
    if (route && route.marks.at(-1)!.turns >= turns) return new Location(x, y);
  }
  throw new Error('no far hex');
}

describe('route preview (footsteps)', () => {
  it('shows the route to a hex beyond this turn, with where each turn ends and the defense there', async () => {
    const { session, kai } = await start();
    const dest = farHex(session, kai, 3, 10);
    const route = session.routePreview(dest.x, dest.y)!;
    expect(route.steps[0]).toMatchObject({ x: kai.location.x, y: kai.location.y });
    expect(route.steps.at(-1)).toMatchObject({ x: dest.x, y: dest.y });
    expect(route.marks.map((m) => m.turns)).toEqual(route.marks.map((_, i) => i + 1));
    for (const mark of route.marks) {
      expect(mark.defensePercent).toBe(100 - kai.defenseModifier(session.board.map.getTerrain(new Location(mark.x, mark.y))));
    }
    // A hex reachable this turn: only the destination is marked, turn 1.
    const near = session.reachable[0]!;
    const nearRoute = session.routePreview(near.x, near.y)!;
    expect(nearRoute.marks).toHaveLength(1);
    expect(nearRoute.marks[0]).toMatchObject({ x: near.x, y: near.y, turns: 1 });
  });

  it('shows no route to the unit itself or to a hex with a unit on it', async () => {
    const { session, kai } = await start();
    session.selectUnit(kai);
    expect(session.routePreview(kai.location.x, kai.location.y)).toBeNull();
    const gwabbo = session.board.allUnits().find((u) => u.id === 'Gwabbo')!;
    expect(session.routePreview(gwabbo.location.x, gwabbo.location.y)).toBeNull();
    session.clearSelection();
    expect(session.routePreview(5, 10)).toBeNull();
  });
});

describe('hovering a unit with nothing selected', () => {
  it("shows an enemy's reach with its full moves, as upstream does", async () => {
    const { session, malKevek } = await start();
    malKevek.movesLeft = 0;
    const preview = session.hoverPreview(malKevek.location.x, malKevek.location.y)!;
    expect(preview.reach.length).toBeGreaterThan(0);
    expect(malKevek.movesLeft).toBe(0);
    expect(preview.route).toBeNull();
  });

  it('shows nothing while a unit is selected, or over an empty hex', async () => {
    const { session, kai, malKevek } = await start();
    expect(session.hoverPreview(5, 10)).toBeNull();
    session.selectUnit(kai);
    expect(session.hoverPreview(malKevek.location.x, malKevek.location.y)).toBeNull();
  });
});

describe('multi-turn orders (goto)', () => {
  it('goes as far as it can now, keeps the order, and continues it at the start of later turns', async () => {
    const { session, kai } = await start();
    const dest = farHex(session, kai, 3, 10);
    const startLoc = kai.location;
    const message = await session.handleHexClick(dest.x, dest.y);
    expect(message).toContain('go on next turn');
    expect(kai.location.equals(startLoc)).toBe(false);
    expect(kai.movesLeft).toBe(0);
    expect(kai.goto?.equals(dest)).toBe(true);
    // Hovering the unit shows the order's route.
    session.clearSelection();
    const hover = session.hoverPreview(kai.location.x, kai.location.y)!;
    expect(hover.route?.steps.at(-1)).toMatchObject({ x: dest.x, y: dest.y });

    // Later turns: the order is carried on until the unit arrives.
    for (let turn = 2; turn <= 4 && !kai.location.equals(dest); turn++) {
      const before = kai.location;
      kai.movesLeft = kai.maxMoves;
      await session.executeGotos();
      expect(kai.location.equals(before)).toBe(false);
    }
    expect(kai.location.equals(dest)).toBe(true);
    expect(kai.goto).toBeUndefined();
  });

  it('is dropped by a new order, and by clicking the unit itself', async () => {
    const { session, kai } = await start();
    const dest = farHex(session, kai, 3, 10);
    await session.handleHexClick(dest.x, dest.y);
    expect(kai.goto).toBeDefined();
    kai.movesLeft = kai.maxMoves;

    session.selectUnit(kai);
    await session.handleHexClick(kai.location.x, kai.location.y);
    expect(kai.goto).toBeUndefined();

    await session.handleHexClick(dest.x, dest.y);
    kai.movesLeft = kai.maxMoves;
    session.selectUnit(kai);
    const near = session.reachable.find((h) => !(h.x === dest.x && h.y === dest.y))!;
    await session.handleHexClick(near.x, near.y);
    expect(kai.location).toMatchObject({ x: near.x, y: near.y });
    expect(kai.goto).toBeUndefined();
  });

  it('is left for later when the unit has no moves left now', async () => {
    const { session, kai } = await start();
    const dest = farHex(session, kai, 2, 10);
    kai.movesLeft = 0;
    const startLoc = kai.location;
    await session.handleHexClick(dest.x, dest.y);
    expect(kai.location.equals(startLoc)).toBe(true);
    expect(kai.goto?.equals(dest)).toBe(true);
  });
});

describe('move-and-attack', () => {
  /** Kai at (24,10), Mal-Kevek three hexes south at (24,13): Kai can reach (24,12), right above him. */
  async function facing(): Promise<{ session: GameSession; kai: Unit; malKevek: Unit; from: Location }> {
    const { session, kai, malKevek } = await start();
    for (const u of session.board.allUnits()) if (u !== kai && u !== malKevek && distanceBetween(u.location, new Location(24, 11)) <= 3) session.board.removeUnitAt(u.location);
    place(session, kai, 24, 10);
    place(session, malKevek, 24, 13);
    session.selectUnit(kai);
    return { session, kai, malKevek, from: new Location(24, 12) };
  }

  it('picks the hex the pointer came from to attack from', async () => {
    const { session, malKevek, from } = await facing();
    expect(session.attackFrom({ x: malKevek.location.x, y: malKevek.location.y }, { x: from.x, y: from.y }, { x: from.x, y: from.y })).toEqual({ x: from.x, y: from.y });
    // From the south-west instead: the reachable hex on that side.
    const sw = getAdjacentTiles(malKevek.location)[4]!;
    const chosen = session.attackFrom({ x: malKevek.location.x, y: malKevek.location.y }, { x: sw.x, y: sw.y }, { x: sw.x, y: sw.y });
    expect(chosen).not.toBeNull();
    expect(distanceBetween(new Location(chosen!.x, chosen!.y), malKevek.location)).toBe(1);
  });

  it('opens the prediction as fought from the chosen hex, and dismissing it changes nothing', async () => {
    const { session, kai, malKevek, from } = await facing();
    const startLoc = kai.location;
    const moves = kai.movesLeft;
    await session.handleHexClick(malKevek.location.x, malKevek.location.y, { attackFrom: { x: from.x, y: from.y } });
    const pending = session.pendingAttack!;
    expect(pending.from.equals(from)).toBe(true);
    expect(kai.location.equals(startLoc)).toBe(true);
    // Mal-Kevek's chance to hit Kai is Kai's defense on the hex he attacks from, not where he stands.
    const defenseThere = kai.defenseModifier(session.board.map.getTerrain(from));
    expect(defenseThere).not.toBe(kai.defenseModifier(session.board.map.getTerrain(startLoc)));
    expect(pending.preview.defender.weapon).toBeDefined();
    expect(pending.preview.defender.chanceToHit).toBe(defenseThere);
    session.cancelAttack();
    expect(session.pendingAttack).toBeNull();
    expect(kai.location.equals(startLoc)).toBe(true);
    expect(kai.movesLeft).toBe(moves);
    expect(session.selectedUnit).toBe(kai);
  });

  it('moves, then attacks, when confirmed', async () => {
    const { session, kai, malKevek, from } = await facing();
    await session.handleHexClick(malKevek.location.x, malKevek.location.y, { attackFrom: { x: from.x, y: from.y } });
    await session.confirmAttack();
    expect(kai.location.equals(from)).toBe(true);
    expect(kai.attacksLeft).toBe(0);
    expect(session.lastAttackAnimation).not.toBeNull();
  });

  it('closes the prediction as soon as it is confirmed: not open again during the move or the attack event\'s dialogue', async () => {
    const { session, malKevek, from } = await facing();
    const event = new WmlConfig().setAttribute('name', 'attack');
    event.addChild('message').setAttribute('speaker', 'narrator').setAttribute('message', 'Have at you!');
    session['eventPump'].manager.addFromWml(event);
    await session.handleHexClick(malKevek.location.x, malKevek.location.y, { attackFrom: { x: from.x, y: from.y } });
    expect(session.pendingAttack).not.toBeNull();
    const seen: string[] = [];
    session.interactionHost = {
      async handle(interaction) {
        seen.push(`${interaction.kind === 'beat' ? interaction.beat.kind : interaction.kind}:${session.pendingAttack !== null}`);
        return {};
      },
    };
    await session.confirmAttack();
    expect(seen).toContain('moveUnit:false');
    expect(seen).toContain('message:false');
    expect(seen.filter((s) => s.endsWith(':true'))).toEqual([]);
  });

  it('marks the enemies it could attack from a hex it can reach this turn', async () => {
    const { session, kai, malKevek, from } = await facing();
    expect(session.attackCandidatesFrom(from.x, from.y)).toEqual([malKevek]);
    // Not next to Mal-Kevek where Kai stands, and nothing to attack from a hex beyond this turn.
    expect(session.attackCandidates).toEqual([]);
    const far = farHex(session, kai, 2, 10);
    expect(session.attackCandidatesFrom(far.x, far.y)).toEqual([]);
  });

  it('does not attack when an ambush stops the move', async () => {
    const { session, kai, malKevek, from } = await facing();
    session.clearSelection();
    session.selectUnit(kai);
    await session.handleHexClick(malKevek.location.x, malKevek.location.y, { attackFrom: { x: from.x, y: from.y } });
    // A hidden enemy next to the first step of the way, but not next to where Kai stands.
    const route = session.routePreview(from.x, from.y)!.steps.map((s) => new Location(s.x, s.y));
    const lurkAt = getAdjacentTiles(route[1]!).find(
      (l) => !route.some((r) => r.equals(l)) && distanceBetween(l, route[0]!) > 1 && !session.board.hasUnitAt(l) && session.board.map.onBoard(l),
    )!;
    const fiend = session.board.allUnits().find((u) => u.id === 'fiend')!;
    place(session, fiend, lurkAt.x, lurkAt.y);
    fiend.hidden = true;
    const hp = malKevek.hitpoints;
    await session.confirmAttack();
    expect(kai.location.equals(route[1]!)).toBe(true);
    expect(kai.attacksLeft).toBe(1);
    expect(malKevek.hitpoints).toBe(hp);
    expect(session.lastAttackAnimation).toBeNull();
  });
});

describe('continue move (t)', () => {
  /** Fog on for Kai's side, and an enemy just out of his sight along the way west. */
  async function sightedOnTheWay(): Promise<{ session: GameSession; kai: Unit; dest: Location }> {
    const { session, kai, malKevek } = await start();
    const team = session.board.getTeam(1)!;
    team.fog.enabled = true;
    for (const u of session.board.allUnits()) if (u.side === 1 && u !== kai) session.board.removeUnitAt(u.location);
    place(session, malKevek, 8, 12);
    recalculateFog(session.board, 1);
    session.selectUnit(kai);
    return { session, kai, dest: new Location(14, 10) };
  }

  it('a move stopped by sighting units remembers where it was headed, and t walks on without stopping again', async () => {
    const { session, kai, dest } = await sightedOnTheWay();
    expect(session.board.isFogged(1, new Location(8, 12))).toBe(true);
    const message = await session.handleHexClick(dest.x, dest.y);
    expect(message).toContain('sighted');
    expect(kai.location.equals(dest)).toBe(false);
    expect(kai.interruptedMove?.equals(dest)).toBe(true);
    expect(session.canContinueMove(kai.location.x, kai.location.y)).toBe(true);

    await session.continueMove(kai.location.x, kai.location.y);
    expect(kai.location.equals(dest)).toBe(true);
    expect(kai.interruptedMove).toBeUndefined();
    expect(session.canContinueMove(kai.location.x, kai.location.y)).toBe(false);
  });

  it('is forgotten at the end of the turn', async () => {
    const { session, kai, dest } = await sightedOnTheWay();
    await session.handleHexClick(dest.x, dest.y);
    expect(kai.interruptedMove).toBeDefined();
    kai.endTurn();
    expect(kai.interruptedMove).toBeUndefined();
  });
});
