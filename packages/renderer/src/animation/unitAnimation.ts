/**
 * TS port of `units/animation.hpp`/`.cpp`'s WML parsing and matching logic:
 * given a unit type's raw `[unit_type]` config, extract its declared
 * `[standing_anim]`/`[attack_anim]`/`[defend]`/`[death]`/`[movement_anim]`/
 * etc. blocks into a queryable list (`parseUnitAnimations`, mirroring
 * `fill_initial_animations`/`add_anims`), and score/select among them for a
 * given `AnimationContext` (`matchAnimation`/`selectTopAnimations`,
 * mirroring `unit_animation::matches_headless` and
 * `unit_animation_component::choose_animation`'s max-score-with-random-tie
 * -break).
 *
 * `UnitType.ts`'s own module doc comment explicitly excludes animation
 * config from what it parses ("out of scope there") — this module parses
 * `[*_anim]` blocks straight from the original `WmlConfig` a unit type was
 * built from, which is why every entry point here takes a `WmlConfig`
 * rather than a `UnitType`.
 *
 * Scope notes (see the Phase 4 task description for the full rationale):
 *  - The `[if]`/`[else]` "animation branch" expansion
 *    (`expandAnimationBranches`, porting `animation_cursor`/
 *    `prepare_single_animation` in animation.cpp) is real and load-bearing:
 *    upstream's `DEFENSE_ANIM_RANGE`/`SOUND:HIT_AND_MISS` macros — used by
 *    real content (e.g. Elvish Fighter) — rely on it to split one authored
 *    `[defend]`/`[attack_anim]` block into several `hits=`-filtered
 *    variants with a shared frame sequence.
 *  - `fill_initial_animations`'s large synthesis of implicit
 *    `_ghosted_`/`selected`/`recruited`/`levelin`/etc. animations, and its
 *    per-event *fallback* derivation from `[standing_anim]` when a unit
 *    type authors no explicit `attack`/`defend`/`movement`/`death`
 *    animation, is **not** ported — only the "no `[standing_anim]` at all"
 *    fallback (a trivial 1-frame `image=` default, `DEFAULT_ANIM` score)
 *    is. Real content that relies on the richer fallback chain (a unit
 *    type with, say, `[attack_anim]` but no `[movement_anim]`) will
 *    currently fail to match a movement animation rather than silently
 *    reusing standing — flagged rather than silently wrong.
 *  - **`add_anims`' `offset=` defaulting for `movement`/`attack` IS
 *    ported** (2026-09-11, `withDefaultOffset`/`MOVEMENT_DEFAULT_OFFSET`/
 *    `ATTACK_DEFAULT_OFFSET`): most real `[movement_anim]` blocks declare
 *    no `offset=` at all (e.g. Elvish Fighter's is a bare walk-cycle
 *    `[frame]`), relying entirely on this engine-injected default to
 *    actually slide the sprite toward its destination hex — without it,
 *    `playback.ts`'s `sampleAnimation` would have nothing to interpolate
 *    and a "moving" unit would just cycle its walk frames in place. Real
 *    upstream default strings, copied verbatim (a repeating 0→1 ramp
 *    every 200ms for movement; `0~0.6,0.6~0` for a melee attack lunge
 *    with no `[missile_frame]`), applied only when the author's own
 *    branch doesn't already set `offset=`.
 *  - Unit filters (`[filter]`/`[filter_second]`) are evaluated via the
 *    already-real, already-tested `unitMatchesFilter` from
 *    `packages/engine/src/events/filter.ts` (id/type/side/x/y/formula=,
 *    `[and]`/`[or]`/`[not]`) — see that module's own doc comment for what
 *    it does not cover (`race=`, `ability=`, etc.), which applies here too.
 *  - `frequency_`'s random rejection (`matches_headless`, animation.cpp
 *    ~L459-461) is only applied when an `Rng`-like `getRandomInt` is passed
 *    in `MatchOptions` — omit it for deterministic headless
 *    matching/testing, matching every other "no rng supplied" default in
 *    this port.
 */

import { Direction, parseDirection } from '@wesnothweb2/engine/src/model/Location.js';
import { parseTerrainList, terrainMatches, type TerrainCode } from '@wesnothweb2/engine/src/model/Terrain.js';
import type { AttackType } from '@wesnothweb2/engine/src/model/UnitType.js';
import { unitMatchesFilter } from '@wesnothweb2/engine/src/events/filter.js';
import { WmlConfig, type WmlAttributeValue } from '@wesnothweb2/engine/src/wml/config.js';

import type { AnimationContext, StrikeResult } from './animationContext.js';
import { buildFrameFields, parseDurationMs, parseFrame, type UnitFrameDef } from './frame.js';

/** Mirrors `unit_animation::MATCH_FAIL`/`DEFAULT_ANIM` (animation.hpp). */
export const MATCH_FAIL = -10;
export const DEFAULT_ANIM = -9;

