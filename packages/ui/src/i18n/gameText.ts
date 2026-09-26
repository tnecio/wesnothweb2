/**
 * Player-facing names for the fixed vocabulary of the rules -- races,
 * alignments, damage types, attack ranges and unit statuses -- each looked
 * up under upstream's own msgid (`race^Human` in `wesnoth-help`, `lawful`,
 * `blade`, `melee`, `poisoned` in `wesnoth`), so every language already
 * translated them. A table of explicit calls, not a computed lookup, so the
 * audit test can see every msgid.
 */

import { th, tw } from './locale.js';

const RACES: Readonly<Record<string, () => string>> = {
  human: () => th('race^Human'),
  elf: () => th('race^Elf'),
  orc: () => th('race^Orc'),
  orcish: () => th('race^Orc'),
  undead: () => th('race^Undead'),
  dwarf: () => th('race^Dwarf'),
  merman: () => th('race^Merfolk'),
  drake: () => th('race^Drake'),
  troll: () => th('race^Troll'),
  goblin: () => th('race^Goblin'),
  naga: () => th('race^Naga'),
  monster: () => th('race^Monster'),
  wose: () => th('race^Wose'),
  bats: () => th('race^Bat'),
  wolf: () => th('race^Wolf'),
  gryphon: () => th('race^Gryphon'),
  mechanical: () => th('race^Mechanical'),
  ogre: () => th('race^Ogre'),
  raven: () => th('race^Raven'),
  khalifate: () => th('race^Dunefolk Human'),
  falcon: () => th('race^Falcon'),
  horse: () => th('race^Horse'),
  lizard: () => th('race^Saurian'),
  cat: () => th('race^Cat'),
  ship: () => th('race^Ship'),
};

const ALIGNMENTS: Readonly<Record<string, () => string>> = {
  lawful: () => tw('lawful'),
  neutral: () => tw('neutral'),
  chaotic: () => tw('chaotic'),
  liminal: () => tw('liminal'),
};

const DAMAGE_TYPES: Readonly<Record<string, () => string>> = {
  blade: () => tw('blade'),
  pierce: () => tw('pierce'),
  impact: () => tw('impact'),
  fire: () => tw('fire'),
  cold: () => tw('cold'),
  arcane: () => tw('arcane'),
};

const RANGES: Readonly<Record<string, () => string>> = {
  melee: () => tw('melee'),
  ranged: () => tw('ranged'),
};

const STATUSES: Readonly<Record<string, () => string>> = {
  slowed: () => tw('slowed'),
  poisoned: () => tw('poisoned'),
  petrified: () => tw('petrified'),
};

function capitalizeId(id: string): string {
  return id.length > 0 ? id[0]!.toUpperCase() + id.slice(1) : id;
}

/** First letter upper-cased: the side panel's style (`lawful` -> `Lawful`); scripts without case are unchanged. */
export function capitalizeFirst(text: string): string {
  return text.length > 0 ? text[0]!.toLocaleUpperCase() + text.slice(1) : text;
}

/** A race's display name (`human` -> "Human", or the language's word for it). */
export function raceName(raceId: string): string {
  return RACES[raceId]?.() ?? capitalizeId(raceId);
}

export function alignmentName(alignment: string): string {
  return ALIGNMENTS[alignment]?.() ?? alignment;
}

export function damageTypeName(type: string): string {
  return DAMAGE_TYPES[type]?.() ?? type;
}

/** `melee`/`ranged`; a custom `range=` some content defines is shown as written. */
export function rangeName(range: string): string {
  return RANGES[range]?.() ?? range;
}

/** A status as a badge label (`poisoned` -> "Poisoned"; upstream's own msgid is lower-case). */
export function statusName(status: string): string {
  const name = STATUSES[status]?.();
  return name === undefined ? status : capitalizeFirst(name);
}
