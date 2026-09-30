/**
 * The time-of-day pages (Phase 24): a port of upstream's `generate_time_of_day_topics` (`help_impl.cpp`).
 * They describe the schedule of the scenario being played, so outside a game there is only the notice
 * upstream shows.
 */
import { combatModifier, DEFAULT_MAX_LIMINAL_BONUS, type Alignment } from '@wesnothweb2/engine';
import { _, type Topic } from '../helpCommon.js';
import type { HelpWorld } from '../helpWorld.js';
import { img, makeLink, spanColor, tag } from '../markup.js';

function bonusColored(bonus: number): string {
  return spanColor(bonus > 0 ? 'green' : bonus < 0 ? 'red' : 'white', bonus);
}

export function generateTimeOfDayTopics(world: HelpWorld): Topic[] {
  const times = world.times;
  if (!times) return [{ title: _('Time of Day Schedule'), id: '..schedule', text: _('Only available during a scenario.') }];

  const maxLiminal = world.game.maxLiminalBonus ?? DEFAULT_MAX_LIMINAL_BONUS;
  const topics: Topic[] = [];
  let toplevel = '';
  const alignments: Alignment[] = ['lawful', 'neutral', 'chaotic', 'liminal'];
  const icons = alignments.map((a) => img(`icons/alignments/alignment_${a}_30.png`));
  for (const time of times) {
    const id = 'time_of_day_' + time.id;
    const image = img(time.image);
    const bonuses = alignments.map((a) => combatModifier(time.lawfulBonus, a, false, maxLiminal));
    toplevel += tag(
      'row',
      tag('col', makeLink(time.name, id)),
      tag('col', image),
      ...bonuses.map((b, i) => tag('col', icons[i]!, bonusColored(b))),
    );
    const labels = [_('Lawful Bonus:'), _('Neutral Bonus:'), _('Chaotic Bonus:'), _('Liminal Bonus:')];
    let text = image + '\n' + (time.description ?? '') + '\n';
    bonuses.forEach((b, i) => (text += icons[i]! + labels[i]! + ' ' + bonusColored(b) + '\n'));
    text += '\n' + makeLink(_('Schedule'), '..schedule');
    topics.push({ title: time.name, id, text });
  }
  topics.push({ title: _('Time of Day Schedule'), id: '..schedule', text: tag('table', toplevel) });
  return topics;
}
