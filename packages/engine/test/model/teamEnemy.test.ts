import { describe, expect, it } from 'vitest';
import { Team } from '../../src/model/Team.js';

describe('Team.isEnemy (team::calculate_is_enemy)', () => {
  it('makes sides that share any team name allies, as The South Guard 1 sets up Mari', () => {
    const player = new Team(1, { teamName: 'South_Guard' });
    const mari = new Team(2, { teamName: 'South_Guard,quintain' });
    const quintains = new Team(3, { teamName: 'quintain' });
    const bandits = new Team(4, { teamName: 'bandits' });
    expect(mari.isEnemy(player)).toBe(false);
    expect(player.isEnemy(mari)).toBe(false);
    expect(mari.isEnemy(quintains)).toBe(false);
    expect(player.isEnemy(quintains)).toBe(true);
    expect(mari.isEnemy(bandits)).toBe(true);
  });

  it('ignores spaces and empty names, and a side is never its own enemy', () => {
    expect(new Team(1, { teamName: 'a, b' }).isEnemy(new Team(2, { teamName: 'b' }))).toBe(false);
    expect(new Team(1, { teamName: 'a,' }).isEnemy(new Team(2, { teamName: ',c' }))).toBe(true);
    const t = new Team(1, { teamName: '' });
    expect(t.isEnemy(t)).toBe(false);
  });
});
