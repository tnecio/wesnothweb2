/**
 * Terrain pages (Phase 24): ports of upstream's `generate_terrain_sections` (`help_impl.cpp`) and
 * `terrain_topic_generator` with its helpers (`help_topic_generators.cpp`).
 *
 * Every terrain counts as encountered (see `helpWorld.ts`), so a terrain is hidden only by `hide_help=`.
 */
import { BASE_MARKER, formatMessage, MINUS, PLUS, type TerrainCode } from '@wesnothweb2/engine';
import { t as tLib } from '../../i18n/locale.js';
import { _, BULLET, hiddenSymbol, newSection, TERRAIN_PREFIX, titleLess, vgettext, vngettext, type Section, type Topic } from '../helpCommon.js';
import type { HelpTerrain, HelpWorld } from '../helpWorld.js';
import { img, makeLink, spanColor, tag } from '../markup.js';

/** `generate_terrain_sections`: a section per basic terrain, holding every terrain built on it. */
export function generateTerrainSections(world: HelpWorld, sec: Section): void {
  const baseMap = new Map<string, Section>();
  for (const info of world.terrains) {
    const hidden = info.hideHelp;
    const topic: Topic = { title: info.editorName, id: hiddenSymbol(hidden) + TERRAIN_PREFIX + info.id, text: () => terrainTopicText(world, info) };
    const bases: TerrainCode[] = [...info.unionType];
    const defaultBase = info.defaultBase;
    if (defaultBase) {
      for (const b of world.terrainData.getTerrainInfo(defaultBase).unionType) if (!bases.some((x) => x.equals(b))) bases.push(b);
    }
    for (const base of bases) {
      const baseInfo = world.terrain(base);
      if (!baseInfo || !baseInfo.isNonnull || baseInfo.hideHelp) continue;
      let section = baseMap.get(baseInfo.id);
      if (!section) baseMap.set(baseInfo.id, (section = newSection()));
      section.id = TERRAIN_PREFIX + baseInfo.id;
      section.title = baseInfo.editorName;
      // As upstream, the id change carries over to the topic's later copies.
      if (baseInfo.id === info.id) topic.id = '..' + TERRAIN_PREFIX + info.id;
      section.topics.push({ ...topic });
    }
  }
  const sorted = [...baseMap]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, s]) => s)
    .sort(titleLess);
  sec.sections.push(...sorted);
}

function bestStr(best: boolean): string {
  return spanColor(best ? 'green' : 'red', best ? _('Best of') : _('Worst of'));
}

/** `print_behavior_description`: an alias list as "Best of Hills, Mountains" and so on. */
function printBehaviorDescription(world: HelpWorld, list: readonly TerrainCode[], start: number, end: number, firstLevel = true, beginBest = true): string {
  if (start === end) return '';
  if (list[start]!.equals(MINUS) || list[start]!.equals(PLUS)) {
    return printBehaviorDescription(world, list, start + 1, end, firstLevel, list[start]!.equals(PLUS));
  }
  let lastChange: number | null = null;
  let best = beginBest;
  for (let i = start; i !== end; i++) {
    if ((best && list[i]!.equals(MINUS)) || (!best && list[i]!.equals(PLUS))) {
      best = !best;
      lastChange = i;
    }
  }
  const nameOf = (code: TerrainCode): string => world.terrain(code)?.editorName ?? '';
  let ss = '';
  if (lastChange === null) {
    const names: string[] = [];
    for (let i = start; i !== end; i++) {
      // TRANSLATORS: in a description of an overlay terrain, the terrain that it's placed on
      if (list[i]!.equals(BASE_MARKER)) names.push(_('base terrain'));
      else {
        const name = nameOf(list[i]!);
        if (name) names.push(name);
      }
    }
    if (names.length === 0) return '';
    if (names.length === 1) return names[0]!;
    ss += bestStr(best) + ' ';
    if (!firstLevel) ss += '( ';
    ss += names.join(', ');
    if (!firstLevel) ss += ' )';
  } else {
    const names: string[] = [];
    for (let i = lastChange + 1; i !== end; i++) {
      const name = nameOf(list[i]!);
      if (name) names.push(name);
    }
    if (names.length === 0) return printBehaviorDescription(world, list, start, lastChange, firstLevel, beginBest);
    ss += bestStr(best) + ' ';
    if (!firstLevel) ss += '( ';
    ss += printBehaviorDescription(world, list, start, lastChange - 1, false, beginBest);
    for (const s of names) ss += ', ' + s;
    if (!firstLevel) ss += ' )';
  }
  return ss;
}