// ── [if]/[else] animation-branch expansion ──────────────────────────────────

/** One expanded variant of an anim block: its own attribute overrides plus the (frame/filter/...) children visible to it. */
export interface AnimBranch {
  readonly attrs: Map<string, WmlAttributeValue>;
  readonly children: ReadonlyArray<{ tag: string; config: WmlConfig }>;
}

function cloneAttrs(cfg: WmlConfig): Map<string, WmlAttributeValue> {
  const m = new Map<string, WmlAttributeValue>();
  for (const key of cfg.attributeNames()) m.set(key, cfg.get(key)!);
  return m;
}

/**
 * TS port of `prepare_single_animation`/`animation_cursor` (animation.cpp
 * ~L61-243): expands one anim tag's `[if]`/`[else]` children into the set
 * of concrete branches it represents. A lone `[if]` (no `[else]`) yields
 * *both* the unbranched original and the if-branch (matching upstream:
 * `count > 1` — an `[else]` present — is what makes the branches mutually
 * exclusive; a bare `[if]` is additive, not conditional-in-the-usual-sense).
 */
export function expandAnimationBranches(cfg: WmlConfig): AnimBranch[] {
  let branches: AnimBranch[] = [{ attrs: cloneAttrs(cfg), children: [] }];
  const items = cfg.allChildren();
  let i = 0;

  while (i < items.length) {
    const item = items[i]!;
    if (item.tag !== 'if') {
      for (const b of branches) (b.children as Array<{ tag: string; config: WmlConfig }>).push(item);
      i++;
      continue;
    }

    const clauseCfgs: WmlConfig[] = [item.config];
    i++;
    while (i < items.length && items[i]!.tag === 'else') {
      clauseCfgs.push(items[i]!.config);
      i++;
    }

    const baseBranches = branches;
    const newBranches: AnimBranch[] = [];
    for (const clauseCfg of clauseCfgs) {
      for (const sub of expandAnimationBranches(clauseCfg)) {
        for (const base of baseBranches) {
          const attrs = new Map(base.attrs);
          for (const [k, v] of sub.attrs) attrs.set(k, v);
          newBranches.push({ attrs, children: [...base.children, ...sub.children] });
        }
      }
    }

    branches = clauseCfgs.length > 1 ? newBranches : [...baseBranches, ...newBranches];
  }

  return branches;
}

// ── branch attribute accessors (mirrors WmlConfig's own get*/hasAttribute) ──

function battr(branch: AnimBranch, key: string): WmlAttributeValue | undefined {
  return branch.attrs.get(key);
}
function bhas(branch: AnimBranch, key: string): boolean {
  return branch.attrs.has(key);
}
function bstr(branch: AnimBranch, key: string, fallback = ''): string {
  const v = battr(branch, key);
  return v === undefined ? fallback : String(v);
}
function bnum(branch: AnimBranch, key: string, fallback = 0): number {
  const v = battr(branch, key);
  if (v === undefined) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isNaN(n) ? fallback : n;
}
function bchildren(branch: AnimBranch, tag: string): WmlConfig[] {
  return branch.children.filter((c) => c.tag === tag).map((c) => c.config);
}
/**
 * Reads the `hits=` attribute as a string, undoing the WML parser's own
 * `yes`/`no` -> boolean coercion (`wml/parser.ts` ~L43-44) — WML content
 * overwhelmingly writes `hits=yes`/`hits=no` (see `SOUND:HIT_AND_MISS`),
 * which `WmlConfig` stores as a real boolean, not the strings
 * `parseHitsList` needs to see.
 */
