/**
 * TS port of `default_ai_context_impl::find_targets` (`src/ai/default/
 * contexts.cpp:124-264`): the AI's list of "places worth going" --
 * enemies threatening the leader, unclaimed villages (plus, if
 * `support_villages` is on, allied villages worth reinforcing), visible
 * enemy leaders, and every active `[goal]`'s own targets -- each nearby
 * target boosting the others' value by `otherValue / distance^2`.
 * `caMoveToTargets.ts`'s `move_to_targets_phase` is the only consumer.
 */

import { Location, distanceBetween, getAdjacentTiles } from '../../model/Location.js';
import { unitInvisible } from '../../pathfind/visibility.js';
import { calculateMoves } from '../moveMaps.js';
import type { MoveMap } from '../moveMaps.js';
import type { AiContext } from '../context.js';
import type { Target } from '../composite/target.js';

export function findTargets(ctx: AiContext, enemyDstSrc: MoveMap): Target[] {
  const board = ctx.board;
  const team = ctx.team();
  const leader = ctx.leaders()[0];
  const targets: Target[] = [];

  // Enemies threatening the leader.
  if (leader) {
    const threat = ctx.powerProjection(leader.location, enemyDstSrc);
    if (threat > 0) {
      const seen = new Set<string>();
      const threatUnits: Location[] = [];
      for (const adj of getAdjacentTiles(leader.location)) {
        for (const srcLoc of enemyDstSrc.get(adj.key()) ?? []) {
          if (!board.unitAt(srcLoc) || seen.has(srcLoc.key())) continue;
          seen.add(srcLoc.key());
          threatUnits.push(srcLoc);
        }
      }
      if (threatUnits.length > 0) {
        const value = threat / threatUnits.length;
        for (const loc of threatUnits) targets.push({ loc, value, type: 'threat' });
      }
    }
  }

  // Villages: unclaimed ones pull the leader in; allied ones worth reinforcing (support_villages=yes only).
  const cornerDistance = distanceBetween(new Location(0, 0), new Location(board.map.w(), board.map.h()));
  const villageValue = ctx.getVillageValue();
  if (leader && villageValue > 0) {
    const { dstSrc: friendsDstSrc } = calculateMoves(board, ctx.side, { enemy: false, assumeFullMovement: true, viewingTeam: team, seeAll: true });
    for (const villageLoc of board.map.villages) {
      const owner = board.villageOwner(villageLoc);
      const ownerTeam = owner !== undefined ? board.getTeam(owner) : undefined;
      const allyVillage = !!ownerTeam && !team.isEnemy(ownerTeam);

      if (allyVillage) {
        if (!ctx.getSupportVillages()) continue;
        let enemy = ctx.powerProjection(villageLoc, enemyDstSrc);
        if (enemy <= 0) continue;
        enemy *= 1.7;
        const our = ctx.powerProjection(villageLoc, friendsDstSrc);
        targets.push({ loc: villageLoc, value: (villageValue * our) / enemy, type: 'support' });
      } else {
        const leaderDistance = distanceBetween(villageLoc, leader.location);
        targets.push({ loc: villageLoc, value: villageValue * (1.0 - leaderDistance / cornerDistance), type: 'village' });
      }
    }
  }

  // Visible enemy leaders.
  if (ctx.getLeaderValue() > 0) {
    for (const u of board.allUnits()) {
      if (!u.canRecruit) continue;
      const uTeam = board.getTeam(u.side);
      if (!uTeam || !team.isEnemy(uTeam)) continue;
      if (unitInvisible(board, u)) continue;
      targets.push({ loc: u.location, value: ctx.getLeaderValue(), type: 'leader' });
    }
  }

  // Explicit [goal] targets.
  for (const goal of ctx.getGoals()) {
    if (goal.isActive(ctx)) goal.addTargets(ctx, targets);
  }

  // Nearby targets boost each other's value (Manhattan-ish distance, matching upstream's own |dx|+|dy|).
  const boosted = targets.map((t) => {
    let value = t.value;
    for (const other of targets) {
      if (other === t || other.loc.equals(t.loc)) continue;
      const distance = Math.abs(other.loc.x - t.loc.x) + Math.abs(other.loc.y - t.loc.y);
      value += other.value / (distance * distance);
    }
    return value;
  });
  targets.forEach((t, i) => {
    t.value = boosted[i]!;
  });

  return targets;
}