/** `get_special_notes` for a terrain. */
function specialNotes(t: HelpTerrain): string[] {
  const notes: string[] = [];
  if (t.isVillage) notes.push(_('Villages allow any unit stationed therein to heal, or to be cured of poison.'));
  else if (t.givesHealing > 0) {
    notes.push(
      vngettext(
        'This terrain allows units to be cured of poison, or to heal a single hitpoint.',
        'This terrain allows units to heal $amount hitpoints, or to be cured of poison, as if stationed in a village.',
        t.givesHealing,
        { amount: t.givesHealing },
      ),
    );
  }
  if (t.isCastle) notes.push(_('This terrain is a castle — units can be recruited onto it from a connected keep.'));
  if (t.isKeep && t.isCastle) notes.push(_('This terrain is a keep — a leader can recruit from this hex onto connected castle hexes.'));
  else if (t.isKeep && !t.isCastle) {
    notes.push(_('This unusual keep allows a leader to recruit while standing on it, but does not allow a leader on a connected keep to recruit onto this hex.'));
  }
  return notes;
}

/** `utils::format_conjunct_list("", items)`, with its `wesnoth-lib` strings. */
function formatConjunctList(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  const f = (msgid: string, vars: Record<string, string>) => formatMessage(tLib(msgid), vars);
  if (items.length === 2) return f('conjunct pair^$first and $second', { first: items[0]!, second: items[1]! });
  let prefix = f('conjunct start^$first, $second', { first: items[0]!, second: items[1]! });
  for (let i = 2; i < items.length - 1; i++) prefix = f('conjunct mid^$prefix, $next', { prefix, next: items[i]! });
  return f('conjunct end^$prefix, and $last', { prefix, last: items[items.length - 1]! });
}

/** `terrain_topic_generator::operator()`: a terrain's page. */
export function terrainTopicText(world: HelpWorld, t: HelpTerrain): string {
  let ss = '';
  if (t.iconImage) ss += img(`images/buttons/icon-base-32.png~RC(magenta>${t.id})~BLIT(terrain/${t.iconImage}_30.png)`);
  if (t.editorImage) ss += img(t.editorImage);
  ss += '\n';
  if (t.helpTopicText) ss += t.helpTopicText + '\n';

  const notes = specialNotes(t);
  if (notes.length > 0) {
    ss += '\n\n' + tag('header', _('Special Notes')) + '\n\n';
    for (const note of notes) ss += `${BULLET} ${note}\n`;
  }

  if (!t.isIndivisible) {
    const underlying: string[] = [];
    for (const code of t.unionType) {
      const base = world.terrain(code);
      if (base && base.editorName) underlying.push(makeLink(base.editorName, '..' + TERRAIN_PREFIX + base.id));
    }
    // TRANSLATORS: $types is a conjunct list, typical values will be "Castle" or "Flat and Shallow Water".
    ss += '\n' + vngettext('Basic terrain type: $types', 'Basic terrain types: $types', underlying.length, { types: formatConjunctList(underlying) });
    const defaultBase = t.defaultBase;
    if (defaultBase) {
      const base = world.terrain(defaultBase);
      if (base) {
        const type = makeLink(base.editorName, (base.isIndivisible ? '..' : '') + TERRAIN_PREFIX + base.id);
        ss += '\n' + vgettext('Typical base terrain: $type', { type });
      }
    }
    ss += '\n';
    ss += '\n' + _('Movement properties: ') + printBehaviorDescription(world, t.mvtType, 0, t.mvtType.length) + '\n';
    ss += '\n' + _('Defense properties: ') + printBehaviorDescription(world, t.defType, 0, t.defType.length) + '\n';
  }
  return ss;
}
