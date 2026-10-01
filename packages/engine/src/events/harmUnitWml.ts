/**
 * Phase 28c: `[harm_unit]`, ported from `data/lua/wml/harm_unit.lua`: every unit matching `[filter]` takes
 * `amount=` damage, adjusted like an attack's by `alignment=` and the time of day where it stands, its
 * resistance to `damage_type=` and `resistance_multiplier=`; may be poisoned/slowed/petrified/made
 * unhealable; may die (`kill=no` leaves it at 1 HP); `[filter_second]`'s first unit is the harmer, which
 * can be animated attacking (`animate=yes|attacker`) while the victim is animated defending
 * (`yes|defender`), and whose side decides whether experience is handed out (`experience=`, a boolean or
 * a list of `kill`/`fight`/`attack`/`defend`). `$this_unit` is the unit being harmed while each one's
 * attributes are read. `variable=` receives `{id, harm_amount}` per unit.
 *
 * The red floating label (`wesnoth.interface.float_label`) shows the damage and the statuses given; the
 * status sounds are played when animated, as upstream.
 */

import type { EventContext } from './context.js';
import { TString } from '../i18n/tstring.js';
import { WmlConfig } from '../wml/config.js';
import { isFlow, type Flow } from './interaction.js';
import { findUnits } from './filter.js';
import { UnitStatus, type Unit } from '../model/Unit.js';
import { effectiveTimeOfDayAt } from '../actions/illumination.js';
import { KILL_EXPERIENCE, COMBAT_EXPERIENCE } from '../actions/gameConfig.js';

/** Runs a native action (as `wml_actions.X{...}` from Lua would), waiting for it if it has to. */
function* runNative(tag: string, cfg: WmlConfig, ctx: EventContext): Flow {
  const handler = ctx.registry.get(tag);
  if (!handler) return;
  const result = handler(cfg, ctx);
  if (isFlow(result)) yield* result;
}

function tag(name: string, attrs: Record<string, string | number | boolean>, children: [string, WmlConfig | undefined][] = []): WmlConfig {
  const cfg = new WmlConfig();
  for (const [k, v] of Object.entries(attrs)) cfg.setAttribute(k, v);
  for (const [childTag, child] of children) if (child) cfg.addChild(childTag, child);
  return cfg;
}

/** `harm_unit.lua`'s own `round_damage` (not quite the C++ one: `bonus < divisor`, and Lua's floor). */
function roundDamageLua(base: number, bonus: number, divisor: number): number {
  if (base === 0) return 0;
  const rounding = bonus < divisor || divisor === 1 ? divisor / 2 : divisor / 2 - 1;
  return Math.max(1, Math.floor((base * bonus + rounding) / divisor));
}

function calculateDamage(base: number, alignment: string, todBonus: number, resistance: number, modifier: number, liminalBonus: number): number {
  let multiplier = 100;
  if (alignment === 'lawful') multiplier += todBonus;
  else if (alignment === 'chaotic') multiplier -= todBonus;
  else if (alignment === 'liminal') multiplier += Math.max(0, liminalBonus - Math.abs(todBonus));
  multiplier *= resistance * modifier;
  return roundDamageLua(base, multiplier, 10000);
}

/** A WML value the Lua reads as a truthy/falsy attribute: `nil` and `false` are false, anything else true. */
function truthy(cfg: WmlConfig, key: string): boolean {
  const raw = cfg.getRaw(key);
  if (raw === undefined || raw === false) return false;
  return !(typeof raw === 'string' && (raw === 'no' || raw === 'false'));
}

/** The statuses `[harm_unit]` can give, with the label's words for them (`wesnoth` domain, as `harm_unit.lua`). */
const STATUSES: readonly { name: string; status: string; sound?: string; male: string; female: string }[] = [
  { name: 'poisoned', status: UnitStatus.Poisoned, sound: 'poison.ogg', male: 'poisoned', female: 'female^poisoned' },
  { name: 'slowed', status: UnitStatus.Slowed, sound: 'slowed.wav', male: 'slowed', female: 'female^slowed' },
  { name: 'petrified', status: UnitStatus.Petrified, sound: 'petrified.ogg', male: 'petrified', female: 'female^petrified' },
  { name: 'unhealable', status: UnitStatus.Unhealable, male: 'unhealable', female: 'female^unhealable' },
];