function bhits(branch: AnimBranch): string {
  const v = battr(branch, 'hits');
  if (v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

function splitList(s: string): string[] {
  return s.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
}
function parseIntList(s: string): number[] {
  return splitList(s).map((x) => {
    const n = parseInt(x, 10);
    return Number.isFinite(n) ? n : 0;
  });
}
/** Mirrors the `hits_` parsing loop in `unit_animation`'s config constructor (animation.cpp ~L350-362): "yes" means hit-or-kill, "no" means miss. */
function parseHitsList(s: string): StrikeResult[] {
  const out: StrikeResult[] = [];
  for (const h of splitList(s)) {
    if (h === 'yes' || h === 'hit') out.push('hit');
    if (h === 'no' || h === 'miss') out.push('miss');
    if (h === 'yes' || h === 'kill') out.push('kill');
  }
  return out;
}

// ── UnitAnimationDef ─────────────────────────────────────────────────────────

/**
 * One `unit_animation::particle` other than the unit's own: every child tag
 * of an animation block ending in `_frame` besides `[frame]` itself --
 * `[missile_frame]` for a projectile, or any author-named family (e.g.
 * `[halo1_frame]`) carrying spell glows and impact flares (animation.cpp
 * ~L303-317). Each runs its own frame sequence on the animation's clock,
 * from `startTimeMs`, drawn at its own `offset=` between the unit's hex
 * and the target's.
 */
export interface ParticleDef {
  /** The tag's prefix: `missile_` for `[missile_frame]`. Also the prefix of its animation-wide attributes (`missile_offset=`). */
  readonly prefix: string;
  readonly frames: readonly UnitFrameDef[];
  /** `<prefix>start_time=`, else the smallest `begin=` among its frames (`particle::particle`, animation.cpp ~L955-964). */
  readonly startTimeMs: number;
  /** Animation-wide fallbacks read with the prefix (`frame_builder(cfg, prefix)`), sampled over the particle's whole duration. */
  readonly params: UnitFrameDef;
  /** `<prefix>cycles=`: loops for as long as the animation runs. */
  readonly cycles: boolean;
}

/** `particle::particle`'s start time: `<prefix>start_time=` if set, else the smallest `begin=` (missing counts as 0) among the frames; 0 when there are none. */
function particleStartTime(branch: AnimBranch, prefix: string, frames: readonly WmlConfig[]): number {
  if (frames.length > 0 && !bhas(branch, prefix + 'start_time')) {
    return Math.min(...frames.map((f) => parseDurationMs(f.getString('begin', '0'))));
  }
  return parseDurationMs(bstr(branch, prefix + 'start_time', '0'));
}

/** One parsed `unit_animation` candidate: its match filters plus its extracted frame data. */
export interface UnitAnimationDef {
  /** Mirrors `event_` (the `apply_to=` list) — usually one event, but a generic `[animation]` block may declare several. */
  readonly events: readonly string[];
  readonly baseScore: number;
  readonly terrainTypes: readonly TerrainCode[];
  readonly directions: readonly Direction[];
  readonly value: readonly number[];
  readonly hits: readonly StrikeResult[];
  readonly value2: readonly number[];
  readonly unitFilters: readonly WmlConfig[];
  readonly secondaryUnitFilters: readonly WmlConfig[];
  readonly primaryAttackFilters: readonly WmlConfig[];
  readonly secondaryAttackFilters: readonly WmlConfig[];
  readonly frequency: number;
  readonly frames: readonly UnitFrameDef[];
  /** When `frames` starts on the animation clock (`particleStartTime` for `[frame]`); hits land at 0, so attack animations typically start negative. */
  readonly startTimeMs: number;
  readonly missileFrames: readonly UnitFrameDef[];
  /** Every non-`[frame]` particle, `[missile_frame]` included -- see `ParticleDef`. */
  readonly particles: readonly ParticleDef[];
  /**
   * The animation-*wide* fallback parameters (`particle::parameters_`,
   * animation.cpp ~L972) — e.g. Elvish Fighter's sword `[attack_anim]` sets
   * `offset=0.0:125,0.0~0.6:150,0.6~0.0:180` as a top-level attribute of
   * the `[attack_anim]` block itself, not on any individual `[frame]`; this
   * is exactly the attack-lunge curve, and it lives here, not in
   * `frames[i].offset` (which is typically empty when authored this way).
   * A renderer samples this at elapsed-time-since-animation-start when the
   * current frame doesn't specify its own value for a given field (mirrors
   * `unit_frame::merge_parameters`'s "frame value wins if present, else the
   * animation-wide one" rule — that merge itself isn't performed here, see
   * module doc comment on what's data-extraction vs. rendering).
   */
  readonly animationParams: UnitFrameDef;
  /**
   * True only for a `[movement_anim]` branch that declared no `offset=`
   * of its own and so got the engine-injected `MOVEMENT_DEFAULT_OFFSET`
   * fallback (see that constant's own doc comment). `playback.ts`'s
   * multi-hex grouping (real, reported bug: "the move animation between
   * adjacent hexes plays twice") only merges consecutive same-direction
   * legs into one continuous playback when this is true — the default
   * offset's ramp REPEATS every 200ms specifically so each repeat can
   * line up with one hex of a reused animation instance (see
   * `MOVEMENT_DEFAULT_OFFSET`'s doc comment); an author-authored custom
   * `offset=` has no such guaranteed periodicity, so grouping it the same
   * way would be a guess, not a port of a real mechanism.
   */
  readonly usesDefaultMovementOffset: boolean;
}

function buildAnimationDef(branch: AnimBranch, events: readonly string[], baseScoreDelta = 0): UnitAnimationDef {
  const frameCfgs = bchildren(branch, 'frame');
  const frames = frameCfgs.map(parseFrame);
  const totalDurationMs = Math.max(1, frames.reduce((sum, f) => sum + f.durationMs, 0));
  const branchCfg = new WmlConfig();
  for (const [key, value] of branch.attrs) branchCfg.setAttribute(key, value);

  const particleTags = [...new Set(branch.children.map((c) => c.tag))].filter((tag) => tag !== 'frame' && tag.endsWith('_frame'));
  const particles = particleTags.map((tag): ParticleDef => {
    const prefix = tag.slice(0, -'frame'.length);
    const cfgs = bchildren(branch, tag);
    const particleFrames = cfgs.map(parseFrame);
    const durationMs = Math.max(1, particleFrames.reduce((sum, f) => sum + f.durationMs, 0));
    return {
      prefix,
      frames: particleFrames,
      startTimeMs: particleStartTime(branch, prefix, cfgs),
      params: buildFrameFields(branchCfg, durationMs, prefix),
      cycles: branchCfg.getBoolean(prefix + 'cycles', false),
    };
  });

  return {
    events,
    baseScore: bnum(branch, 'base_score', 0) + baseScoreDelta,
    terrainTypes: parseTerrainList(bstr(branch, 'terrain_type', '')),
    directions: splitList(bstr(branch, 'direction', '')).map(parseDirection),
    value: parseIntList(bstr(branch, 'value', '')),
    hits: parseHitsList(bhits(branch)),
    value2: parseIntList(bstr(branch, 'value_second', '')),
    unitFilters: bchildren(branch, 'filter'),
    secondaryUnitFilters: bchildren(branch, 'filter_second'),
    primaryAttackFilters: bchildren(branch, 'filter_attack'),
    secondaryAttackFilters: bchildren(branch, 'filter_second_attack'),
    frequency: bnum(branch, 'frequency', 0),
    frames,
    startTimeMs: particleStartTime(branch, '', frameCfgs),
    missileFrames: bchildren(branch, 'missile_frame').map(parseFrame),
    particles,
    animationParams: buildFrameFields(branchCfg, totalDurationMs),
    usesDefaultMovementOffset: false,
  };
}

/**
 * The real, unconditional 225ms red hit-flash `add_anims` appends to the
 * END of ANY `[defend]` animation whose `hits=` includes `hit`/`kill`
 * (animation.cpp ~L790-820: `animations.back().add_frame(225ms,
 * frame_builder().image(...).duration(225ms).blend("0.0,0.5:75,0.0:75,
 * 0.5:75,0.0", {255,0,0}))`) -- applied whether the block came from the
 * "author didn't set hits=" auto-split OR an explicit `hits=hit`/`kill`/
 * `yes` (e.g. via `DEFENSE_ANIM_FILTERED`'s `[if] hits=hit`), REGARDLESS
 * of whether the unit's own WML mentions blend at all. This is NOT the
 * same thing as `parseUnitAnimations`' separate low-priority "no
 * [defend] at all" fallback below -- THIS is why real Bandit (plain
 * `DEFENSE_ANIM`, no explicit `hits=`) and real Spearman
 * (`DEFENSE_ANIM_FILTERED`, explicit `hits=hit`) both flash red on a
 * landed hit despite neither macro mentioning a blend anywhere in its
 * own WML text -- a real, previously-missed gap (this project first
 * built a *different*, lower-priority fallback for the "no [defend] at
 * all" case, then found -- from a real screenshot of Bandit flashing
 * red -- that the actual, far more common mechanism is this unconditional
 * per-animation append, not a competing candidate). The extra frame
 * reuses whatever image the animation's own last frame ends on (`image_
 * loc = animations.back().get_last_frame().end_parameters().image`).
 */
function appendHitFlash(def: UnitAnimationDef): UnitAnimationDef {
  if (!def.hits.includes('hit') && !def.hits.includes('kill')) return def;
  const lastFrame = def.frames[def.frames.length - 1];
  const lastImage = lastFrame?.image[lastFrame.image.length - 1]?.value ?? '';
  const flashCfg = new WmlConfig();
  flashCfg.setAttribute('image', `${lastImage}:225`);
  flashCfg.setAttribute('blend_ratio', '0.0,0.5:75,0.0:75,0.5:75,0.0');
  flashCfg.setAttribute('blend_color', '255,0,0');
  return { ...def, frames: [...def.frames, buildFrameFields(flashCfg, 225)] };
}

/**
 * `[defend]`'s hits-based auto-split (animation.cpp `add_anims`
 * ~L778-820): when the author didn't set `hits=` explicitly, the block is
 * split into a "miss" and a "hit-or-kill" variant, each penalised by -1 so
 * an author-authored `hits=`-filtered variant (e.g. via
 * `DEFENSE_ANIM_RANGE`'s `[if] hits=hit`) outscores the auto-generated
 * default when both match. When the author DID set `hits=` (a
 * comma-separated list), one `unit_animation` is emitted per listed value
 * (mirrors `utils::split(anim["hits"])`'s loop), with no penalty. Either
 * way, a resulting hit/kill variant gets the real hit-flash appended --
 * see `appendHitFlash`'s own doc comment.
 */
function buildDefendAnimations(branch: AnimBranch): UnitAnimationDef[] {
  if (!bhas(branch, 'value') && bhas(branch, 'damage')) {
    branch = { attrs: new Map(branch.attrs).set('value', battr(branch, 'damage')!), children: branch.children };
  }

  const hitsRaw = bhits(branch);
  if (hitsRaw === '') {
    const withHits = (hits: string): AnimBranch => ({ attrs: new Map(branch.attrs).set('hits', hits), children: branch.children });
    return [
      buildAnimationDef(withHits('no'), ['defend'], -1),
      appendHitFlash(buildAnimationDef(withHits('yes'), ['defend'], -1)),
    ];
  }

  return splitList(hitsRaw).map((hitType) => {
    const b: AnimBranch = { attrs: new Map(branch.attrs).set('hits', hitType), children: branch.children };
    return appendHitFlash(buildAnimationDef(b, ['defend']));
  });
}

/**
 * `add_anims`' own `offset=` defaulting for `[movement_anim]`
 * (animation.cpp ~L765-766) when an author doesn't declare one --
 * real mainline content very often doesn't (e.g. Elvish Fighter's
 * `movement_anim` is just a bare walk-cycle `[frame]`, no `offset=` at
 * all): without this, `sampleAnimation`'s offset-interpolation would
 * have nothing to sample and the sprite would never actually slide
 * toward its destination hex, no matter how real the frame/image data
 * is. A repeating 0->1 ramp every 200ms (not a single smooth 0->1 over
 * the whole animation) -- copied verbatim, not reinterpreted, since this
 * is upstream's own literal default string.
 */
const MOVEMENT_DEFAULT_OFFSET = Array(34).fill('0~1:200').join(',');

/**
 * The literal per-hex pacing constant real Wesnoth's own movement loop
 * rounds to (`units/udisplay.cpp`'s `move_unit_between`: "we round it to
 * the next multiple of 200 so that movement aligns to hex changes
 * properly") -- and exactly the segment length of every repeat in
 * `MOVEMENT_DEFAULT_OFFSET` above, which is not a coincidence: that
 * string exists so each 200ms repeat can be consumed by one hex of a
 * continuously-reused "movement" animation instance
 * (`unit_animator::replace_anim_if_invalid`, animation.cpp ~L1365 --
 * keeps the same running instance across consecutive hexes rather than
 * restarting it, as long as it still matches). `playback.ts`'s multi-hex
 * grouping uses this to know how much of a grouped cue's continuous
 * elapsed time belongs to each hex.
 */
export const HEX_STEP_MS = 200;

/**
 * `add_anims`' own `offset=` default for `[attack_anim]` (animation.cpp
 * ~L834-836) when an author declares neither `offset=` nor any
 * `[missile_frame]` (a ranged attack's projectile carries its own
 * `missile_offset=` instead, defaulted separately -- not ported here,
 * see module doc comment on missile frames being out of scope) -- the
 * lunge-toward-and-back-from-the-defender curve every real melee
 * `[attack_anim]` gets even when the author didn't author one
 * explicitly (many don't; the WEAPON_SPECIAL/DEFENSE_ANIM macros focus
 * on frames/sound, not repeating this boilerplate).
 */
const ATTACK_DEFAULT_OFFSET = '0~0.6,0.6~0';

/** Applies `defaultOffset` to `branch` only if it doesn't already declare its own `offset=`. */
function withDefaultOffset(branch: AnimBranch, defaultOffset: string): AnimBranch {
  if (bhas(branch, 'offset')) return branch;
  return { attrs: new Map(branch.attrs).set('offset', defaultOffset), children: branch.children };
}

/**
 * `add_anims`' treatment of an `[attack_anim]` with a projectile
 * (animation.cpp ~L838-852): `missile_offset=0~0.8` unless the author set
 * one (the missile flies from the attacker to most of the way to the
 * target), and a blank 1ms `[missile_frame]` added at both ends of the
 * sequence -- which also pulls the missile's start time to 0 at the latest.
 */
function withMissileDefaults(branch: AnimBranch): AnimBranch {
  const attrs = new Map(branch.attrs);
  if (!bhas(branch, 'missile_offset')) attrs.set('missile_offset', '0~0.8');
  const pad = (): { tag: string; config: WmlConfig } => {
    const cfg = new WmlConfig();
    cfg.setAttribute('duration', 1);
    return { tag: 'missile_frame', config: cfg };
  };
  return { attrs, children: [pad(), ...branch.children, pad()] };
}

/** Tags handled like `add_simple_anim`: one fixed `apply_to`, no per-tag attribute rewriting. */
const SIMPLE_ANIM_TAGS: Readonly<Record<string, string>> = {
  resistance_anim: 'resistance',
  leading_anim: 'leading',
  teaching_anim: 'teaching',
  recruit_anim: 'recruited',
  recruiting_anim: 'recruiting',
  idle_anim: 'idling',
  levelin_anim: 'levelin',
  levelout_anim: 'levelout',
  pre_movement_anim: 'pre_movement',
  post_movement_anim: 'post_movement',
  draw_weapon_anim: 'draw_weapon',
  sheath_weapon_anim: 'sheath_weapon',
  victory_anim: 'victory',
};

/** `sub_anims_["_x_sound"].add_frame(1ms, frame_builder().sound(files))`: a one-millisecond sound-only particle at the animation clock's 0. */
function withSound(anim: UnitAnimationDef, prefix: string, files: string): UnitAnimationDef {
  if (files === '') return anim;
  const cfg = new WmlConfig();
  cfg.setAttribute('duration', 1);
  cfg.setAttribute('sound', files);
  const particle: ParticleDef = { prefix, frames: [parseFrame(cfg)], startTimeMs: 0, params: buildFrameFields(new WmlConfig(), 1), cycles: false };
  return { ...anim, particles: [...anim.particles, particle] };
}

/**
 * TS port of `unit_animation::add_anims` (plus the "no `[standing_anim]` at
 * all" branch of `fill_initial_animations`): parses every `[*_anim]`/
 * `[defend]`/`[death]` block on a unit type's raw config into a flat,
 * queryable `UnitAnimationDef[]`. See module doc comment for what's
 * deliberately not synthesised (the richer standing-anim-derived fallback
 * chain for events with no explicit author-provided animation).
 */
export function parseUnitAnimations(unitTypeCfg: WmlConfig): UnitAnimationDef[] {
  const out: UnitAnimationDef[] = [];

  const forTag = (tagName: string, build: (branch: AnimBranch) => UnitAnimationDef[]): void => {
    for (const tagCfg of unitTypeCfg.children(tagName)) {
      for (const branch of expandAnimationBranches(tagCfg)) {
        out.push(...build(branch));
      }
    }
  };

  forTag('animation', (branch) => [buildAnimationDef(branch, splitList(bstr(branch, 'apply_to', '')))]);

  for (const [tag, applyTo] of Object.entries(SIMPLE_ANIM_TAGS)) {
    forTag(tag, (branch) => [buildAnimationDef(branch, [applyTo])]);
  }

  // standing_anim registers under BOTH "standing" and "default" (add_anims
  // ~L667-715: standing animations double as the fallback default).
  forTag('standing_anim', (branch) => [
    buildAnimationDef(branch, ['standing']),
    buildAnimationDef(branch, ['default']),
  ]);

  forTag('healing_anim', (branch) => [buildAnimationDef(
    bhas(branch, 'damage') ? { attrs: new Map(branch.attrs).set('value', battr(branch, 'damage')!), children: branch.children } : branch,
    ['healing'],
  )]);
  // `add_anims` gives these three a sound frame of their own at the start (`_healed_sound`, `_poison_sound`, `_death_sound`).
  forTag('healed_anim', (branch) => [withSound(buildAnimationDef(
    bhas(branch, 'healing') ? { attrs: new Map(branch.attrs).set('value', battr(branch, 'healing')!), children: branch.children } : branch,
    ['healed'],
  ), '_healed_sound_', unitTypeCfg.getString('healed_sound', '') || 'heal.wav')]);
  forTag('poison_anim', (branch) => [withSound(buildAnimationDef(
    bhas(branch, 'damage') ? { attrs: new Map(branch.attrs).set('value', battr(branch, 'damage')!), children: branch.children } : branch,
    ['poisoned'],
  ), '_poison_sound_', 'poison.ogg')]);

  forTag('movement_anim', (branch) => [
    { ...buildAnimationDef(withDefaultOffset(branch, MOVEMENT_DEFAULT_OFFSET), ['movement']), usesDefaultMovementOffset: !bhas(branch, 'offset') },
  ]);
  forTag('attack_anim', (branch) => [
    buildAnimationDef(bchildren(branch, 'missile_frame').length > 0 ? withMissileDefaults(branch) : withDefaultOffset(branch, ATTACK_DEFAULT_OFFSET), ['attack']),
  ]);
  forTag('death', (branch) => [withSound(buildAnimationDef(branch, ['death']), '_death_sound_', unitTypeCfg.getString('die_sound', ''))]);
  forTag('defend', buildDefendAnimations);

  forTag('extra_anim', (branch) => {
    const flag = bstr(branch, 'flag', '');
    return flag ? [buildAnimationDef(branch, [flag])] : [];
  });
  forTag('teleport_anim', (branch) => [
    buildAnimationDef(branch, ['pre_teleport']),
    buildAnimationDef(branch, ['post_teleport']),
  ]);

  // Fallback: a unit type with no [standing_anim] at all still needs
  // *something* to match "default"/"standing" against (fill_initial_
  // animations' no-animation_base branch, animation.cpp ~L517-521).
  if (!out.some((a) => a.events.includes('default'))) {
    const image = unitTypeCfg.getString('image', '');
    out.push(buildAnimationDef({ attrs: new Map(), children: image ? [{ tag: 'frame', config: new WmlConfig().setAttribute('image', image) }] : [] }, ['default'], DEFAULT_ANIM));
  }

  // The generic engine-injected "defend" hit-flash (fill_initial_
  // animations, animation.cpp ~L570-579): every unit type gets this as a
  // LOW-PRIORITY fallback candidate, reusing its own "default" (standing,
  // or the trivial 1-frame fallback just above) frame/image data with a
  // red blend pulse -- NOT a unit-specific asset. `matchAnimation`
  // itself adds the real +1 for a matching `hits=` filter, so any real
  // authored `[defend]` block (baseScore >= -1 after `buildDefendAnimations`'
  // own -1 penalty, or higher) still outscores and replaces this for a
  // unit that has one -- see this function's own module doc comment on
  // why most real mainline units (which DO author `[defend]`, e.g. via
  // the `DEFENSE_ANIM*` macros) won't actually show this fallback; it's
  // for the units that don't. Only "defend" is ported from the larger
  // `fill_initial_animations` synthesis (movement/attack/death/healing/
  // poisoned/levelin/etc mirrors are NOT -- out of scope, see module doc
  // comment).
  const defaultAnim = out.find((a) => a.events.includes('default'));
  if (defaultAnim) {
    const baseDurationMs = Math.max(1, defaultAnim.frames.reduce((sum, f) => sum + f.durationMs, 0));
    const flashCfg = new WmlConfig();
    flashCfg.setAttribute('blend_ratio', '0.0,0.5:75,0.0:75,0.5:75,0.0');
    flashCfg.setAttribute('blend_color', '255,0,0');
    out.push({
      ...defaultAnim,
      events: ['defend'],
      baseScore: DEFAULT_ANIM,
      hits: ['hit', 'kill'],
      animationParams: buildFrameFields(flashCfg, baseDurationMs),
    });
    out.push({
      ...defaultAnim,
      events: ['defend'],
      baseScore: DEFAULT_ANIM,
      hits: [],
    });
  }

  return out;
}

// ── [filter_attack]/[filter_second_attack] matching ─────────────────────────

function parseIntRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const part of text.split(',')) {
    const token = part.trim();
    if (token === '') continue;
    const dash = token.indexOf('-', token[0] === '-' ? 1 : 0);
    if (dash === -1) {
      const n = Number(token);
      if (!Number.isNaN(n)) ranges.push([n, n]);
    } else {
      const lo = Number(token.slice(0, dash));
      const hi = Number(token.slice(dash + 1));
      if (!Number.isNaN(lo) && !Number.isNaN(hi)) ranges.push([lo, hi]);
    }
  }
  return ranges;
}
function inIntRanges(n: number, ranges: Array<[number, number]>): boolean {
  return ranges.length === 0 ? true : ranges.some(([lo, hi]) => n >= lo && n <= hi);
}

