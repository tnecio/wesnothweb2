/**
 * Unit and race pages (Phase 24): ports of upstream's `generate_races_sections`, `generate_unit_sections`,
 * `generate_unit_topics`, `make_unit_link` (`help_impl.cpp`), `get_unit_type_help_id` (`help.cpp`) and
 * `unit_topic_generator` (`help_topic_generators.cpp`).
 */
import { FOGGED, VOID_TERRAIN, terrainMatches, parseTerrainList, WmlConfig, type MoveType } from '@wesnothweb2/engine';
import { redToGreen } from '@wesnothweb2/renderer/src/colorScales.js';
import { alignmentName } from '../../i18n/gameText.js';
import {
  ABILITY_PREFIX,
  BULLET,
  compareText,
  EM_DASH,
  FIGURE_DASH,
  hiddenSymbol,
  NBSP,
  newSection,
  RACE_PREFIX,
  stringSet,
  titleLess,
  UNICODE_MINUS,
  UNIT_PREFIX,
  UNKNOWN_UNIT_TOPIC,
  VARIATION_PREFIX,
  vgettext,
  vngettext,
  WEAPON_NUMBERS_SEP,
  WEAPONSPECIAL_PREFIX,
  type Section,
  type Topic,
} from '../helpCommon.js';
import { th, tw } from '../../i18n/locale.js';
import type { HelpUnitType, HelpWorld, SpecialTooltip } from '../helpWorld.js';
import { helpTopicIdOf } from '../helpWorld.js';
import { bold, img, italic, makeLink, spanColor, tag, tagAttr } from '../markup.js';

/** Every unit type gets a full description (upstream: all encountered, or "show all units in help"). */
export function hasFullDescription(type: HelpUnitType): boolean {
  // `HIDDEN_BUT_SHOW_MACROS`: the one type upstream never describes but still counts for its macros.
  return type.id !== 'Fog Clearer';
}

/** `unit_type::alignment_description(alignment, gender)`. */
export function alignmentDescription(type: HelpUnitType): string {
  return alignmentName(type.alignment);
}

/** `get_unit_type_help_id`: the topic a unit type's "Unit Description" opens. */
export function unitTypeHelpId(world: HelpWorld, type: HelpUnitType): string {
  let varId = type.variationId;
  if (varId === '') varId = type.variationName;
  let hideHelp = type.hideHelp;
  let useVariation = false;
  if (varId !== '') {
    const parent = world.unitType(type.id);
    if (hideHelp) hideHelp = parent?.hideHelp ?? hideHelp;
    else useVariation = true;
  }
  if (useVariation) return hiddenSymbol(hideHelp) + VARIATION_PREFIX + type.id + '_' + varId;
  return hiddenSymbol(hideHelp) + (type.showVariationsInHelp ? '..' : '') + UNIT_PREFIX + type.id;
}

/** `make_unit_link`. */
export function makeUnitLink(world: HelpWorld, typeId: string): string {
  const type = world.unitType(typeId);
  if (!type) return typeId;
  if (type.hideHelp) return '';
  let name = type.typeName;
  let refId: string;
  if (hasFullDescription(type)) {
    refId = (type.showVariationsInHelp ? '..' : '') + UNIT_PREFIX + type.id;
  } else {
    refId = UNKNOWN_UNIT_TOPIC;
    name += ' (?)';
  }
  return makeLink(name, refId);
}

/** `make_unit_links_list`. */
export function makeUnitLinksList(world: HelpWorld, ids: readonly string[], ordered: boolean): string[] {
  const links = ids.map((id) => makeUnitLink(world, id)).filter((l) => l !== '');
  if (ordered) links.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return links;
}