/** `float_label(..., "<span foreground='red'>%s</span>")`'s colour. */
const HARM_LABEL_COLOR = { r: 255, g: 0, b: 0 };

export function* actionHarmUnit(raw: WmlConfig, ctx: EventContext): Flow {
  const filterRaw = raw.child('filter');
  if (!filterRaw) {
    ctx.log('error', '[harm_unit] missing required [filter] tag');
    return;
  }
  if (!raw.hasAttribute('amount')) {
    ctx.log('error', '[harm_unit] has missing required amount= attribute');
    return;
  }
  const variable = ctx.variables.expandConfig(raw).getString('variable', '');
  // utils.scoped_var("this_unit"): its value is restored afterwards.
  const savedThisUnit = ctx.variables.getConfig('this_unit');
  const savedThisUnitRaw = ctx.variables.getRaw('this_unit');
  const board = ctx.board;
  const turn = ctx.turnNumber?.() ?? ctx.variables.getNumber('turn_number', 1);
  try {
    const targets = findUnits(board, ctx.variables.expandConfigDeep(filterRaw));
    for (const [index, victim] of targets.entries()) {
      if (board.unitAt(victim.location) !== victim) continue;
      ctx.variables.clear('this_unit');
      ctx.variables.setConfig('this_unit', victim.toConfig());
      // The rest is read with $this_unit set, as upstream's vconfig reads it lazily.
      const cfg = ctx.variables.expandConfig(raw);
      const amount = Number(cfg.getString('amount'));
      const animateValue = cfg.getRaw('animate');
      const animate = truthy(cfg, 'animate');
      const animateAs = typeof animateValue === 'string' ? animateValue : '';
      const delay = cfg.getNumber('delay', 500);
      const kill = cfg.getRaw('kill');
      const fireEvent = cfg.getRaw('fire_event');
      const primaryAttack = cfg.child('primary_attack');
      const secondaryAttack = cfg.child('secondary_attack');
      const harmerFilter = cfg.child('filter_second');
      const experience = cfg.getRaw('experience');
      const resistanceMultiplier = Number(cfg.getString('resistance_multiplier', '')) || 1;
      let harmer: Unit | undefined;
      if (harmerFilter) harmer = findUnits(board, ctx.variables.expandConfigDeep(harmerFilter))[0];
      const harmerValid = (): boolean => !!harmer && board.unitAt(harmer.location) === harmer;

      if (animate) {
        if (animateAs !== 'defender' && harmer && harmerValid()) {
          yield* runNative('scroll_to', tag('scroll_to', { x: harmer.location.wmlX, y: harmer.location.wmlY, check_fogged: true }), ctx);
          yield* runNative(
            'animate_unit',
            tag('animate_unit', { flag: 'attack', hits: true, with_bars: true }, [
              ['filter', tag('filter', { id: harmer.id })],
              ['primary_attack', primaryAttack],
              ['secondary_attack', secondaryAttack],
              ['facing', tag('facing', { x: victim.location.wmlX, y: victim.location.wmlY })],
            ]),
            ctx,
          );
        }
        yield* runNative('scroll_to', tag('scroll_to', { x: victim.location.wmlX, y: victim.location.wmlY, check_fogged: true }), ctx);
      }

      const tod = effectiveTimeOfDayAt(board, ctx.schedule, turn, victim.location);
      let damage = calculateDamage(
        amount,
        cfg.getString('alignment', 'neutral'),
        tod.lawfulBonus,
        victim.resistanceAgainst(cfg.getString('damage_type', 'dummy')),
        resistanceMultiplier,
        ctx.schedule.maxLiminalBonus,
      );
      if (victim.hitpoints <= damage) damage = kill === false ? victim.hitpoints - 1 : victim.hitpoints;
      victim.hitpoints -= damage;

      // The floating label: the damage, then each status given, a line each (`female^` forms for women).
      const labelParts: (string | { domain: string; msgid: string })[] = [`${damage}\n`];
      let addTab = false;
      for (const { name, status, sound, male, female } of STATUSES) {
        if (name === 'poisoned' && victim.hasStatus('unpoisonable')) continue;
        if (!truthy(cfg, name) || victim.hasStatus(status)) continue;
        labelParts.push({ domain: 'wesnoth', msgid: victim.gender === 'female' ? female : male }, '\n');
        victim.setStatus(status, true);
        addTab = true;
        if (animate && sound) ctx.playSound({ files: sound, repeats: 0, group: 'sound' });
      }
      if (addTab) labelParts.unshift('\t');

      if (animate && animateAs !== 'attacker') {
        yield* runNative(
          'animate_unit',
          tag('animate_unit', { flag: 'defend', hits: true, with_bars: true }, [
            ['filter', tag('filter', { id: victim.id })],
            ['primary_attack', secondaryAttack],
            ['secondary_attack', primaryAttack],
            ['facing', harmer && harmerValid() ? tag('facing', { x: harmer.location.wmlX, y: harmer.location.wmlY }) : undefined],
          ]),
          ctx,
        );
      }

      ctx.floatLabel?.({ kind: 'hex', loc: victim.location, text: TString.fromParts(labelParts), color: HARM_LABEL_COLOR });

      // experience=: a boolean or a list of kill/fight/attack/defend (default: all of them).
      const xp = { kill: false, attack: false, defend: false };
      const options = experience === undefined ? [] : String(experience === true ? 'yes' : experience === false ? 'no' : experience).split(',').map((s) => s.trim()).filter((s) => s !== '');
      for (const opt of options) {
        if (opt === 'true' || opt === 'yes' || opt === 'nil') Object.assign(xp, { kill: true, attack: true, defend: true });
        else if (opt === 'fight') Object.assign(xp, { attack: true, defend: true });
        else if (opt === 'attack') xp.attack = true;
        else if (opt === 'defend') xp.defend = true;
        else if (opt === 'kill') xp.kill = true;
        else if (!(opt === 'no' || opt === 'false')) {
          ctx.log('error', 'Invalid [harm_unit] experience: should be boolean or a list of one or more of the following: kill, fight, attack, defend');
        }
      }
      if (options.length === 0) Object.assign(xp, { kill: true, attack: true, defend: true });
      const killXp = (level: number) => (level === 0 ? Math.ceil(KILL_EXPERIENCE / 2) : level * KILL_EXPERIENCE);

      const victimTeam = board.getTeam(victim.side);
      const harmerTeam = harmer ? board.getTeam(harmer.side) : undefined;
      if (harmer && harmerValid() && victimTeam && harmerTeam && victimTeam.isEnemy(harmerTeam)) {
        if (victim.hitpoints <= 0) {
          if (xp.kill) harmer.experience += killXp(victim.level);
          else if (xp.attack) harmer.experience += COMBAT_EXPERIENCE * victim.level;
        } else {
          if (xp.defend) victim.experience += COMBAT_EXPERIENCE * harmer.level;
          if (xp.attack) harmer.experience += COMBAT_EXPERIENCE * victim.level;
        }
      }

      const victimId = victim.id;
      if (kill !== false && victim.hitpoints <= 0) {
        const killCfg = tag('kill', { id: victim.id, animate });
        if (fireEvent !== undefined) killCfg.setAttribute('fire_event', fireEvent);
        if (harmer) killCfg.addChild('secondary_unit', tag('secondary_unit', { id: harmer.id }));
        yield* runNative('kill', killCfg, ctx);
      }

      if (animate) yield* runNative('delay', tag('delay', { time: delay }), ctx);

      if (variable !== '') ctx.variables.setConfig(`${variable}[${index}]`, tag('harmed', { id: victimId, harm_amount: damage }));

      if (xp.defend && board.unitAt(victim.location) === victim) ctx.advanceUnit?.(victim);
      if ((xp.attack || xp.kill) && harmer && harmerValid()) ctx.advanceUnit?.(harmer);
    }
  } finally {
    ctx.variables.clear('this_unit');
    if (savedThisUnit) ctx.variables.setConfig('this_unit', savedThisUnit);
    else if (savedThisUnitRaw !== undefined) ctx.variables.set('this_unit', savedThisUnitRaw);
  }
}
