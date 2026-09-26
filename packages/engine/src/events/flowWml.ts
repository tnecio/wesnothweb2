/**
 * TS port of `data/lua/wml-flow.lua`: the loop and flow-control action
 * tags (`[while]`, `[for]`, `[foreach]`, `[repeat]`, `[switch]`,
 * `[command]`, and the `[break]`/`[continue]`/`[return]` signals).
 * `[if]` itself stays in `actionWml.ts`, next to the rest of the tags.
 *
 * Written in Phase 17 rather than earlier for two reasons: real content
 * needs them (Under the Burning Suns 1's prestart totals up its rescue
 * pool with `[foreach] array=elf_pool`, and `[option][command]` bodies
 * may contain anything), and they have to be suspendable -- a `[message]`
 * inside a loop body must block the loop, which means every body here is
 * delegated to with `yield*` rather than run to completion.
 *
 * Exit signalling is upstream's: a shared `ctx.exit` box that each body
 * sets and each loop consumes (`wml-utils.lua`'s `current_exit`/
 * `set_exiting`). `break`/`continue` are swallowed by the innermost loop;
 * `return` unwinds every scope out to the event itself.
 *
 * NOT ported: `[insert_tag]`-driven bodies (the whole port has no
 * `[insert_tag]`), `[foreach]`'s "array modified during iteration" error
 * (the write-back itself is ported), and `[for]`'s `$(...)` formula
 * bounds, which need the WFL evaluator `variables.ts` deliberately omits.
 */

import type { WmlConfig } from '../wml/config.js';
import type { EventContext } from './context.js';
import { conditionalPassed } from './conditionalWml.js';
import { findLocations } from './filter.js';
import { Location } from '../model/Location.js';
import { MapFormulaCallable, Variant, parseFormula } from '../formula/index.js';
import { runActionFlow } from './actionWml.js';
import { newVarNode, varNodeFromConfig, varNodeToConfig, type VarNode } from './variables.js';
import type { Flow } from './interaction.js';

/** Upstream's own ceiling on `[while]` (`for i = 1, 65536`), so a runaway condition can't hang the game. */
const MAX_LOOP_ITERATIONS = 65536;

/** What one pass over a loop tag's `[do]` children decided. */
type LoopStep =
  /** Keep going: the body finished, or `[continue]` cut it short. */
  | 'next'
  /** `[break]`: leave this loop, carry on after it. */
  | 'stop'
  /** `[return]` (or anything else that unwinds): propagate out of the loop too. */
  | 'unwind';

/** Runs every `[do]` (or `bodyTag`) child once, translating whatever the body signalled into a `LoopStep`. */
function* runDoBodies(cfg: WmlConfig, ctx: EventContext, bodyTag = 'do'): Flow<LoopStep> {
  for (const doCfg of cfg.children(bodyTag)) {
    yield* runActionFlow(doCfg, ctx);
    const exit = ctx.exit.type;
    if (exit === 'break') {
      ctx.exit.type = 'none';
      return 'stop';
    }
    if (exit === 'continue') {
      ctx.exit.type = 'none';
      return 'next';
    }
    if (exit !== 'none') return 'unwind';
  }
  return 'next';
}

function requireDo(cfg: WmlConfig, ctx: EventContext, tag: string): boolean {
  if (cfg.hasChild('do')) return true;
  ctx.log('error', `[${tag}] does not contain any [do] tags`);
  return false;
}

/**
 * Saves a variable's current value so a loop can restore it afterwards,
 * mirroring `utils.scoped_var`: `[foreach]`'s `$this_item` and `[for]`'s
 * `$i` shadow whatever was there and put it back when the loop ends.
 */
function scopeVariable(ctx: EventContext, name: string): () => void {
  const saved = ctx.variables.getConfig(name);
  const savedScalar = ctx.variables.get(name);
  return () => {
    ctx.variables.clear(name);
    if (saved && saved.attributeNames().length + saved.allChildren().length > 0) ctx.variables.setConfig(name, saved);
    else if (savedScalar !== undefined) ctx.variables.set(name, savedScalar);
  };
}

// --- [command] ---

/** A plain body; upstream registers it so `[command]` can be used anywhere an action list is expected. */
function* actionCommand(cfg: WmlConfig, ctx: EventContext): Flow {
  yield* runActionFlow(cfg, ctx);
}

// --- [break] / [continue] / [return] ---

function actionBreak(_cfg: WmlConfig, ctx: EventContext): void {
  ctx.exit.type = 'break';
}

function actionContinue(_cfg: WmlConfig, ctx: EventContext): void {
  ctx.exit.type = 'continue';
}

function actionReturn(_cfg: WmlConfig, ctx: EventContext): void {
  ctx.exit.type = 'return';
}

// --- [while] ---

