import { describe, expect, it } from 'vitest';
import { Team } from '../../src/model/Team.js';
import { parseWml } from '../../src/wml/index.js';

/** `team::team_info::read`: `controller=` is read as `side_controller`, an AI when absent or unknown. */
describe('a side\'s controller', () => {
  const side = (body: string) => Team.fromConfig(parseWml(`[side]\nside=2\n${body}\n[/side]`).child('side')!);

  it('is ai when not given (Northern Rebirth 1\'s hidden side 4, Dead Water 4\'s side 2)', () => {
    expect(side('no_leader=yes').controller).toBe('ai');
  });

  it('keeps human, ai and null (an empty side, which takes no turns)', () => {
    expect(side('controller=human').controller).toBe('human');
    expect(side('controller=ai').controller).toBe('ai');
    expect(side('controller=null').controller).toBe('null');
  });
});