/** `generate_races_sections`. `parseSection` is `parse_config_internal` for a generated `[section]`. */
export function generateRacesSections(world: HelpWorld, sec: Section, parseSection: (cfg: WmlConfig) => Section): void {
  const races = new Set<string>();
  const visibleRaces = new Set<string>();
  for (const id of world.typeIds()) {
    const type = world.unitType(id)!;
    if (!hasFullDescription(type)) continue;
    races.add(type.raceId);
    if (!type.hideHelp) visibleRaces.add(type.raceId);
  }
  // Visibility propagates up `[race] help_taxonomy=`.
  let lastSweep = [...visibleRaces];
  while (lastSweep.length > 0) {
    const current: string[] = [];
    for (const raceId of lastSweep) {
      const taxonomy = world.race(raceId)?.getString('help_taxonomy') ?? '';
      if (taxonomy && !visibleRaces.has(taxonomy) && world.race(taxonomy)) {
        current.push(taxonomy);
        races.add(taxonomy);
        visibleRaces.add(taxonomy);
      }
    }
    lastSweep = current;
  }

  const queue: { parentId: string; content: Section }[] = [];
  for (const raceId of stringSet(races)) {
    const hidden = !visibleRaces.has(raceId);
    const race = world.race(raceId);
    const cfg = new WmlConfig();
    cfg.setAttribute('id', hiddenSymbol(hidden) + RACE_PREFIX + raceId);
    cfg.setAttribute('title', race ? race.getString('plural_name') : tw('race^Miscellaneous'));
    cfg.setAttribute('sections_generator', 'units:' + raceId);
    cfg.setAttribute('generator', 'units:' + raceId);
    const raceSection = parseSection(cfg);
    const taxonomy = race?.getString('help_taxonomy') ?? '';
    if (!taxonomy) sec.sections.push(raceSection);
    else queue.push({ parentId: hiddenSymbol(!visibleRaces.has(taxonomy)) + RACE_PREFIX + taxonomy, content: raceSection });
  }
  let again = true;
  let pending = queue;
  while (again && pending.length > 0) {
    again = false;
    const toProcess = pending;
    pending = [];
    for (const x of toProcess) {
      const parent = findSectionIn(sec, x.parentId);
      if (parent) {
        parent.sections.push(x.content);
        again = true;
      } else pending.push(x);
    }
  }
  for (const x of pending) sec.sections.push(x.content);
}

function findSectionIn(sec: Section, id: string): Section | undefined {
  for (const s of sec.sections) if (s.id === id) return s;
  for (const s of sec.sections) {
    const found = findSectionIn(s, id);
    if (found) return found;
  }
  return undefined;
}

/** `generate_unit_sections`: a section per type with visible variations, holding the variations' pages. */
export function generateUnitSections(world: HelpWorld, sec: Section, race: string): void {
  for (const id of world.typeIds()) {
    const type = world.unitType(id)!;
    if (type.raceId !== race || !type.showVariationsInHelp) continue;
    const base = newSection();
    for (const variationId of type.variations) {
      const varType = type.variation(variationId);
      const ref = hiddenSymbol(varType.hideHelp) + VARIATION_PREFIX + varType.id + '_' + variationId;
      base.topics.push({ title: varType.variationName, id: ref, text: () => unitTopicText(world, varType, variationId) });
    }
    base.id = hiddenSymbol(type.hideHelp) + UNIT_PREFIX + type.id;
    base.title = type.typeName;
    sec.sections.push(base);
  }
}

/** `generate_unit_topics`: a race's units, and the race's own page. */
export function generateUnitTopics(world: HelpWorld, race: string, sortGenerated: boolean): Topic[] {
  const topics: Topic[] = [];
  const raceUnits: string[] = [];
  const alignments = new Set<string>();

  for (const id of world.typeIds()) {
    const type = world.unitType(id)!;
    if (type.raceId !== race || !hasFullDescription(type)) continue;
    const typeName = type.typeName;
    const realPrefix = type.showVariationsInHelp ? '..' : '';
    const refId = hiddenSymbol(type.hideHelp) + realPrefix + UNIT_PREFIX + type.id;
    topics.push({ title: typeName, id: refId, text: () => unitTopicText(world, type, '') });
    if (!type.hideHelp) {
      raceUnits.push(makeLink(typeName, refId));
      alignments.add(makeLink(alignmentDescription(type), 'time_of_day'));
    }
  }

  const raceCfg = world.race(race);
  const raceId = '..race_' + race;
  let raceName: string;
  let raceDescription = '';
  let raceTaxonomy = '';
  if (raceCfg) {
    raceName = raceCfg.getString('plural_name');
    raceDescription = raceCfg.getString('description');
    raceTaxonomy = raceCfg.getString('help_taxonomy');
    for (const extra of raceCfg.children('topic')) {
      const id = extra.getString('id');
      const title = extra.getString('title');
      topics.push({ title, id, text: extra.getString('text') });
    }
  } else {
    raceName = tw('race^Miscellaneous');
  }

  // Races whose `help_taxonomy=` points at this one, by id (a `std::map`).
  const subgroups = new Map<string, string>();
  for (const id of [...world.raceIds()].sort()) {
    const r = world.race(id)!;
    if (r.getString('help_taxonomy') === race) subgroups.set(id, r.getString('plural_name') || id);
  }

  let text = '';
  if (raceDescription) text += raceDescription + '\n\n';
  const alignmentList = [...alignments].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (alignmentList.length > 0) {
    text += (alignmentList.length > 1 ? tw('Alignments: ') : tw('Alignment: ')) + alignmentList.join(', ') + '\n\n';
  }
  if (raceTaxonomy) {
    const parent = world.race(raceTaxonomy);
    text +=
      vgettext('wesnoth', "This is a group of units, all of whom are <ref dst='$topic_id'>$help_taxonomy</ref>.", {
        topic_id: '..race_' + raceTaxonomy,
        help_taxonomy: parent ? parent.getString('plural_name') : raceTaxonomy,
      }) + '\n\n';
  }
  if (subgroups.size > 0) {
    text += tag('header', raceTaxonomy ? tw('Subgroups of units within this group') : tw('Groups of units within this race')) + '\n';
    for (const [id, name] of subgroups) text += `${BULLET} ${makeLink(name, '..race_' + id)}\n`;
    text += '\n';
  }
  text += tag('header', raceTaxonomy ? tw('Units of this group') : tw('Units of this race')) + '\n';
  for (const u of stringSet(raceUnits)) text += `${BULLET} ${u}\n`;

  topics.push({ title: raceName, id: raceId, text });
  if (sortGenerated) topics.sort(titleLess);
  return topics;
}