/**
 * TS port of `attack_type::matches_filter`/`matches_simple_filter`
 * (units/attack_type.cpp ~L161-323) — the subset real animation filters
 * exercise: `range=`/`min_range=`/`max_range=`/`damage=`/`number=`/
 * `accuracy=`/`parry=`/`alignment=`/`name=`/`type=`, plus `[and]`/`[or]`/
 * `[not]` composition. NOT ported: `movement_used=`/`attacks_used=`/
 * `special_active=`/`formula=` (runtime combat-state fields with no
 * equivalent in a headless animation context).
 */
export function attackMatchesFilter(attack: AttackType, filter: WmlConfig): boolean {
  let matches = true;

  if (filter.hasAttribute('range')) {
    matches &&= splitList(filter.getString('range')).includes(attack.range);
  }
  if (filter.hasAttribute('min_range')) {
    matches &&= inIntRanges(attack.minRange, parseIntRanges(filter.getString('min_range')));
  }
  if (filter.hasAttribute('max_range')) {
    matches &&= inIntRanges(attack.maxRange, parseIntRanges(filter.getString('max_range')));
  }
  if (filter.hasAttribute('damage')) {
    matches &&= inIntRanges(attack.damage, parseIntRanges(filter.getString('damage')));
  }
  if (filter.hasAttribute('number')) {
    matches &&= inIntRanges(attack.numAttacks, parseIntRanges(filter.getString('number')));
  }
  if (filter.hasAttribute('accuracy')) {
    matches &&= inIntRanges(attack.accuracy, parseIntRanges(filter.getString('accuracy')));
  }
  if (filter.hasAttribute('parry')) {
    matches &&= inIntRanges(attack.parry, parseIntRanges(filter.getString('parry')));
  }
  if (filter.hasAttribute('alignment')) {
    matches &&= !!attack.alignment && splitList(filter.getString('alignment')).includes(attack.alignment);
  }
  if (filter.hasAttribute('name')) {
    matches &&= splitList(filter.getString('name')).includes(attack.id);
  }
  if (filter.hasAttribute('type')) {
    matches &&= splitList(filter.getString('type')).includes(attack.type);
  }

  for (const { tag, config } of filter.allChildren()) {
    if (tag === 'and') matches = matches && attackMatchesFilter(attack, config);
    else if (tag === 'or') matches = matches || attackMatchesFilter(attack, config);
    else if (tag === 'not') matches = matches && !attackMatchesFilter(attack, config);
  }

  return matches;
}