function* actionWhile(cfg: WmlConfig, ctx: EventContext): Flow {
  if (!requireDo(cfg, ctx, 'while')) return;

  for (let i = 0; i < MAX_LOOP_ITERATIONS; i++) {
    // Re-evaluated each pass (the condition normally reads a variable the
    // body is changing): `conditionalPassed` expands each condition child
    // itself, and `[do]` is one of the tags it knows to skip.
    if (!conditionalPassed(cfg, ctx)) return;
    const step = yield* runDoBodies(cfg, ctx);
    if (step === 'stop') return;
    if (step === 'unwind') return;
  }
  ctx.log('warn', `[while] hit the ${MAX_LOOP_ITERATIONS}-iteration limit`);
}

// --- [repeat] ---

function* actionRepeat(cfg: WmlConfig, ctx: EventContext): Flow {
  if (!requireDo(cfg, ctx, 'repeat')) return;

  const times = cfg.getNumber('times', 1);
  for (let i = 0; i < times; i++) {
    const step = yield* runDoBodies(cfg, ctx);
    if (step === 'stop' || step === 'unwind') return;
  }
}

// --- [random_placement] ---

/**
 * `data/lua/wml/random_placement.lua`: `num_items=` times, picks a random
 * hex among those `[filter_location]` matches (a synced draw,
 * `mathx.random(size)`), writes it to `$variable.x/.y/.n/.terrain`, drops
 * every candidate within `min_distance=` of it, and runs `[command]`.
 * `num_items=` is a number, a WFL formula in parentheses with `size` (the
 * candidate count), or `N%` -- which upstream reads as plain `N`. The
 * variable is restored afterwards (`utils.scoped_var`).
 */
function* actionRandomPlacement(cfg: WmlConfig, ctx: EventContext): Flow {
  if (!cfg.hasChild('command')) {
    ctx.log('error', '[random_placement] missing required [command] subtag');
    return;
  }
  if (!cfg.hasAttribute('num_items') || !cfg.hasAttribute('variable')) {
    ctx.log('error', `[random_placement] missing required '${cfg.hasAttribute('num_items') ? 'variable' : 'num_items'}' attribute`);
    return;
  }
  if (!ctx.rng) {
    ctx.log('warn', '[random_placement] needs a game RNG -- skipped');
    return;
  }
  const variable = cfg.getString('variable');
  const distance = cfg.getNumber('min_distance', 0);
  const allowLess = cfg.getBoolean('allow_less', false);
  const filter = cfg.child('filter_location');
  // `wesnoth.map.find`: sorted by (x, y), in WML coordinates.
  const locs = (filter ? findLocations(ctx.board, ctx.variables.expandConfigDeep(filter)) : allLocations(ctx))
    .sort((a, b) => a.x - b.x || a.y - b.y)
    .map((l) => ({ x: l.wmlX, y: l.wmlY, loc: l }));

  const raw = cfg.getString('num_items');
  let numItems: number;
  if (/^\s*\(.*\)\s*$/s.test(raw)) {
    numItems = Math.floor(parseFormula(raw).evaluate(new MapFormulaCallable().add('size', Variant.int(locs.length))).asDecimal());
  } else if (/^\d+%$/.test(raw)) {
    numItems = Number(raw.slice(0, -1));
  } else {
    numItems = Math.floor(Number(raw));
    if (Number.isNaN(numItems)) {
      ctx.log('error', `[random_placement] num_items=${raw}: Lua expressions are not supported`);
      return;
    }
  }

  const restore = scopeVariable(ctx, variable);
  try {
    let size = locs.length;
    for (let i = 1; i <= numItems; i++) {
      if (size === 0) {
        if (!allowLess) ctx.log('error', `[random_placement] failed to place items. only ${i} items were placed`);
        return;
      }
      const index = ctx.rng.getRandomInt(1, size) - 1;
      const point = locs[index]!;
      ctx.variables.set(`${variable}.x`, point.x);
      ctx.variables.set(`${variable}.y`, point.y);
      ctx.variables.set(`${variable}.n`, i);
      ctx.variables.set(`${variable}.terrain`, ctx.board.map.getTerrain(point.loc).toString());
      if (distance === 0) {
        locs[index] = locs[size - 1]!;
        size--;
      } else if (distance > 0) {
        // Drop candidates within distance= (distance_between, done inline as the Lua does).
        for (let j = size - 1; j >= 0; j--) {
          const { x: x1, y: y1 } = locs[j]!;
          let y2 = point.y;
          const dx = Math.abs(x1 - point.x);
          if (dx > distance) continue;
          if (dx % 2 !== 0) y2 += x1 % 2 === 0 ? -0.5 : 0.5;
          const dy = Math.abs(y1 - y2);
          if (dx + 2 * dy > 2 * distance) continue;
          locs[j] = locs[size - 1]!;
          size--;
        }
      }
      const step = yield* runDoBodies(cfg, ctx, 'command');
      if (step !== 'next') return;
    }
  } finally {
    restore();
  }
}