/** `attack_type::accuracy_parry_description`. */
function accuracyParryDescription(accuracy: number, parry: number): string {
  if (accuracy === 0 && parry === 0) return '';
  const signed = (v: number) => (v >= 0 ? `+${v}%` : `${UNICODE_MINUS}${-v}%`);
  return signed(accuracy) + (parry !== 0 ? '/' + signed(parry) : '');
}

/** `unit_helper::resistance_color`. */
function resistanceColor(resistance: number): string {
  return hexColor(redToGreen(50 + (resistance * 5) / 6, false));
}

function hexColor(rgb: number): string {
  return '#' + rgb.toString(16).padStart(6, '0');
}

/** `format_mp_entry`: a movement (or vision/jamming) cost, coloured, with a hexagon per hex a turn allows. */
function formatMpEntry(cost: number, maxCost: number): string {
  let s = '';
  const cannot = cost < maxCost;
  const color = hexColor(redToGreen(100 - 25 * maxCost, true));
  if (cannot && maxCost > cost + 5) s += FIGURE_DASH;
  else if (cannot) s += `(${maxCost})`;
  else s += String(maxCost);
  if (maxCost !== 0) {
    const hexesPerTurn = Math.trunc(cost / maxCost);
    s += ' ';
    for (let i = 0; i < hexesPerTurn; i++) s += '\u2b23\u200b';
  }
  return spanColor(color, s);
}

/** `attack_type::special_tooltips()`: the weapon's named specials. */
function specialTooltips(specials: readonly WmlConfig[]): SpecialTooltip[] {
  return specials
    .filter((s) => s.getString('name') !== '')
    .map((s) => ({ name: s.getString('name'), description: s.getString('description'), helpTopicId: helpTopicIdOf(s) }));
}

/** The movetype with the `musthave` traits' unconditional effects applied, as the unit page shows it. */
function mustHaveMoveType(type: HelpUnitType): MoveType {
  let mt = type.moveType;
  if (type.possibleTraits.length === 0 || type.numTraits <= 0) return mt;
  const MOVETYPE_EFFECTS = ['movement_costs', 'vision_costs', 'jamming_costs', 'defense', 'resistance'];
  for (const trait of type.possibleTraits) {
    if (trait.getString('availability') !== 'musthave') continue;
    for (const effect of trait.children('effect')) {
      const applyTo = effect.getString('apply_to');
      if (effect.hasChild('filter') || !MOVETYPE_EFFECTS.includes(applyTo)) continue;
      const child = effect.child(applyTo);
      if (child) mt = mt.merge(applyTo, child, effect.getBoolean('replace', false));
    }
  }
  return mt;
}