// ── matching / selection ─────────────────────────────────────────────────────

export interface MatchOptions {
  /** Supplies `frequency_`'s random-rejection check (animation.cpp ~L459-461); omit for deterministic matching. */
  getRandomInt?: (lo: number, hi: number) => number;
}

/**
 * TS port of `unit_animation::matches_headless` (animation.hpp/.cpp
 * ~L396-502): scores one `UnitAnimationDef` against an `AnimationContext`,
 * returning `MATCH_FAIL` if any populated filter fails, else `baseScore`
 * plus one point per filter that was checked and passed.
 */
export function matchAnimation(anim: UnitAnimationDef, ctx: AnimationContext, opts: MatchOptions = {}): number {
  let result = anim.baseScore;

  if (ctx.event !== '' && anim.events.length > 0) {
    if (!anim.events.includes(ctx.event)) return MATCH_FAIL;
    result++;
  }

  if (anim.terrainTypes.length > 0) {
    if (!terrainMatches(ctx.terrainAtLoc, anim.terrainTypes)) return MATCH_FAIL;
    result++;
  }

  if (anim.value.length > 0) {
    if (!anim.value.includes(ctx.value)) return MATCH_FAIL;
    result++;
  }

  if (anim.directions.length > 0) {
    if (!anim.directions.includes(ctx.myUnit.facing)) return MATCH_FAIL;
    result++;
  }
  for (const filter of anim.unitFilters) {
    if (!unitMatchesFilter(ctx.myUnit, filter)) return MATCH_FAIL;
    result++;
  }
  if (anim.secondaryUnitFilters.length > 0) {
    if (!ctx.secondUnit) return MATCH_FAIL;
    for (const filter of anim.secondaryUnitFilters) {
      if (!unitMatchesFilter(ctx.secondUnit, filter)) return MATCH_FAIL;
      result++;
    }
  }

  if (anim.frequency && opts.getRandomInt) {
    if (opts.getRandomInt(0, anim.frequency - 1) === 0) return MATCH_FAIL;
  }

  if (anim.hits.length > 0) {
    if (!anim.hits.includes(ctx.hit)) return MATCH_FAIL;
    result++;
  }
  if (anim.value2.length > 0) {
    if (!anim.value2.includes(ctx.value2)) return MATCH_FAIL;
    result++;
  }

  if (!ctx.attack) {
    if (anim.primaryAttackFilters.length > 0) return MATCH_FAIL;
  } else {
    for (const filter of anim.primaryAttackFilters) {
      if (!attackMatchesFilter(ctx.attack, filter)) return MATCH_FAIL;
      result++;
    }
  }

  if (!ctx.secondAttack) {
    if (anim.secondaryAttackFilters.length > 0) return MATCH_FAIL;
  } else {
    for (const filter of anim.secondaryAttackFilters) {
      if (!attackMatchesFilter(ctx.secondAttack, filter)) return MATCH_FAIL;
      result++;
    }
  }

  return result;
}