function allLocations(ctx: EventContext): Location[] {
  const out: Location[] = [];
  for (let x = 0; x < ctx.board.map.w(); x++) for (let y = 0; y < ctx.board.map.h(); y++) out.push(new Location(x, y));
  return out;
}

// --- [for] ---

function* actionFor(cfg: WmlConfig, ctx: EventContext): Flow {
  if (!requireDo(cfg, ctx, 'for')) return;

  const arrayName = cfg.getString('array', '');
  let first: number;
  let last: number;
  let step: number;
  if (arrayName !== '') {
    const length = ctx.variables.arrayLength(arrayName);
    if (cfg.getBoolean('reverse', false)) {
      first = length - 1;
      last = 0;
      step = -1;
    } else {
      first = 0;
      last = length - 1;
      step = 1;
    }
  } else {
    first = cfg.getNumber('start', 0);
    last = cfg.hasAttribute('end') ? cfg.getNumber('end') : first;
    step = cfg.getNumber('step', 1);
  }

  if (step === 0) {
    ctx.log('error', '[for] has a step of 0!');
    return;
  }
  // start,end,step=1,4,-1 and friends: nothing to do, as upstream.
  if ((first < last && step <= 0) || (first > last && step >= 0)) return;

  const counterName = cfg.getString('variable', 'i');
  const restore = scopeVariable(ctx, counterName);
  try {
    for (let value = first; step > 0 ? value <= last : value >= last; value += step) {
      ctx.variables.set(counterName, value);
      const outcome = yield* runDoBodies(cfg, ctx);
      if (outcome === 'stop' || outcome === 'unwind') return;
    }
  } finally {
    restore();
  }
}

// --- [foreach] ---

function* actionForeach(cfg: WmlConfig, ctx: EventContext): Flow {
  if (!requireDo(cfg, ctx, 'foreach')) return;

  const arrayName = cfg.getString('array', '');
  if (arrayName === '') {
    ctx.log('error', '[foreach] missing required array= attribute');
    return;
  }
  // A copy, so the loop iterates over what the array held when it
  // started even if the body edits the original (upstream does the same,
  // and writes this copy back at the end).
  const items: VarNode[] = [...ctx.variables.getArray(arrayName)];
  if (items.length === 0) return;

  const itemName = cfg.getString('variable', 'this_item');
  const indexName = cfg.getString('index_var', 'i');
  const readonly = cfg.getBoolean('readonly', false);
  const restoreItem = scopeVariable(ctx, itemName);
  const restoreIndex = scopeVariable(ctx, indexName);

  try {
    for (let index = 0; index < items.length; index++) {
      ctx.variables.clear(itemName);
      ctx.variables.setConfig(itemName, varNodeToConfig(items[index] ?? newVarNode()));
      ctx.variables.set(indexName, index);

      const outcome = yield* runDoBodies(cfg, ctx);
      if (outcome === 'stop' || outcome === 'unwind') return;

      // The body may have edited $this_item; unless readonly=yes, that
      // edit belongs to the array.
      if (!readonly) {
        const edited = ctx.variables.getConfig(itemName);
        if (edited) items[index] = varNodeFromConfig(edited);
      }
    }
  } finally {
    restoreItem();
    restoreIndex();
    if (!readonly) ctx.variables.setArray(arrayName, items);
  }
}

// --- [switch] ---

function* actionSwitch(cfg: WmlConfig, ctx: EventContext): Flow {
  const variableName = cfg.getString('variable', '');
  const value = String(ctx.variables.get(variableName) ?? '');
  let matched = false;

  // Every matching [case] runs, as upstream (a [case] can list several
  // values, comma-separated).
  for (const caseCfg of cfg.children('case')) {
    const candidates = String(caseCfg.get('value') ?? '')
      .split(',')
      .map((s) => s.trim());
    if (!candidates.includes(value)) continue;
    matched = true;
    yield* runActionFlow(caseCfg, ctx);
    if (ctx.exit.type !== 'none') return;
  }

  if (matched) return;
  for (const elseCfg of cfg.children('else')) {
    yield* runActionFlow(elseCfg, ctx);
    if (ctx.exit.type !== 'none') return;
  }
}

/** Registers every flow-control tag on a registry -- called by `createDefaultActionRegistry`. */
export function registerFlowActions(register: (tag: string, handler: (cfg: WmlConfig, ctx: EventContext) => void | Flow) => void): void {
  register('command', actionCommand);
  register('while', actionWhile);
  register('repeat', actionRepeat);
  register('random_placement', actionRandomPlacement);
  register('for', actionFor);
  register('foreach', actionForeach);
  register('switch', actionSwitch);
  register('break', actionBreak);
  register('continue', actionContinue);
  register('return', actionReturn);
}