/** Upstream `unit_topic_generator::operator()`: a unit type's (or one of its variations') page. */
export function unitTopicText(world: HelpWorld, type: HelpUnitType, variation: string): string {
  let ss = '';
  const female = type.female;
  const male = type.male;
  const screenWide = true; // `video::game_canvas_size().x >= 1200`: the help window is 1350 wide.

  ss += th('Level') + ' ' + type.level;

  const malePortrait = male.smallProfile || male.bigProfile;
  const femalePortrait = female.smallProfile || female.bigProfile;
  const hasMalePortrait = malePortrait !== '' && malePortrait !== male.image && malePortrait !== 'unit_image';
  const hasFemalePortrait =
    femalePortrait !== '' && femalePortrait !== malePortrait && femalePortrait !== female.image && femalePortrait !== 'unit_image';
  if (hasMalePortrait) ss += img(malePortrait + '~FL(horiz)', 'right', true);
  if (hasFemalePortrait) ss += img(femalePortrait + '~FL(horiz)', 'right', true);

  if (male.image) {
    ss += img(`${male.image}~RC(${male.flagRgb}>red)${screenWide ? '~SCALE_SHARP(200%,200%)' : ''}`);
    if (female.image && female.image !== male.image) {
      ss += img(`${female.image}~RC(${female.flagRgb}>red)${screenWide ? '~SCALE_SHARP(200%,200%)' : ''}`);
    }
  }
  ss += '\n';

  // Advances from, then to.
  if (variation === '') {
    for (const reverse of [true, false]) {
      const adv = reverse ? type.advancesFrom : type.advancesTo;
      let first = true;
      for (const id of adv) {
        const t = world.unitType(id);
        if (!t || t.hideHelp) continue;
        if (first) {
          ss += (reverse ? th('Advances from:') : th('Advances to:')) + NBSP;
          first = false;
        } else ss += ', ';
        let name = t.typeName;
        let refId: string;
        if (hasFullDescription(t)) refId = (t.showVariationsInHelp ? '..' : '') + UNIT_PREFIX + t.id;
        else {
          refId = UNKNOWN_UNIT_TOPIC;
          name += ' (?)';
        }
        ss += makeLink(name, refId);
      }
      if (!first) ss += '\n';
    }
  }

  const parent = variation === '' ? type : (world.unitType(type.id) ?? type);
  if (variation !== '') {
    ss += th('Base unit:') + NBSP + makeLink(parent.typeName, '..' + UNIT_PREFIX + type.id) + '\n';
  } else {
    let first = true;
    for (const baseId of type.cfg.getString('base_ids').split(',').map((s) => s.trim()).filter(Boolean)) {
      if (first) {
        ss += th('Base units:') + NBSP;
        first = false;
      }
      const baseType = world.unitType(baseId);
      if (!baseType) continue;
      ss += makeLink(baseType.typeName, (baseType.showVariationsInHelp ? '..' : '') + UNIT_PREFIX + baseId) + '\n';
    }
  }

  let firstVariation = true;
  for (const varId of parent.variations) {
    const vt = parent.variation(varId);
    if (vt.hideHelp) continue;
    if (firstVariation) {
      ss += th('Variations:') + NBSP;
      firstVariation = false;
    } else ss += ', ';
    let varName = vt.variationName;
    let refId: string;
    if (hasFullDescription(vt)) refId = VARIATION_PREFIX + vt.id + '_' + varId;
    else {
      refId = UNKNOWN_UNIT_TOPIC;
      varName += ' (?)';
    }
    ss += makeLink(varName, refId);
  }
  if (parent.variations.length > 0) ss += '\n';

  // Race.
  let raceName = world.racePluralName(type.raceId);
  if (!raceName) raceName = th('race^Miscellaneous');
  ss += th('Race:') + NBSP + makeLink(raceName, '..race_' + type.raceId) + '\n';

  // Traits.
  const traits = type.possibleTraits;
  if (traits.length > 0) {
    const mustHave: [string, string][] = [];
    const random: [string, string][] = [];
    let mustHaveNameless = 0;
    for (const trait of traits) {
      const maleName = trait.getString('male_name');
      const femaleName = trait.getString('female_name');
      let traitName: string;
      if (type.hasGenderVariation('male') && maleName) traitName = maleName;
      else if (type.hasGenderVariation('female') && femaleName) traitName = femaleName;
      else if (trait.getString('name')) traitName = trait.getString('name');
      else continue; // A hidden trait.
      if (traitName === '' && trait.getString('availability') === 'musthave') {
        mustHaveNameless++;
        continue;
      }
      (trait.getString('availability') === 'musthave' ? mustHave : random).push([traitName, 'traits_' + trait.getString('id')]);
    }
    const printList = (l: [string, string][]): string => l.map(([name, id]) => makeLink(name, id)).join(', ');
    const nrRandom = Math.min(type.numTraits - mustHave.length - mustHaveNameless, random.length);
    const randomOf = (n: number) => vngettext('(1 of):', '(random $number of):', n, { number: n });
    if (mustHave.length === 0) {
      if (nrRandom > 0) ss += th('Traits') + ' ' + randomOf(nrRandom) + NBSP + printList(random) + '\n';
    } else {
      ss += th('Traits');
      if (nrRandom > 0) {
        ss += `\n(${mustHave.length}):` + NBSP + printList(mustHave);
        ss += '\n' + randomOf(nrRandom) + NBSP + printList(random);
      } else {
        ss += ':' + NBSP + printList(mustHave);
      }
      ss += '\n';
    }
  }

  // Abilities, then the abilities the AMLAs add.
  const abilityLine = (label: string, list: { name: string; helpTopicId: string }[]): string => {
    let out = label + NBSP;
    let start = true;
    for (const ability of list) {
      if (!ability.name) continue;
      if (!start) out += ', ';
      else start = false;
      out += makeLink(ability.name, ABILITY_PREFIX + ability.helpTopicId);
    }
    return out + '\n\n';
  };
  if (type.abilitiesMetadata.length > 0) ss += abilityLine(th('Abilities:'), type.abilitiesMetadata);
  if (type.advAbilitiesMetadata.length > 0) ss += abilityLine(th('Ability Upgrades:'), type.advAbilitiesMetadata);

  // HP, moves...
  ss += th('HP:') + NBSP + type.hitpoints + '  ' + th('Moves:') + NBSP + type.movement + '  ';
  if (type.vision !== type.movement) ss += th('Vision:') + NBSP + type.vision + '  ';
  if (type.jamming > 0) ss += th('Jamming:') + NBSP + type.jamming + '  ';
  ss += th('Cost:') + NBSP + type.cost + '  ' + th('Alignment:') + NBSP + makeLink(alignmentDescription(type), 'time_of_day') + '  ';
  if (type.canAdvance || type.modificationAdvancements.length > 0) ss += th('Required XP:') /* a literal no-break space, as in the msgid */ + NBSP + type.experienceNeeded;

  ss += '\n' + (type.description || tw('No description available.')) /* `unit_description()`, units/types.cpp */;

  const notes = type.specialNotes;
  if (notes.length > 0) {
    ss += '\n' + tag('header', th('Special Notes')) + '\n';
    for (const note of notes) ss += `${BULLET} ${italic(note)}\n`;
  }

  // Attacks.
  ss += '\n' + tag('header', th('Attacks'));
  if (type.maxAttacks > 1) ss += '\n' + italic(th('Attacks per turn: ')) + type.maxAttacks;
  const attacks = type.unitType.attacks;
  if (attacks.length > 0) {
    const hasSpecial = attacks.some((a) => specialTooltips(a.specials).length > 0);
    let table = tagAttr(
      'row',
      { bgcolor: 'table_header' },
      tag('col', NBSP),
      tag('col', bold(th('Name'))),
      tag('col', bold(th('Strikes'))),
      tag('col', bold(th('Range'))),
      tag('col', bold(th('Type'))),
      hasSpecial ? tag('col', bold(th('Special'))) : '',
    );
    const attackCfgs = type.cfg.children('attack');
    attacks.forEach((attack, i) => {
      const cfg = attackCfgs[i];
      const icon = cfg?.getString('icon') || (attack.id ? `attacks/${attack.id}.png` : 'attacks/blank-attack.png');
      let row = tag('col', img(icon));
      row += tag('col', attack.name);
      const strikes = `${attack.damage}${WEAPON_NUMBERS_SEP}${attack.numAttacks} ${accuracyParryDescription(attack.accuracy, attack.parry)}`;
      if (type.maxAttacks > 1) {
        row += tag('col', strikes, '\n', vngettext('uses $num attack', 'uses $num attacks', attack.attacksUsed, { num: attack.attacksUsed }));
      } else row += tag('col', strikes);
      const rangeIcon = `icons/profiles/${attack.range}_attack.png~SCALE_INTO(16,16)`;
      const rangeName = world.string('range_' + attack.range);
      if (attack.minRange > 1 || attack.maxRange > 1) {
        row += tag('col', img(rangeIcon), ' ', attack.minRange, '-', attack.maxRange, ' ', rangeName);
      } else row += tag('col', img(rangeIcon), ' ', rangeName);
      const typeIcon = `icons/profiles/${attack.type}.png~SCALE_INTO(16,16)`;
      row += tag('col', img(typeIcon), ' ', world.string('type_' + attack.type));
      if (hasSpecial) {
        const specials = specialTooltips(attack.specials);
        row += tag(
          'col',
          specials.length > 0 ? specials.map((s) => makeLink(s.name, WEAPONSPECIAL_PREFIX + s.helpTopicId)).join(', ') : EM_DASH,
        );
      }
      table += tagAttr('row', { bgcolor: 'table_row1' }, row);
    });
    ss += tag('table', table);
  }

  const movementType = mustHaveMoveType(type);
  const indivisible = world.terrains.filter((t) => t.isIndivisible && t.isNonnull);
  // Upstream checks the encountered terrains; every terrain counts as encountered here.
  const hasDefenseCaps = world.terrains.some((t) => movementType.defenseCapped(t.code));
  const hasVision = type.moveType.hasVisionData();
  const hasJamming = type.moveType.hasJammingData();

  // Resistances.
  ss += '\n' + tag('header', th('Resistances'));
  let resTable = tagAttr('row', { bgcolor: 'table_header' }, tag('col', bold(th('Attack Type'))), tag('col', bold(th('Resistance'))));
  let odd = true;
  for (const [damageType, value] of damageTable(movementType)) {
    const resistance = 100 - value;
    const resist = `${resistance}%`.replace('-', UNICODE_MINUS);
    const typeIcon = `icons/profiles/${damageType}.png~SCALE_INTO(16,16)`;
    resTable += tagAttr(
      'row',
      { bgcolor: odd ? 'table_row1' : 'table_row2' },
      tag('col', img(typeIcon), ' ', world.string('type_' + damageType)),
      tag('col', spanColor(resistanceColor(resistance), resist)),
    );
    odd = !odd;
  }
  ss += tag('table', resTable);

  // Terrain modifiers.
  ss += '\n' + tag('header', th('Terrain Modifiers'));
  let header = tag('col', bold(th('Terrain'))) + tag('col', bold(th('Defense'))) + tag('col', bold(th('Movement Cost')));
  if (hasDefenseCaps) header += tag('col', bold(th('Defense Cap')));
  if (hasVision) header += tag('col', bold(th('Vision Cost')));
  if (hasJamming) header += tag('col', bold(th('Jamming Cost')));
  let terrainTable = tagAttr('row', { bgcolor: 'table_header' }, header);

  const offMap = parseTerrainList('_off^_usr,*^_fme');
  const rows: { name: string; id: string; defense: number; moves: number; vision: number; jamming: number; capped: boolean }[] = [];
  const seen = new Set<string>();
  for (const t of indivisible) {
    const code = t.code;
    if (code.equals(FOGGED) || code.equals(VOID_TERRAIN) || terrainMatches(code, offMap)) continue;
    const moves = movementType.movementCost(code);
    if (moves > type.movement && t.hideIfImpassable) continue;
    const row = {
      name: t.name,
      id: t.id,
      defense: 100 - movementType.defenseModifier(code),
      moves,
      vision: movementType.visionCost(code),
      jamming: movementType.jammingCost(code),
      capped: movementType.defenseCapped(code),
    };
    // A `std::set` ordered by name: one row per (collation-)distinct name.
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    rows.push(row);
  }
  rows.sort((a, b) => compareText(a.name, b.name));
  odd = true;
  for (const m of rows) {
    const image = `images/buttons/icon-base-16.png~RC(magenta>${m.id})~BLIT(icons/terrain/terrain_type_${m.id}.png)`;
    let row = tag('col', img(image), ' ', makeLink(m.name, '..terrain_' + m.id));
    const defColor = hexColor(redToGreen(m.defense, false));
    row += tag('col', spanColor(defColor, m.defense, '%'));
    row += tag('col', formatMpEntry(type.movement, m.moves));
    if (hasDefenseCaps) row += tag('col', m.capped ? spanColor(defColor, m.defense, '%') : spanColor('white', FIGURE_DASH));
    if (hasVision) row += tag('col', formatMpEntry(type.vision, m.vision));
    if (hasJamming) row += tag('col', formatMpEntry(type.jamming, m.jamming));
    terrainTable += tagAttr('row', { bgcolor: odd ? 'table_row1' : 'table_row2' }, row);
    odd = !odd;
  }
  ss += tag('table', terrainTable);
  return ss;
}

/** `movetype::damage_table()`: every damage type the movetype lists, by name, as `resistance_against` values. */
function damageTable(mt: MoveType): [string, number][] {
  return [...mt.resistances.damageTable()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