/** Every candidate that isn't `MATCH_FAIL`, with its score. */
export function scoreAnimations(
  animations: readonly UnitAnimationDef[],
  ctx: AnimationContext,
  opts: MatchOptions = {},
): Array<{ anim: UnitAnimationDef; score: number }> {
  return animations
    .map((anim) => ({ anim, score: matchAnimation(anim, ctx, opts) }))
    .filter((r) => r.score > MATCH_FAIL);
}

/**
 * TS port of `unit_animation_component::choose_animation`'s max-score
 * selection (animation_component.cpp ~L46-68), returning *all* tied
 * top-scoring candidates rather than picking one — upstream picks randomly
 * among ties; callers here decide how (see `chooseAnimation`).
 */
export function selectTopAnimations(
  animations: readonly UnitAnimationDef[],
  ctx: AnimationContext,
  opts: MatchOptions = {},
): UnitAnimationDef[] {
  const scored = scoreAnimations(animations, ctx, opts);
  if (scored.length === 0) return [];
  const max = Math.max(...scored.map((r) => r.score));
  return scored.filter((r) => r.score === max).map((r) => r.anim);
}

/**
 * Convenience over `selectTopAnimations`: picks one candidate among the
 * tied top scorers. Defaults to the first (deterministic, for tests);
 * upstream picks uniformly at random (`randomness::rng::default_instance()
 * .get_random_int`) — pass `pick` to reproduce that with a real `Rng`.
 */
export function chooseAnimation(
  animations: readonly UnitAnimationDef[],
  ctx: AnimationContext,
  opts: MatchOptions = {},
  pick: (candidates: readonly UnitAnimationDef[]) => UnitAnimationDef | undefined = (c) => c[0],
): UnitAnimationDef | undefined {
  return pick(selectTopAnimations(animations, ctx, opts));
}
