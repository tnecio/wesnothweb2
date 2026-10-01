/**
 * TS port of the executable half of WML's action tags: the handlers a
 * `[event]` (or `[if][then]`, `[command]`, ...) body invokes tag by tag.
 *
 * Upstream split this across two eras of code that this port collapses
 * into one place: the handful of tags still implemented in C++
 * (`src/game_events/action_wml.cpp` -- `[unit]`, `[modify_turns]`,
 * `[recall]`, `[tunnel]`, ...) and the much larger set that moved to Lua
 * (`data/lua/wml-tags.lua`, `data/lua/wml-flow.lua`, and the per-tag files
 * under `data/lua/wml/*.lua` -- `[message]`, `[if]`, `[set_variable]`,
 * `[modify_unit]`, `[kill]`, `[store_unit]`, ...). Since Lua isn't ported
 * yet (Phase 3), this file re-implements the *behavior* those Lua files
 * define directly in TypeScript, reading them as the spec.
 *
 * ## Implemented action tags
 * `message`, `if` (with `then`/`elseif`/`else`), `set_variable` (`value`,
 * `literal`, `to_variable`, `prefix`, `suffix`, `add`, `sub`, `multiply`,
 * `divide`, `modulo`, `abs`, `round` incl. ceil/floor/trunc, `power`,
 * `root` incl. square/cube, `ipart`/`fpart`, `min`/`max`, `string_length`,
 * `reverse`, `join`), `set_variables` (all of upstream's, see its doc comment), `clear_variable`, `store_unit`,
 * `unstore_unit` (real, reported bug: a common "hide units off-board during
 * a cutscene" idiom -- `[store_unit] kill=yes` then a later `[unstore_unit]`
 * -- silently never restored the unit at all, permanently removing it; see
 * that handler's own doc comment), `kill`, `modify_unit` (simplified, see
 * below), `unit` (spawn), `gold`,
 * `store_gold`, `allow_recruit`, `capture_village` (side= only, see its
 * own doc comment), `recall` (see its own doc comment for what's
 * deliberately not re-implemented from upstream's C++ `[recall]` handler),
 * `move_unit` (real, reported bug: real scenario content -- e.g.
 * Dead_Water scenario 1's `{MOVE_UNIT id=Gwabbo 20 10}` -- silently did
 * nothing; see that handler's own doc comment for what it does and does
 * not cover, and `pathfind.ts`'s `findVacantTile`, ported alongside it),
 * `objectives` (real, reported bug: used to be a no-op -- see
 * `objectives.ts`'s own doc comment for the real `data/lua/wml/
 * objectives.lua` logic it ports and what's deliberately scoped out),
 * `heal_unit` (see its own doc comment for the real `data/lua/wml/
 * heal_unit.lua` subset), `set_menu_item`/`clear_menu_item` (Phase 14:
 * lets a scenario's `[event]`s declare real right-click context-menu
 * entries -- see their own doc comments and `GameSession.menuItems`/
 * `runMenuItem`, packages/ui, for how the UI surfaces and executes them).
 *
 * Presentation-only tags with nothing to show for them headlessly are
 * registered as explicit no-ops (not silently dropped) so real content
 * doesn't spam "unsupported tag" warnings: `music`, `sound`, `redraw`,
 * `highlight`, `floating_text`, `label`, `select_unit`, `unit_overlay`,
 * `remove_unit_overlay`. The cutscene and camera tags that used to be in
 * that list -- `[delay]`, `[scroll_to]`, `[move_unit_fake]`, ... -- are
 * real as of Phase 17 and live in `cutsceneWml.ts`, registered from here.
 *
 * ## Extension points (NOT implemented here, on purpose)
 * `[attack]`, `[recruit]` (need `packages/engine/src/actions/`'s
 * combat/recruit logic, being built in parallel -- explicitly out of
 * scope for this module per the task brief) and `[lua]` (needs the Phase
 * 3 Lua bridge) remain placeholders. Each is registered with a handler
 * that logs a clear "extension point" message and no-ops, rather than
 * either crashing or silently doing nothing -- `ActionRegistry.
 * register(tag, handler)` is public specifically so later work can
 * override these without touching this file.
 *
 * ## Known simplifications
 * `[modify_unit]` upstream (`data/lua/wml/modify_unit.lua`) is a fully
 * generic WML-tree merge over a unit's *entire* serialized config
 * (arbitrary nested tags, `mode=replace` semantics per-subtree, `[object]`/
 * `[trait]`/`[effect]` application). This port implements only: direct
 * top-level scalar field overrides for the handful of fields `model/
 * Unit.ts` actually models (hitpoints, max_hitpoints, moves, max_moves,
 * experience, max_experience, side, canrecruit, name, facing), plus
 * `[set_variable]`/`[set_variables]`/`[clear_variable]` children applied
 * to the matched unit's own `variables` bag. No `[object]`/`[trait]`/
 * `[effect]` support (needs the effects/WFL machinery `Unit.ts` itself
 * defers, see its module doc comment).
 *
 * The rest of `data/lua/wml-flow.lua` -- `[while]`/`[for]`/`[foreach]`/
 * `[repeat]`/`[switch]`/`[command]` and the `[break]`/`[continue]`/
 * `[return]` signals -- lives in `flowWml.ts` (Phase 17), registered from
 * here; only `[if]` stayed in this file, next to the other tags.
 */

import type { EndLevelState } from './context.js';
import { Direction, Location, parseDirection } from '../model/Location.js';
import { Unit } from '../model/Unit.js';
import { WmlConfig, plainValue, type WmlStoredValue } from '../wml/config.js';
import { checkRecruitLocation, recallUnit, rollNewUnit } from '../actions/recruit.js';
import { findPath, findVacantTile } from '../pathfind/pathfind.js';
import type { Rng } from '../rng/Rng.js';
import type { EffectEnv } from '../model/effects.js';
import type { ActionHandler, EventContext, RecordedMessage } from './context.js';
import { ActionRegistry } from './context.js';
import { TString } from '../i18n/tstring.js';
import { isFlow, runFlow, type Flow, type MessageOption, type MessageTexts, type Responder, type TextInputSpec } from './interaction.js';
import { conditionalPassed } from './conditionalWml.js';
import { findUnits, locationMatchesFilter, unitMatchesFilter } from './filter.js';
import { actionLabel } from './labelsWml.js';
import { actionItem, actionRemoveItem, actionStoreItems } from './itemsWml.js';
import { actionLiftFog, actionPlaceShroud, actionRemoveShroud, actionResetFog } from './shroudWml.js';
import {
  actionCancelAction,
  actionHideUnit,
  actionModifyTurns,
  actionPutToRecallList,
  actionSetRecruit,
  actionStoreLocations,
  actionStoreMapDimensions,
  actionStoreSide,
  actionStoreStartingLocation,
  actionStoreTurns,
  actionStoreUnitType,
  actionStoreVillages,
  actionTerrain,
  actionTerrainMask,
  actionUnhideUnit,
  actionUnitWorth,
  actionWmlMessage,
  sidesFor,
} from './miscWml.js';
import { actionTimeArea, actionRemoveTimeArea, actionReplaceSchedule, actionStoreTimeOfDay } from './todWml.js';
import { cloneVarNode, newVarNode, varNodeFromConfig, varNodeToConfig, VariableStore, type VarNode } from './variables.js';
import { parseScenarioObjectives, type ScenarioObjectives } from './objectives.js';
import { registerFlowActions } from './flowWml.js';
import { registerSupportActions } from './supportWml.js';
import { playBeat, registerCutsceneActions } from './cutsceneWml.js';
import { ShroudClearer } from '../actions/vision.js';
import { applyMusicAction } from '../audio/musicList.js';
import { soundSourceFromConfig } from '../audio/soundSources.js';

// --- shared helpers ---

/**
 * Runs a sequence of action tags (an `[event]` body, or an `[if][then]`/
 * `[else]`/`[elseif][then]` body), mirroring `wml-utils.lua`'s
 * `handle_event_commands`: each child is shallow-`$var`-expanded and
 * dispatched through `ctx.registry` immediately before it runs (NOT
 * upfront for the whole body -- see `variables.ts`'s `expandConfig` doc
 * comment on why), `filter*`-prefixed children are skipped (they belong to
 * the tag that owns this body, e.g. an `[event]`'s own trigger filters,
 * not to the action sequence), and iteration stops as soon as
 * `ctx.exit.type` becomes non-`'none'`.
 */
/** Action tags whose handler gets its config exactly as written (see `runActionFlow`); `[lua]`'s code is Lua, never `$`-substituted (`wml.shallow_literal` in `wml_actions.lua`). */
const RAW_CONFIG_TAGS = new Set(['event', 'objectives', 'lua', 'harm_unit']);

/** Whether `handler`, registered for `tag`, gets its config as written (see `RAW_CONFIG_TAGS`, `ActionHandler.rawConfig`). */
export function wantsRawConfig(tag: string, handler: ActionHandler): boolean {
  return RAW_CONFIG_TAGS.has(tag) || handler.rawConfig === true;
}

export function* runActionFlow(body: WmlConfig, ctx: EventContext): Flow {
  for (const child of body.allChildren()) {
    // `[insert_tag]` is resolved when the iteration reaches it (vconfig's
    // iterator), so an earlier action in this body can build its variable.
    const run = child.tag === 'insert_tag' ? ctx.variables.childrenWithInserts(wrapChild(child)) : [child];
    for (const { tag, config } of run) {
      yield* runOneAction(tag, config, ctx);
      if (ctx.exit.type !== 'none') return;
    }
  }
}

function wrapChild(child: { tag: string; config: WmlConfig }): WmlConfig {
  const holder = new WmlConfig();
  holder.addChild(child.tag, child.config);
  return holder;
}

function* runOneAction(tag: string, config: WmlConfig, ctx: EventContext): Flow {
  if (tag.startsWith('filter')) return;
  const handler = ctx.registry.get(tag);
  if (!handler) {
    ctx.log('warn', `[${tag}] not supported (skipped)`);
    return;
  }
  try {
    // A nested [event] is stored as written: its variables are substituted
    // when it fires, not now (`delayed_variable_substitution` defaults to
    // yes), so it must not get the usual attribute expansion either.
    // [objectives] decides for itself (its own delayed_variable_substitution=).
    const result = handler(wantsRawConfig(tag, handler) ? config : ctx.variables.expandConfig(config), ctx);
    // A handler that needs to block returns a generator (see
    // interaction.ts); delegating rather than driving it here is what
    // lets the suspension travel out to whoever is pumping.
    if (isFlow(result)) yield* result;
  } catch (e) {
    ctx.log('error', `Error occurred inside [${tag}]: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * `runActionFlow` for a caller with nothing to show: runs the body to
 * completion, answering any interaction inline with `autoRespond`. This
 * is the shape every pre-Phase-17 caller already used, kept so that
 * headless callers (`GameSession.runMenuItem`, tests) need no changes.
 */
export function runActionSequence(body: WmlConfig, ctx: EventContext, respond?: Responder): void {
  runFlow(runActionFlow(body, ctx), respond);
}

function extensionPoint(tag: string, owner: string): ActionHandler {
  return (_cfg, ctx) => {
    ctx.log(
      'warn',
      `[${tag}] extension point not implemented (needs ${owner}) -- no-op. ` +
        `Register a real handler via ActionRegistry.register('${tag}', ...) to wire it in.`,
    );
  };
}

function noop(): void {
  /* presentation-only, headless no-op */
}

// --- [message] ---

/**
 * Port of `data/lua/wml/message.lua`'s `wml_actions.message`: shows one
 * line of dialogue and, as of Phase 17, **blocks its event** until the
 * player dismisses it or answers its `[option]`/`[text_input]`.
 *
 * Ported: `[show_if]`; `get_speaker` (a message whose speaker cannot be
 * found is skipped, as upstream); `get_image`/`get_caption`'s portrait
 * and caption rules; `[option]` with `[show_if]`/`label=`/`message=`/
 * `description=`/`image=`/`default=`/`value=`/`[command]`; `[text_input]`
 * (first one only); `variable=`; `side_for=` gating for messages with no
 * input; Escape-skips-the-rest-of-this-event.
 *
 * `male_message=`/`female_message=` (and `male_voice=`/`female_voice=`)
 * are picked by the speaker's gender, as in `message.lua`; a message with
 * only gendered text and no speaker to choose by uses the male form. The
 * text also travels as translatable strings (`MessageInteraction.texts`),
 * so a dialogue that is open when the language changes follows it. The Pango
 * formatting attributes (`font=`, `color=`, `underline=`, ...) are not
 * applied either; `sound=`/`voice=` are carried on the recorded message
 * for Phase 19 rather than played.
 */
function* actionMessage(cfg: WmlConfig, ctx: EventContext): Flow {
  const showIf = cfg.child('show_if');
  if (showIf && !conditionalPassed(showIf, ctx)) return;

  // Only the first [text_input] is considered, as upstream.
  const textInputCfgs = cfg.children('text_input');
  if (textInputCfgs.length > 1) ctx.log('warn', 'Too many [text_input] tags, only first one accepted');
  const textInputCfg = textInputCfgs[0];
  let textInput: TextInputSpec | undefined;
  if (textInputCfg) {
    let maxLength = textInputCfg.getNumber('max_length', 256);
    if (maxLength > 1024 || maxLength < 1) {
      ctx.log('warn', `Invalid maximum size for input ${maxLength}`);
      maxLength = 256;
    }
    textInput = {
      labelT: textInputCfg.getTString('label'),
      label: textInputCfg.getString('label', ''),
      text: textInputCfg.getString('text', ''),
      maxLength,
    };
  }

  // [option]s that fail their own [show_if] are dropped entirely, so the
  // 1-based index a `variable=` receives counts only the shown ones.
  const options: MessageOption[] = [];
  const optionValues: Array<string | undefined> = [];
  const optionCommands: WmlConfig[][] = [];
  for (const optionCfg of cfg.children('option')) {
    const optionShowIf = optionCfg.child('show_if');
    if (optionShowIf && !conditionalPassed(optionShowIf, ctx)) continue;

    // message= and description= are synonyms (backwards compatibility upstream).
    const hasMessage = optionCfg.hasAttribute('message');
    const hasDescription = optionCfg.hasAttribute('description');
    let description = '';
    if (hasMessage && hasDescription) {
      ctx.log('warn', '[option] uses both message= and description= which is invalid.');
      description = 'Invalid use of both message and description attributes on this option!';
    } else if (hasMessage) {
      description = optionCfg.getString('message');
    } else if (hasDescription) {
      description = optionCfg.getString('description');
    }

    const descriptionKey = hasMessage ? 'message' : hasDescription ? 'description' : '';
    options.push({
      labelT: optionCfg.getTString('label'),
      descriptionT: descriptionKey !== '' && !(hasMessage && hasDescription) ? optionCfg.getTString(descriptionKey) : undefined,
      label: optionCfg.getString('label', ''),
      description,
      image: optionCfg.getString('image', ''),
      isDefault: optionCfg.getBoolean('default', false),
    });
    optionValues.push(optionCfg.hasAttribute('value') ? optionCfg.getString('value') : undefined);
    optionCommands.push(optionCfg.children('command'));
  }

  const hasInput = textInput !== undefined || options.length > 0;

  // Nothing to ask and the player has already pressed Escape this event.
  if (!hasInput && ctx.skipMessages) {
    ctx.log('debug', 'Skipping [message] because user not interested');
    return;
  }

  // side_for= only gates messages with no input; one that asks something
  // is always put to whoever is playing (upstream routes it through the
  // synced-choice machinery instead).
  if (!hasInput && cfg.hasAttribute('side_for')) {
    const wanted = cfg
      .getString('side_for')
      .split(/[\s,]+/)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0);
    const shown = wanted.some((side) => ctx.board.teams().find((t) => t.side === side)?.controller === 'human');
    if (!shown) {
      ctx.log('debug', "Player isn't controlling side that should see [message]");
      return;
    }
  }

  const speakerAttr = cfg.getString('speaker', '');
  const narrator = speakerAttr === 'narrator';
  let speakerUnit: ReturnType<typeof findUnits>[number] | undefined;
  if (narrator) {
    speakerUnit = undefined;
  } else if (speakerAttr === 'unit') {
    speakerUnit = ctx.board.unitAt(ctx.loc1);
  } else if (speakerAttr === 'second_unit') {
    speakerUnit = ctx.board.unitAt(ctx.loc2);
  } else if (speakerAttr !== '') {
    speakerUnit = ctx.board.allUnits().find((u) => u.id === speakerAttr);
  } else {
    // No speaker=: the message's own attributes act as a unit filter, first match speaks.
    speakerUnit = findUnits(ctx.board, cfg)[0];
  }
  if (!narrator && !speakerUnit) {
    ctx.log('debug', 'No speaker found for [message]');
    return;
  }

  // get_image
  const secondImage = cfg.getString('second_image', '');
  let image = cfg.hasAttribute('image') ? cfg.getString('image') : '';
  if (speakerUnit && image === '' && secondImage === '') image = speakerUnit.portrait();
  let portrait = '';
  let leftSide = true;
  if (image !== '' && image !== 'none') {
    portrait = image;
    if (portrait.includes('~RIGHT()')) {
      leftSide = false;
      portrait = portrait.split('~RIGHT()').join('');
    }
    const imagePos = cfg.getString('image_pos', '');
    if (imagePos === 'left') leftSide = true;
    else if (imagePos === 'right') leftSide = false;
    else if (imagePos !== '') ctx.log('error', 'Invalid [message]image_pos - should be left or right');
  }

  // get_caption
  let title = cfg.hasAttribute('caption') ? cfg.getString('caption') : '';
  let titleT: TString | undefined = cfg.hasAttribute('caption') ? cfg.getTString('caption') : undefined;
  if (!cfg.hasAttribute('caption') && speakerUnit) {
    title = speakerUnit.name !== '' ? speakerUnit.name : speakerUnit.type.name;
    titleT = speakerUnit.name !== '' ? speakerUnit.translatableName : speakerUnit.type.nameT;
  }

  // message.lua: the speaker's gender picks `male_message=`/`female_message=` over `message=`; a
  // message with only gendered text and no speaker to pick by falls back to the male form.
  let bodyKey = 'message';
  if (speakerUnit && speakerUnit.gender === 'male' && cfg.hasAttribute('male_message')) bodyKey = 'male_message';
  else if (speakerUnit && speakerUnit.gender === 'female' && cfg.hasAttribute('female_message')) bodyKey = 'female_message';
  else if (!cfg.hasAttribute('message')) bodyKey = cfg.hasAttribute('male_message') ? 'male_message' : 'female_message';
  const bodyT = cfg.getTString(bodyKey) ?? TString.literal('');
  const body = bodyT.str();
  let voiceKey = 'voice';
  if (speakerUnit && speakerUnit.gender === 'male' && cfg.hasAttribute('male_voice')) voiceKey = 'male_voice';
  else if (speakerUnit && speakerUnit.gender === 'female' && cfg.hasAttribute('female_voice')) voiceKey = 'female_voice';

  const message: RecordedMessage = {
    speaker: narrator ? 'narrator' : (speakerUnit?.id ?? ''),
    message: body,
    image: cfg.hasAttribute('image') ? cfg.getString('image') : undefined,
    caption: cfg.hasAttribute('caption') ? cfg.getString('caption') : undefined,
    portrait,
    leftSide,
    mirror: cfg.getBoolean('mirror', false),
    secondPortrait: secondImage === 'none' ? '' : secondImage,
    secondMirror: cfg.getBoolean('second_mirror', false),
    title,
    speakerLocation: speakerUnit ? { x: speakerUnit.location.x, y: speakerUnit.location.y } : undefined,
    scroll: cfg.getBoolean('scroll', true),
    highlight: cfg.getBoolean('highlight', true),
    sound: cfg.getString('sound', ''),
    voice: cfg.getString(voiceKey, ''),
  };
  ctx.messages.push(message);

  const texts: MessageTexts = { body: bodyT, ...(titleT ? { title: titleT } : {}) };
  const answer = yield { kind: 'message', message, options, textInput, texts };

  // Escape on a message with nothing to answer: drop the rest of this
  // event's plain messages (`wesnoth.interface.skip_messages()`).
  if (answer.skip && !hasInput) ctx.skipMessages = true;

  if (!hasInput) return;

  ctx.choices.push({
    value: options.length > 0 ? (answer.value ?? 1) : undefined,
    text: textInput ? (answer.text ?? textInput.text) : undefined,
    side: ctx.variables.getNumber('side_number', 0),
  });

  if (textInputCfg && textInput) {
    ctx.variables.set(textInputCfg.getString('variable', 'input'), answer.text ?? textInput.text);
  }

  if (options.length === 0) return;

  const chosen = answer.value ?? 1;
  if (chosen < 1 || chosen > options.length) {
    ctx.log('debug', `invalid choice (${chosen}) was specified, choice 1 to ${options.length} was expected`);
    return;
  }
  const index = chosen - 1;

  const variableName = cfg.getString('variable', '');
  if (variableName !== '') {
    const value = optionValues[index];
    ctx.variables.set(variableName, value ?? chosen);
  }

  for (const command of optionCommands[index]!) {
    yield* runActionFlow(command, ctx);
    if (ctx.exit.type !== 'none') break;
  }
}

// --- [if] ---

function* actionIf(cfg: WmlConfig, ctx: EventContext): Flow {
  const hasBranches = cfg.hasChild('then') || cfg.hasChild('elseif') || cfg.hasChild('else');
  if (!hasBranches) {
    ctx.log('error', "[if] didn't find any [then], [elseif], or [else] children.");
    return;
  }

  if (conditionalPassed(cfg, ctx)) {
    for (const thenCfg of cfg.children('then')) {
      yield* runActionFlow(thenCfg, ctx);
      if (ctx.exit.type !== 'none') break;
    }
    return;
  }

  for (const elseifCfg of cfg.children('elseif')) {
    if (conditionalPassed(elseifCfg, ctx)) {
      for (const thenCfg of elseifCfg.children('then')) {
        yield* runActionFlow(thenCfg, ctx);
        if (ctx.exit.type !== 'none') break;
      }
      return;
    }
  }

  for (const elseCfg of cfg.children('else')) {
    yield* runActionFlow(elseCfg, ctx);
    if (ctx.exit.type !== 'none') break;
  }
}

// --- [set_variable] ---

/** Core of `[set_variable]`, factored out so `[modify_unit]` can run it against a per-unit variable store too. */
export function applySetVariable(cfg: WmlConfig, variables: VariableStore, log: EventContext['log']): void {
  const name = cfg.getString('name', '');
  if (name === '') {
    log('error', 'trying to set a variable with an empty name');
    return;
  }

  if (cfg.hasAttribute('value')) variables.set(name, cfg.getRaw('value')!);
  if (cfg.hasAttribute('literal')) variables.set(name, cfg.getRaw('literal')!);
  if (cfg.hasAttribute('to_variable')) variables.set(name, variables.get(cfg.getString('to_variable')) ?? '');
  if (cfg.hasAttribute('suffix')) variables.set(name, variables.getString(name) + cfg.getString('suffix'));
  if (cfg.hasAttribute('prefix')) variables.set(name, cfg.getString('prefix') + variables.getString(name));

  const num = (): number => variables.getNumber(name, 0);
  if (cfg.hasAttribute('add')) variables.set(name, num() + cfg.getNumber('add'));
  if (cfg.hasAttribute('sub')) variables.set(name, num() - cfg.getNumber('sub'));
  if (cfg.hasAttribute('multiply')) variables.set(name, num() * cfg.getNumber('multiply'));
  if (cfg.hasAttribute('divide')) {
    const d = cfg.getNumber('divide');
    if (d === 0) log('error', `division by zero on variable ${name}`);
    else variables.set(name, num() / d);
  }
  if (cfg.hasAttribute('modulo')) {
    const m = cfg.getNumber('modulo');
    if (m === 0) log('error', `division by zero on variable ${name}`);
    else variables.set(name, num() % m);
  }
  if (cfg.hasAttribute('abs')) variables.set(name, Math.abs(num()));
  if (cfg.hasAttribute('reverse')) variables.set(name, variables.getString(name).split('').reverse().join(''));

  if (cfg.hasAttribute('root')) {
    const rootAttr = cfg.getString('root');
    const root = rootAttr === 'square' ? 2 : rootAttr === 'cube' ? 3 : cfg.getNumber('root', 2);
    const radicand = num();
    if (radicand < 0 && root % 2 === 0) {
      log('error', `${root === 2 ? 'square' : `${root}th`} root of negative number on variable ${name}`);
    } else {
      variables.set(name, Math.sign(radicand) * Math.abs(radicand) ** (1 / root));
    }
  }
  if (cfg.hasAttribute('power')) variables.set(name, num() ** cfg.getNumber('power'));

  if (cfg.hasAttribute('round')) {
    const roundAttr = cfg.getString('round');
    const v = num();
    if (roundAttr === 'ceil') variables.set(name, Math.ceil(v));
    else if (roundAttr === 'floor') variables.set(name, Math.floor(v));
    else if (roundAttr === 'trunc') variables.set(name, Math.trunc(v));
    else {
      const decimals = cfg.getNumber('round', 0);
      const scale = 10 ** decimals;
      variables.set(name, Math.round(v * scale) / scale);
    }
  }

  if (cfg.hasAttribute('ipart')) variables.set(name, Math.trunc(cfg.getNumber('ipart')));
  if (cfg.hasAttribute('fpart')) variables.set(name, cfg.getNumber('fpart') - Math.trunc(cfg.getNumber('fpart')));

  if (cfg.hasAttribute('min')) {
    const values = cfg
      .getString('min')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n));
    if (values.length > 0) variables.set(name, Math.min(...values));
  }
  if (cfg.hasAttribute('max')) {
    const values = cfg
      .getString('max')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n));
    if (values.length > 0) variables.set(name, Math.max(...values));
  }

  if (cfg.hasAttribute('string_length')) variables.set(name, String(cfg.get('string_length')).length);

  const joinCfg = cfg.child('join');
  if (joinCfg) {
    const arrayName = joinCfg.getString('variable', '');
    const separator = joinCfg.getString('separator', '');
    const keyName = joinCfg.getString('key', 'value');
    const removeEmpty = joinCfg.getBoolean('remove_empty', false);
    const parts: string[] = [];
    for (const elem of variables.getArray(arrayName)) {
      const raw = elem.attrs.get(keyName);
      const v = raw === undefined ? undefined : plainValue(raw);
      if (v === undefined && removeEmpty) continue;
      parts.push(v === undefined ? '' : String(v));
    }
    variables.set(name, parts.join(separator));
  }

  // `rand=` is handled by `actionSetVariable` above, which has the
  // context (and so the RNG) this shared helper deliberately does not.
  // NOT ported: `rand=` here (needs the shared RNG, owned by packages/engine/src/rng/, out of
  // scope here), `formula=` (would need a `value`-bound WFL context; skipped for now),
  // `time=stamp` (no wall-clock concept in a deterministic headless engine).
}

/**
 * `rand=`'s own little grammar (`mathx.random_choice`): a comma-separated
 * list whose entries are either literal values or `A..B` numeric ranges,
 * picked from uniformly over every possibility -- so `rand="1..4"` is one
 * of four numbers and `rand="a,1..3"` is one of four choices, not two.
 */
function randomChoice(spec: string, rng: Rng): string {
  const entries: Array<{ from: number; to: number } | string> = [];
  let total = 0;
  for (const raw of spec.split(',')) {
    const token = raw.trim();
    const range = /^(-?\d+)\.\.(-?\d+)$/.exec(token);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      entries.push({ from: lo, to: hi });
      total += hi - lo + 1;
    } else {
      entries.push(token);
      total += 1;
    }
  }
  if (total === 0) return '';

  let pick = rng.getRandomInt(0, total - 1);
  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (pick === 0) return entry;
      pick -= 1;
    } else {
      const size = entry.to - entry.from + 1;
      if (pick < size) return String(entry.from + pick);
      pick -= size;
    }
  }
  return '';
}

function actionSetVariable(cfg: WmlConfig, ctx: EventContext): void {
  // `rand=` needs the session RNG, which `applySetVariable` (shared with
  // `[modify_unit]`'s per-unit variable bag) has no access to.
  if (cfg.hasAttribute('rand')) {
    const name = cfg.getString('name', '');
    if (name === '') {
      ctx.log('error', '[set_variable] with rand= but no name=');
      return;
    }
    if (!ctx.rng) {
      ctx.log('warn', '[set_variable] rand= needs a game RNG -- ignored');
      return;
    }
    const chosen = randomChoice(cfg.getString('rand'), ctx.rng);
    const asNumber = Number(chosen);
    ctx.variables.set(name, chosen !== '' && !Number.isNaN(asNumber) ? asNumber : chosen);
    return;
  }
  applySetVariable(cfg, ctx.variables, ctx.log);
}

// --- [set_variables] ---

/**
 * `data/lua/wml/set_variables.lua`. The data is `to_variable=`'s array, or else one element per `[value]`
 * (`wml.parsed`), `[literal]` (unsubstituted) and `[split]` piece, in order. `name=foo[3]` starts the operation
 * at that element. The modes are `wml.merge`'s (`intf_wml_merge`) over the arrays as `[value]` children:
 * `replace` clears them and takes the data (only when there is any data), `append` adds the data after them,
 * `merge` merges element i of the data into element i (`config::merge_with`); `insert` inserts the data at the
 * index (the front, with none).
 */
function actionSetVariables(cfg: WmlConfig, ctx: EventContext): void {
  const name = cfg.getString('name', '');
  if (name === '') {
    ctx.log('error', 'trying to set a variable with an empty name');
    return;
  }
  let data: VarNode[] = [];
  const toVariable = cfg.getString('to_variable', '');
  if (toVariable !== '') {
    data = ctx.variables.getArray(toVariable).map(cloneVarNode);
  } else {
    for (const { tag, config } of cfg.allChildren()) {
      if (tag === 'value') data.push(varNodeFromConfig(ctx.variables.expandConfigDeep(config)));
      else if (tag === 'literal') data.push(varNodeFromConfig(config));
      else if (tag === 'split') {
        const split = ctx.variables.expandConfig(config);
        const separator = split.getString('separator', '');
        const key = split.getString('key', '');
        // Without a separator, upstream iterates the string with `ipairs`, which yields nothing.
        if (!split.hasAttribute('separator')) continue;
        if (separator.length > 1) {
          ctx.log('error', `[set_variables] [split] separator only supports 1 character, multiple passed: ${separator}`);
          return;
        }
        const removeEmpty = split.getBoolean('remove_empty', false);
        // `stringx.split(list, separator, {remove_empty, strip_spaces = true})`.
        for (const piece of split.getString('list', '').split(separator).map((p) => p.trim())) {
          if (removeEmpty && piece === '') continue;
          const node = newVarNode();
          node.attrs.set(key, piece);
          data.push(node);
        }
      }
    }
  }
  const mode = cfg.getString('mode', 'replace');
  const indexed = /^(.*)\[(\d+)\]$/.exec(name);
  const realVar = indexed ? indexed[1]! : name;
  const idx = indexed ? Number(indexed[2]) : 0;
  const existing = ctx.variables.getArray(realVar).map(cloneVarNode);
  if (mode === 'merge' || mode === 'append' || mode === 'replace') {
    let head: VarNode[] = [];
    let mergeWith = existing;
    if (indexed) {
      head = existing.slice(0, idx);
      mergeWith = existing.slice(idx);
      if (mode === 'merge') {
        // All the values are merged together (`append` mode) before being merged into the element.
        const merged = newVarNode();
        for (const item of data) mergeVarNode(merged, item, true);
        data = [merged];
      } else if (mode === 'replace') {
        // Elements after the index are pushed up but otherwise left untouched.
        data = [...data, ...mergeWith.slice(1)];
      }
    }
    let merged: VarNode[];
    if (mode === 'append') merged = [...mergeWith, ...data];
    else if (mode === 'replace') merged = data.length > 0 ? data : mergeWith;
    else merged = mergeArrays(mergeWith, data);
    ctx.variables.setArray(realVar, [...head, ...merged]);
  } else if (mode === 'insert') {
    existing.splice(idx, 0, ...data);
    ctx.variables.setArray(realVar, existing);
  } else {
    ctx.log('error', `unknown mode for [set_variables]: ${mode}`);
  }
}

/** `config::merge_with` over one tag's children: element i merges into element i, `__remove=yes` drops it, extras are appended. */
function mergeArrays(base: VarNode[], from: VarNode[]): VarNode[] {
  const out: VarNode[] = [];
  base.forEach((item, i) => {
    const with_ = from[i];
    if (!with_) out.push(item);
    else if (!isTruthy(with_.attrs.get('__remove'))) {
      mergeVarNode(item, with_, false);
      out.push(item);
    }
  });
  for (let i = base.length; i < from.length; i++) out.push(cloneVarNode(from[i]!));
  return out;
}

/** `config::merge_with` (`append`: `merge_attributes` + `append_children`) of `from` into `into`. */
function mergeVarNode(into: VarNode, from: VarNode, append: boolean): void {
  for (const [k, v] of from.attrs) into.attrs.set(k, v);
  for (const [tag, arr] of from.arrays) {
    const mine = into.arrays.get(tag) ?? [];
    into.arrays.set(tag, append ? [...mine, ...arr.map(cloneVarNode)] : mergeArrays(mine, arr));
  }
}

function isTruthy(v: WmlStoredValue | undefined): boolean {
  return v === true || v === 'yes' || v === 'true';
}

// --- [clear_variable] ---

function actionClearVariable(cfg: WmlConfig, ctx: EventContext): void {
  const names = cfg.getString('name', '');
  if (names === '') {
    ctx.log('error', '[clear_variable] missing required name= attribute.');
    return;
  }
  for (const n of names.split(',')) {
    ctx.variables.clear(n.trim());
  }
}

// --- [store_unit] ---

export function unitToVarNode(unit: Unit): VarNode {
  const node = newVarNode();
  node.attrs.set('type', unit.type.id);
  node.attrs.set('id', unit.id);
  node.attrs.set('name', unit.name);
  node.attrs.set('side', unit.side);
  if (unit.location.valid()) {
    node.attrs.set('x', unit.location.wmlX);
    node.attrs.set('y', unit.location.wmlY);
  } else {
    node.attrs.set('x', 'recall');
    node.attrs.set('y', 'recall');
  }
  node.attrs.set('hitpoints', unit.hitpoints);
  node.attrs.set('max_hitpoints', unit.maxHitpoints);
  node.attrs.set('moves', unit.movesLeft);
  node.attrs.set('max_moves', unit.maxMoves);
  node.attrs.set('experience', unit.experience);
  node.attrs.set('max_experience', unit.maxExperience);
  node.attrs.set('level', unit.level);
  node.attrs.set('canrecruit', unit.canRecruit);
  node.attrs.set('resting', unit.resting);
  if (unit.variables) {
    const varsNode = varNodeFromConfig(unit.variables);
    if (varsNode.attrs.size > 0 || varsNode.arrays.size > 0) {
      node.arrays.set('variables', [varsNode]);
    }
  }
  return node;
}

function actionStoreUnit(cfg: WmlConfig, ctx: EventContext): void {
  const filterCfg = cfg.child('filter');
  if (!filterCfg) {
    ctx.log('error', '[store_unit] missing required [filter] tag');
    return;
  }
  const kill = cfg.getBoolean('kill', false);
  const variable = cfg.getString('variable', 'unit');
  const xStr = filterCfg.getString('x', '');
  const yStr = filterCfg.getString('y', '');
  const includeRecall = xStr === 'recall' && yStr === 'recall';
  const units = findUnits(ctx.board, ctx.variables.expandConfig(filterCfg), includeRecall);

  const mode = cfg.getString('mode', 'always_clear');
  if (mode === 'append') {
    for (const u of units) ctx.variables.pushArray(variable, unitToVarNode(u));
  } else {
    ctx.variables.setArray(
      variable,
      units.map((u) => unitToVarNode(u)),
    );
  }

  if (kill) {
    for (const u of units) {
      if (u.location.valid()) ctx.board.removeUnitAt(u.location);
    }
  }
}

// --- [unstore_unit] ---

/**
 * Real, reported bug: Liberty scenario 1's `[store_unit] variable=
 * goodguys_store kill=yes [filter] side=1 [/filter] [/store_unit]` (hiding
 * Baldras off-board during the opening goblin conversation, a common real
 * WML idiom for a cutscene) has a matching `[unstore_unit] variable=
 * goodguys_store [/unstore_unit]` a few lines later meant to put him right
 * back -- but this tag was never registered as an action handler at all, so
 * `runActionSequence` silently skipped it (a `[tag] not supported` warn
 * log). Baldras stayed permanently removed: the scenario's own leader unit
 * was simply absent from the board for the entire rest of the playthrough,
 * making it unplayable (no unit to select/move/recruit with). Discovered
 * investigating a "white circle units that can't move" bug report -- the
 * OTHER half of that report was `[base_unit]` (see UnitTypeDatabase.ts's
 * fix, same session), but this is a distinct, more severe issue underneath.
 *
 * Ports `data/lua/wml-tags.lua`'s `wml_actions.unstore_unit`: reads the
 * stored unit config back out of `variable=` (the container-node rules --
 * implicit index 0 for a plain array-variable name, explicit `foo[n]`
 * otherwise -- are the same ones `[store_unit]`'s own `variable=` uses, see
 * `VariableStore.getContainerNode`), rebuilds a real `Unit` from it via the
 * exact same `Unit.fromConfig` path `[unit]` uses (their config shapes are
 * exact duals: `unitToVarNode` writes precisely the attributes
 * `Unit.fromConfig` reads), and places it at `x=`/`y=` if given, else the
 * unit's own stored position (matching upstream's `x = cfg.x or unit.x`).
 *
 * NOT ported: `advance=`/`animate=`/`text=`/`color=` (cosmetic-only, no
 * headless effect -- consistent with this file's other no-op cosmetic
 * tags), `find_vacant=`/`check_passability=` (no real content exercised so
 * far needs a vacant-hex fallback here), and restoring to a recall list
 * (`x,y=recall,recall` -- Liberty's own usage always restores to the map).
 * Also inherits `[store_unit]`'s own gap: `unitToVarNode` doesn't serialize
 * `[modifications]`, so a unit's `[object]` effects (Baldras's own
 * `mace-spiked` weapon override, granted in his `[side]` block) are lost
 * across a store/kill/unstore round-trip -- a real but lower-severity gap
 * than the unit being missing entirely, not fixed here.
 */
function actionUnstoreUnit(cfg: WmlConfig, ctx: EventContext): void {
  const variable = cfg.getString('variable', '');
  if (!variable) {
    ctx.log('error', '[unstore_unit] missing required variable= attribute');
    return;
  }
  const node = ctx.variables.getContainerNode(variable, false);
  if (!node || node.attrs.size === 0) {
    ctx.log('error', `[unstore_unit]: variable '${variable}' doesn't contain unit data`);
    return;
  }
  const unitCfg = varNodeToConfig(node);
  let unit: Unit;
  try {
    unit = Unit.fromConfig(unitCfg, ctx.resolveType);
  } catch (e) {
    ctx.log('error', `Error occurred inside [unstore_unit]: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (cfg.hasAttribute('x') && cfg.hasAttribute('y')) {
    unit.location = Location.fromConfig(cfg);
  }
  if (!unit.location.valid()) {
    ctx.log('error', "[unstore_unit]: stored unit has no valid location (recall-list restore isn't supported)");
    return;
  }
  ctx.board.addUnit(unit);
  ctx.board.captureVillage(unit.location, unit.side);
}

// --- [kill] ---

function* actionKill(cfg: WmlConfig, ctx: EventContext): Flow {
  if (cfg.hasChild('filter')) {
    ctx.log('error', 'Tag [filter] may not be used in [kill]');
    return;
  }
  const fireEvent = cfg.getBoolean('fire_event', false);
  const animate = cfg.getBoolean('animate', false);
  const secondaryCfg = cfg.child('secondary_unit');
  const secondary = secondaryCfg ? findUnits(ctx.board, ctx.variables.expandConfig(secondaryCfg))[0] : undefined;

  const doomed = findUnits(ctx.board, cfg);
  let killedCount = 0;
  for (const unit of doomed) {
    const deathLoc = unit.location;
    const killerLoc = secondary ? secondary.location : deathLoc;
    unit.hitpoints = 0;
    // Phase 17: upstream's own order (`data/lua/wml/kill.lua`) -- 'last
    // breath', then the death animation, then 'die', and only then the
    // unit is erased, each event drained completely before the next step.
    // Until the pump could suspend, this port could only `raise` both
    // (draining after the whole action sequence), so a 'die' handler saw
    // the unit already gone from the board.
    if (fireEvent) yield* ctx.fireNow('last breath', deathLoc, killerLoc);
    if (animate && deathLoc.valid() && ctx.board.unitAt(deathLoc) === unit) {
      yield* playBeat({ kind: 'unitDeath', unit, scroll: cfg.getBoolean('scroll', true) });
    }
    if (fireEvent) yield* ctx.fireNow('die', deathLoc, killerLoc);
    // "if it's still on the map" -- an event above may have erased or
    // moved it (`unit.valid == "map"` upstream).
    if (deathLoc.valid() && ctx.board.unitAt(deathLoc) === unit) ctx.board.removeUnitAt(deathLoc);
    killedCount++;
  }

  const xStr = cfg.getString('x', '');
  const yStr = cfg.getString('y', '');
  if ((xStr === 'recall' || xStr === '') && (yStr === 'recall' || yStr === '')) {
    for (const team of ctx.board.teams()) {
      const list = ctx.board.recallList(team.side).filter((u) => unitMatchesFilter(u, cfg));
      for (const u of list) {
        ctx.board.removeFromRecallList(team.side, u.underlyingId);
        killedCount++;
      }
    }
  }
  void killedCount;
}

// --- [modify_unit] ---

const MODIFY_UNIT_FIELDS: Record<string, (u: Unit, cfg: WmlConfig, key: string) => void> = {
  hitpoints: (u, cfg) => (u.hitpoints = cfg.getNumber('hitpoints', u.hitpoints)),
  max_hitpoints: (u, cfg) => (u.maxHitpoints = cfg.getNumber('max_hitpoints', u.maxHitpoints)),
  moves: (u, cfg) => (u.movesLeft = cfg.getNumber('moves', u.movesLeft)),
  max_moves: (u, cfg) => (u.maxMoves = cfg.getNumber('max_moves', u.maxMoves)),
  experience: (u, cfg) => (u.experience = cfg.getNumber('experience', u.experience)),
  max_experience: (u, cfg) => (u.maxExperience = cfg.getNumber('max_experience', u.maxExperience)),
  side: (u, cfg) => (u.side = cfg.getNumber('side', u.side)),
  canrecruit: (u, cfg) => (u.canRecruit = cfg.getBoolean('canrecruit', u.canRecruit)),
  name: (u, cfg) => (u.name = cfg.getString('name', u.name)),
  role: (u, cfg) => (u.role = cfg.getString('role', u.role)),
};

function actionModifyUnit(cfg: WmlConfig, ctx: EventContext): void {
  const filterCfg = cfg.child('filter');
  if (!filterCfg) {
    ctx.log('error', '[modify_unit] missing required [filter] tag');
    return;
  }
  const units = findUnits(ctx.board, ctx.variables.expandConfig(filterCfg));

  for (const unit of units) {
    for (const key of Object.keys(MODIFY_UNIT_FIELDS)) {
      if (cfg.hasAttribute(key)) MODIFY_UNIT_FIELDS[key]!(unit, cfg, key);
    }
    if (cfg.hasAttribute('facing')) {
      unit.facing = parseDirection(cfg.getString('facing'));
    }

    const unitVars = new VariableStore(unit.variables ? varNodeFromConfig(unit.variables) : newVarNode());
    const subCtx: EventContext = { ...ctx, variables: unitVars };
    for (const { tag, config } of cfg.allChildren()) {
      if (tag === 'filter') continue;
      const expanded = ctx.variables.expandConfig(config);
      if (tag === 'set_variable') applySetVariable(expanded, unitVars, ctx.log);
      else if (tag === 'set_variables') actionSetVariables(expanded, subCtx);
      else if (tag === 'clear_variable') actionClearVariable(expanded, subCtx);
      else if (tag === 'object' || tag === 'trait' || tag === 'advancement') {
        // modify_unit.lua: unit:add_modification(tag, wml.parsed/literal(child)).
        unit.addModification(tag, modificationBody(config, ctx), effectEnvFor(ctx, unit));
      } else if (tag === 'effect') {
        // modify_unit.lua: wesnoth.effects[apply_to](unit, effect) -- applied, not recorded.
        const wrapper = new WmlConfig();
        wrapper.addChild('effect', expanded);
        const before = unit.modifications;
        unit.addModification('object', wrapper, effectEnvFor(ctx, unit));
        unit.modifications = before;
      }
    }
    unit.variables = unitVars.toConfig();
  }
}

// --- runtime events: [event], [remove_event] (Phase 18c) ---

/**
 * `wml_actions.event` (`wml-tags.lua`) -> `wesnoth.game_events.add_wml`:
 * an `[event]` inside an event body registers a new handler. Stored as
 * written unless `delayed_variable_substitution=no`, in which case its
 * variables are substituted now. The deprecated `remove=yes` form removes
 * by id instead.
 */
function actionEvent(cfg: WmlConfig, ctx: EventContext): void {
  if (ctx.variables.expandConfig(cfg).getBoolean('remove', false)) {
    actionRemoveEvent(ctx.variables.expandConfig(cfg), ctx);
    return;
  }
  const delayed = cfg.getBoolean('delayed_variable_substitution', true);
  const handler = delayed ? cfg.clone() : ctx.variables.expandConfigDeep(cfg);
  if (!ctx.addEvent(handler)) ctx.log('debug', `[event] ${handler.getString('name', '')} id=${handler.getString('id', '')} not added (duplicate id, or no name)`);
}

/** `wml_actions.remove_event`: every handler whose id is in `id=` (a comma list) is removed. */
function actionRemoveEvent(cfg: WmlConfig, ctx: EventContext): void {
  const ids = cfg.getString('id', '');
  if (ids === '') {
    ctx.log('error', '[remove_event] missing required id= key');
    return;
  }
  for (const id of ids.split(',').map((v) => v.trim()).filter((v) => v !== '')) ctx.removeEvent(id);
}

// --- unit modifications: [object], [remove_object], [remove_trait], [transform_unit] (Phase 18c) ---

/** What `[effect]`s applied from an event resolve against: this board, this scenario's types, the unit's side's recall cost. */
export function effectEnvFor(ctx: EventContext, unit?: Unit): EffectEnv {
  return {
    board: ctx.board,
    resolveType: ctx.resolveType,
    teamRecallCost: unit ? ctx.board.getTeam(unit.side)?.recallCost : undefined,
    log: (message) => ctx.log('warn', message),
  };
}

/** `wml.parsed` unless `delayed_variable_substitution=yes` (`wml.literal`): how a modification is stored. */
function modificationBody(cfg: WmlConfig, ctx: EventContext): WmlConfig {
  return cfg.getBoolean('delayed_variable_substitution', false) ? cfg.clone() : ctx.variables.expandConfigDeep(cfg);
}

/** `gui.show_popup(name, text, image)`, as the message dialogue this port has. */
function* popupFlow(ctx: EventContext, title: string, text: string, image: string): Flow {
  const message: RecordedMessage = {
    speaker: 'narrator',
    message: text,
    image: image === '' ? undefined : image,
    caption: title,
    portrait: image,
    leftSide: true,
    mirror: false,
    secondPortrait: '',
    secondMirror: false,
    title,
    speakerLocation: undefined,
    scroll: false,
    highlight: false,
    sound: '',
    voice: '',
  };
  ctx.messages.push(message);
  yield { kind: 'message', message, options: [] };
}

/**
 * `wml_actions.object` (`data/lua/wml/object.lua`): gives the first unit
 * matching `[filter]` (or the event's unit) the object -- a modification
 * whose `[effect]`s apply at once and last per `duration=` -- unless an
 * object with this `id=` was already taken (`take_only_once`, default yes).
 * Then shows its description (or `cannot_use_message=`) unless silent, and
 * runs `[then]` or, when no unit took it, `[else]`.
 */
function* actionObject(cfg: WmlConfig, ctx: EventContext): Flow {
  const unique = cfg.getBoolean('take_only_once', true);
  const id = cfg.getString('id', '');
  if (id !== '' && unique && ctx.usedItems.has(id)) return;

  const filter = cfg.child('filter');
  const unit = filter ? findUnits(ctx.board, ctx.variables.expandConfig(filter))[0] : ctx.board.unitAt(ctx.loc1);
  const text = unit ? cfg.getString('description', '') : cfg.getString('cannot_use_message', '');
  const silent = cfg.hasAttribute('silent') ? cfg.getBoolean('silent') : text === '';

  if (unit) {
    const body = modificationBody(cfg, ctx);
    if (cfg.getBoolean('no_write', false)) {
      // Deprecated upstream: the effects apply, the object is not recorded.
      const scratch = body.clone();
      const before = unit.modifications;
      unit.addModification('object', scratch, effectEnvFor(ctx, unit));
      unit.modifications = before;
    } else {
      unit.addModification('object', body, effectEnvFor(ctx, unit));
    }
    if (id !== '' && unique) ctx.usedItems.add(id);
  }
  if (!silent) yield* popupFlow(ctx, cfg.getString('name', ''), text, cfg.getString('image', ''));

  for (const branch of cfg.children(unit ? 'then' : 'else')) {
    yield* runActionFlow(branch, ctx);
    if (ctx.exit.type !== 'none') break;
  }
}

/** `wml_actions.remove_object`: every matching unit loses its `object_id=` objects and is rebuilt. */
function actionRemoveObject(cfg: WmlConfig, ctx: EventContext): void {
  const id = cfg.getString('object_id', '');
  for (const unit of findUnits(ctx.board, cfg)) unit.removeModifications(id === '' ? {} : { id }, ['object'], effectEnvFor(ctx, unit));
}

/** `wml_actions.remove_trait`: every matching unit loses the `trait_id=` trait and is rebuilt. */
function actionRemoveTrait(cfg: WmlConfig, ctx: EventContext): void {
  const id = cfg.getString('trait_id', '');
  for (const unit of findUnits(ctx.board, cfg)) unit.removeModifications(id === '' ? {} : { id }, ['trait'], effectEnvFor(ctx, unit));
}

/**
 * `wml_actions.transform_unit`: each matching unit becomes `transform_to=`
 * (`unit:transform` -> `advance_to`, keeping its traits and objects). With
 * no `transform_to=`, upstream levels the unit up in place keeping its hit
 * points and experience; that path advances to its first `advances_to=`.
 */
function actionTransformUnit(cfg: WmlConfig, ctx: EventContext): void {
  const to = cfg.getString('transform_to', '');
  for (const unit of findUnits(ctx.board, cfg)) {
    const env = effectEnvFor(ctx, unit);
    if (to !== '') {
      let type;
      try {
        type = ctx.resolveType(to);
      } catch {
        ctx.log('error', `[transform_unit]: unknown unit type '${to}'`);
        return;
      }
      unit.advanceTo(type, env);
      continue;
    }
    const next = unit.advancesTo[0];
    if (!next) continue;
    const hitpoints = unit.hitpoints;
    const experience = unit.experience;
    unit.advanceTo(ctx.resolveType(next), env);
    unit.hitpoints = Math.min(hitpoints, unit.maxHitpoints);
    unit.experience = experience;
  }
}

// --- [unit] ---

/**
 * Port of `unit_creator::find_location` (`actions/unit_creator.cpp:100-163`):
 * where a `[unit]` actually lands.
 *
 * The important part is the default: `overwrite=` is **no**, so a hex
 * that already has someone on it sends the new unit to the nearest
 * vacant tile instead of replacing the occupant. Real, reported bug:
 * this port used to place the unit straight onto the requested hex, so
 * Under the Burning Suns 1 -- whose village events rescue a random elf
 * with `[unit] x,y=$x1,$y1`, i.e. onto the very hex the rescuer is
 * standing on -- deleted the unit that had just entered the village
 * (Kaleh, usually) and left the rescued elf in his place.
 *
 * `placement=` is walked in order and always falls back to `map` then
 * `recall`, as upstream; `passable=yes` makes the vacant-tile search
 * avoid terrain this unit cannot enter. Not ported: `location_id=`
 * (this port's `GameMap` has no named special locations yet).
 */
function placeNewUnit(cfg: WmlConfig, ctx: EventContext, unit: Unit, side: number): Location | undefined {
  const passable = cfg.getBoolean('passable', false);
  const vacant = !cfg.getBoolean('overwrite', false);
  const placements = cfg
    .getString('placement', '')
    .split(/[\s,]+/)
    .filter((p) => p !== '');

  for (const place of [...placements, 'map', 'recall']) {
    if (place === 'recall') return undefined;

    let loc = Location.NULL;
    if (place === 'leader' || place === 'leader_passable') {
      const leader = ctx.board.unitsForSide(side).find((u) => u.canRecruit);
      loc = leader ? leader.location : ctx.board.map.startingPosition(side);
    } else if (place === 'map' || place === 'map_passable' || place === 'map_overwrite') {
      loc = unit.location;
    } else {
      continue; // an unknown placement is simply skipped, as upstream's own loop does
    }

    const passCheck = passable || place === 'leader_passable' || place === 'map_passable' ? unit : undefined;
    const mustBeVacant = vacant && place !== 'map_overwrite';
    if (loc.valid() && ctx.board.map.onBoard(loc)) {
      const placed = mustBeVacant ? findVacantTile(ctx.board, loc, { passCheck }) : loc;
      if (placed && placed.valid() && ctx.board.map.onBoard(placed)) return placed;
    }
  }
  return undefined;
}

/**
 * A new real unit's creation-time draws (`unit::init(cfg)`), folded into its
 * config before it is built -- so the traits take effect and every override
 * the config gives (`max_hitpoints=`, `hitpoints=`) still applies on top, in
 * upstream's order: a random gender only with `random_gender=yes`, traits
 * unless `random_traits=no` (the config's own `[modifications]` traits
 * count), a name unless it has one or `generate_name=no`.
 */
function withCreationRolls(cfg: WmlConfig, ctx: EventContext): WmlConfig {
  if (!ctx.rng) return cfg;
  const typeId = cfg.hasAttribute('parent_type') ? cfg.getString('parent_type') : cfg.getString('type');
  const type = ctx.resolveType(typeId).variation(cfg.getString('variation', ''));
  const existing = cfg.children('modifications').flatMap((m) => m.children('trait').map((t) => ({ kind: 'trait', cfg: t })));
  const { gender, traits } = rollNewUnit(type, ctx.rng, {
    ...(cfg.hasAttribute('gender') ? { gender: cfg.getString('gender') } : {}),
    randomGender: cfg.getBoolean('random_gender', false),
    existing,
    randomTraits: cfg.getBoolean('random_traits', true),
    canRecruit: cfg.getBoolean('canrecruit', false),
    named: cfg.getString('name', '') !== '' || !cfg.getBoolean('generate_name', true),
  });
  const out = cfg.clone();
  out.setAttribute('gender', gender);
  if (traits.length > 0) {
    const mods = out.child('modifications') ?? out.addChild('modifications');
    for (const t of traits) mods.addChild('trait', t.cfg);
  }
  return out;
}

function* actionUnit(cfg: WmlConfig, ctx: EventContext): Flow {
  const side = cfg.getNumber('side', 1);
  const team = ctx.board.getTeam(side);
  if (!team) {
    ctx.log('error', `wrong side in [unit] tag - no such side: ${side}`);
    return;
  }
  let unit: Unit;
  try {
    unit = Unit.fromConfig(withCreationRolls(cfg, ctx), ctx.resolveType);
  } catch (e) {
    ctx.log('error', `Error occurred inside [unit]: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  ctx.board.assignUnitId(unit);
  const placed = placeNewUnit(cfg, ctx, unit, side);
  if (placed) {
    unit.location = placed;
    ctx.board.addUnit(unit);
    // Mirrors real `unit_creator`'s default `allow_get_village=true` --
    // an event-spawned unit placed directly onto a village captures it,
    // same as a `[side]`/scenario-level `[unit]` present at scenario
    // start (see `GameBoard.fromConfig`'s own capture calls).
    ctx.board.captureVillage(unit.location, side);
    // `animate=yes`: the unit fades in where it lands, as
    // `unit_creator::post_create` does via `unit_display::unit_recruited`.
    if (cfg.getBoolean('animate', false)) yield* playBeat({ kind: 'unitAppear', unit });
  } else {
    // No hex to place it on: onto the side's recall list, as
    // `unit_creator::add_unit`'s `allow_add_to_recall(true)` path does.
    // This is also what `[unit] x=recall y=recall` asks for outright.
    ctx.board.addToRecallList(side, unit);
  }
}

// --- side/team helpers shared by [gold]/[store_gold]/[allow_recruit] ---

/** `side_filter` over the tag's config (`wesnoth.sides.find(cfg)`): every side when it names none. */
function findSides(ctx: EventContext, cfg: WmlConfig): number[] {
  return sidesFor(ctx.variables.expandConfigDeep(cfg), ctx);
}

function actionGold(cfg: WmlConfig, ctx: EventContext): void {
  if (!cfg.hasAttribute('amount')) {
    ctx.log('error', '[gold] missing required amount= attribute.');
    return;
  }
  const amount = Math.floor(cfg.getNumber('amount'));
  for (const side of findSides(ctx, cfg)) {
    const team = ctx.board.getTeam(side);
    if (team) team.gold += amount;
  }
}

function actionStoreGold(cfg: WmlConfig, ctx: EventContext): void {
  const side = findSides(ctx, cfg)[0];
  const team = side !== undefined ? ctx.board.getTeam(side) : undefined;
  if (team) ctx.variables.set(cfg.getString('variable', 'gold'), team.gold);
}

function actionAllowRecruit(cfg: WmlConfig, ctx: EventContext): void {
  if (!cfg.hasAttribute('type')) {
    ctx.log('error', '[allow_recruit] missing required type= attribute');
    return;
  }
  const types = cfg
    .getString('type')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const side of findSides(ctx, cfg)) {
    const team = ctx.board.getTeam(side);
    if (!team) continue;
    for (const t of types) team.canRecruit.add(t);
  }
}

/**
 * Mirrors `wml_actions.disallow_recruit` (`data/lua/wml-tags.lua`): takes
 * `type=`'s types off each matching side's recruit list, or empties the
 * list when no `type=` is given. `LIMIT_RECRUITS` (Dead Water 1's "three of
 * each level 1 unit") relies on it.
 */
function actionDisallowRecruit(cfg: WmlConfig, ctx: EventContext): void {
  const types = cfg.hasAttribute('type')
    ? cfg
        .getString('type')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : null;
  for (const side of findSides(ctx, cfg)) {
    const team = ctx.board.getTeam(side);
    if (!team) continue;
    if (types) for (const t of types) team.canRecruit.delete(t);
    else team.canRecruit.clear();
  }
}

/**
 * Mirrors `wml_actions.capture_village` (`data/lua/wml-tags.lua`): assigns
 * every village matching the location filter (`cfg` itself, same
 * top-level x=/y= convention as `[filter_location]`) to `side=`. `side=0`
 * (or omitted, which resolves to 0 below) neutralises rather than
 * assigning to a nonexistent side, matching `GameBoard.captureVillage`'s
 * own `side <= 0` handling.
 *
 * Deliberately NOT ported: `[filter_side]` (pick the side by SSF instead
 * of a literal `side=` number) and `fire_event=` (upstream's own comment
 * on this notes fire_event "doesn't currently exist but probably should
 * someday" for `set_owner` itself -- the real `capture`/`village capture`
 * WML event isn't fired by this action either way yet, see
 * `move.ts`/`GameBoard.captureVillage`'s own doc comments on that gap).
 */
function actionCaptureVillage(cfg: WmlConfig, ctx: EventContext): void {
  if (!cfg.hasAttribute('side')) {
    ctx.log('warn', '[capture_village] without side= (or [filter_side], not yet supported) is a no-op');
    return;
  }
  const side = cfg.getNumber('side', 0);
  for (const loc of ctx.board.map.villages) {
    if (locationMatchesFilter(loc, cfg)) {
      ctx.board.captureVillage(loc, side);
    }
  }
}

/**
 * Mirrors `WML_HANDLER_FUNCTION(recall, ...)` (`src/game_events/
 * action_wml.cpp`): finds the first recall-list unit (searched across
 * every side's list, in side order -- matching upstream's `for (team& t :
 * resources::gameboard->teams())` outer loop) matching `cfg` as a SUF
 * (including the already-ported `x,y=recall,recall` convention -- see
 * `filter.ts`'s `unitMatchesFilter`), then places it via the same
 * leader/vacancy search `checkRecruitLocation` already does for the
 * player-facing recall UI, falling back to any vacant castle tile
 * connected to any able leader's keep when `cfg` doesn't specify (or its
 * requested) x=/y=.
 *
 * Deliberately NOT ported (matching `recruit.ts`'s own documented
 * simplifications for the same reasons): `[secondary_unit]` (restricting
 * *which* leader may recall the match), per-leader `recall_filter=`,
 * `location_id=`, `check_passability=` (`canUse` is always permissive,
 * `checkRecruitLocation` always passability-checks via
 * `findVacantCastleTile`), and `show=`/`fire_event=` (headless; no
 * display, and the `recall` WML event isn't fired by this port's event
 * pump for any recall path yet, player-driven or scripted).
 */
function actionRecall(cfg: WmlConfig, ctx: EventContext): void {
  const board = ctx.board;
  // `x=`/`y=` on [recall] are the DESTINATION, not a unit-filter criterion
  // -- mirrors upstream's own `temp_config["x"] = "recall"` trick (its
  // comment: "Prevent the recall unit filter from using the location as a
  // criterion"). Recall-list units have no board location, so leaving
  // x=/y= in the filter would make `unitMatchesFilter`'s ordinary
  // (non-"recall") x=/y= range check spuriously reject every candidate.
  const unitFilterCfg = new WmlConfig();
  for (const name of cfg.attributeNames()) {
    if (name === 'x' || name === 'y') continue;
    unitFilterCfg.setAttribute(name, cfg.getString(name));
  }
  for (const { tag, config } of cfg.allChildren()) unitFilterCfg.addChild(tag, config);

  for (const team of board.teams()) {
    const list = board.recallList(team.side);
    const index = list.findIndex((u) => unitMatchesFilter(u, unitFilterCfg, board));
    if (index === -1) continue;
    const unit = list[index]!;

    const preferredLoc = Location.fromConfig(cfg);
    const { result, location, leader } = checkRecruitLocation(board, team.side, preferredLoc, preferredLoc, () => true);
    if (result === 'no_leader' || result === 'no_able_leader' || result === 'no_keep_leader' || result === 'no_vacancy') {
      ctx.log('warn', `[recall] found ${unit.id || unit.type.id} on side ${team.side}'s recall list but no legal leader/location (${result})`);
      return;
    }

    // Splices `list` (the board's own live recall-list array) directly by
    // the index just found, NOT `GameBoard.removeFromRecallList`'s
    // `underlyingId`-keyed lookup -- this project doesn't auto-assign
    // unique `underlying_id`s (see `Unit.ts`), so several recall-list
    // entries commonly share `underlyingId=0`, and removing "whichever
    // entry has underlyingId=0" would silently splice out the WRONG unit
    // whenever one comes before the one this filter actually matched.
    // Mirrors `GameSession.tryRecallAt`'s own doc comment on the same
    // trap, in the player-facing recall UI.
    list.splice(index, 1);
    const facing = cfg.hasAttribute('facing') ? parseDirection(cfg.getString('facing')) : undefined;
    recallUnit(board, team, unit, location, leader?.location ?? location, facing);
    return;
  }
  ctx.log('warn', '[recall]: no recall-list unit on any side matched the filter');
}

// --- [role] ---

/**
 * `data/lua/wml/role.lua`: gives `role=` to the first unit the rest of the
 * tag matches -- on the map first, then on the recall lists, trying each
 * `type=` in the order given -- and `[auto_recall]` recalls a recall-list
 * match. `reassign=no` keeps an existing holder of the role. When no unit
 * matches, the `[else]` bodies run.
 */
function* actionRole(cfg: WmlConfig, ctx: EventContext): Flow {
  const role = cfg.getString('role', '');
  if (role === '') {
    ctx.log('error', 'missing role= in [role]');
    return;
  }
  const types = cfg.getString('type', '').split(',').map((t) => t.trim()).filter((t) => t !== '');
  const filter = new WmlConfig();
  for (const name of cfg.attributeNames()) if (name !== 'role' && name !== 'type') filter.setAttribute(name, cfg.getString(name));
  for (const { tag, config } of cfg.allChildren()) if (tag !== 'auto_recall' && tag !== 'else') filter.addChild(tag, config);

  let searchMap = true;
  let searchRecall = true;
  const searchRecallList = cfg.getString('search_recall_list', '');
  if (searchRecallList === 'only') searchMap = false;
  else if (searchRecallList !== '') searchRecall = cfg.getBoolean('search_recall_list');
  const reassign = cfg.getBoolean('reassign', true);

  // The [recall] an [auto_recall] asks for: only its recall-specific keys (role.lua keeps this in sync with C++).
  const autoRecall = cfg.child('auto_recall');
  const recallFor = (unit: Unit) => {
    if (!autoRecall) return;
    const recall = new WmlConfig();
    for (const key of ['x', 'y', 'location_id', 'show', 'fire_event', 'check_passability', 'facing']) {
      if (autoRecall.hasAttribute(key)) recall.setAttribute(key, autoRecall.getString(key));
    }
    recall.setAttribute('id', unit.id);
    actionRecall(recall, ctx);
  };
  const onRecall = (f: WmlConfig) => {
    for (const team of ctx.board.teams()) {
      const u = ctx.board.recallList(team.side).find((r) => unitMatchesFilter(r, f, ctx.board));
      if (u) return u;
    }
    return undefined;
  };
  const byRole = new WmlConfig();
  byRole.setAttribute('role', role);

  if (!reassign) {
    if (searchMap && findUnits(ctx.board, byRole)[0]) return;
    if (autoRecall && searchRecall) {
      const u = onRecall(byRole);
      if (u) {
        recallFor(u);
        return;
      }
    }
  }
  const attempts = types.length > 0 ? types : [null];
  if (searchMap) {
    for (const type of attempts) {
      if (type !== null) filter.setAttribute('type', type);
      const u = findUnits(ctx.board, filter)[0];
      if (u) {
        u.role = role;
        return;
      }
    }
  }
  if (searchRecall) {
    for (const type of attempts) {
      if (type !== null) filter.setAttribute('type', type);
      const u = onRecall(filter);
      if (u) {
        u.role = role;
        recallFor(u);
        return;
      }
    }
  }
  for (const elseBody of cfg.children('else')) {
    yield* runActionFlow(elseBody, ctx);
    if (ctx.exit.type !== 'none') return;
  }
}

// --- [move_unit] ---

/**
 * Mirrors `data/lua/wml/move_unit.lua`'s `wesnoth.wml_actions.move_unit`:
 * relocates every unit matching `cfg` (as a unit filter -- `to_x`/`to_y`/
 * `fire_event`/etc. aren't among the keys `unitMatchesFilter` checks, so
 * `cfg` is used as-is, matching upstream's own approach of stripping only
 * the path/control keys before treating the rest as a filter) directly to
 * its target hex -- NOT a real player move: no movement-point cost, no
 * zone-of-control stop, no pathfinding at all, since this is upstream's
 * scripted/cutscene relocation (its own macro doc: "moves a unit from its
 * current location to the given location, displaying movement normally").
 * If the target hex is occupied, lands on the nearest vacant hex instead
 * (`findVacantTile`, mirroring `wesnoth.paths.find_vacant_hex`).
 *
 * Deliberately NOT ported: `to_location=`/`dir=` path specs (multi-hex
 * scripted routes) -- only the far more common absolute `to_x=`/`to_y=`
 * form (optionally comma-lists, matched positionally against multiple
 * filtered units, same as upstream) is implemented; `check_passability=no`
 * (always passability-checks, matching upstream's default); `clear_shroud=`
 * (no fog/shroud model yet, see `pathfind.ts`'s module doc comment).
 * `fire_event=` IS supported (raises a real `moveto` event via `ctx.raise`,
 * queued for the next pump pass like every other `raise` call in this
 * file -- see that field's own doc comment on the batching this implies).
 */
function* actionMoveUnit(cfg: WmlConfig, ctx: EventContext): Flow {
  if (cfg.hasAttribute('to_location') || cfg.hasAttribute('dir')) {
    ctx.log('warn', '[move_unit]: to_location=/dir= path specs are not supported (only to_x=/to_y=) -- ignored');
  }
  const toXStr = cfg.getString('to_x', '');
  const toYStr = cfg.getString('to_y', '');
  if (!toXStr || !toYStr) {
    ctx.log('warn', '[move_unit]: missing to_x=/to_y= (the only supported destination form) -- no-op');
    return;
  }
  const toXs = toXStr.split(',').map((s) => s.trim());
  const toYs = toYStr.split(',').map((s) => s.trim());
  const fireEvent = cfg.getBoolean('fire_event', false);
  const checkPassability = cfg.getBoolean('check_passability', true);

  const units = findUnits(ctx.board, cfg);
  for (let i = 0; i < units.length; i++) {
    const unit = units[i]!;
    // Positional pairing with the comma-list, clamped to the last entry --
    // mirrors upstream's own coroutine-based `path_locs` running out of
    // `to_x`/`to_y` entries and repeatedly yielding `nil` (which its
    // `tonumber(x) or current_unit:to_map(false)` then reads back as
    // "stay put on this axis").
    const xStr = toXs[Math.min(i, toXs.length - 1)]!;
    const yStr = toYs[Math.min(i, toYs.length - 1)]!;
    const wmlX = Number(xStr);
    const wmlY = Number(yStr);
    if (!Number.isFinite(wmlX) || !Number.isFinite(wmlY)) {
      ctx.log('error', `[move_unit]: invalid to_x=/to_y= ("${xStr}", "${yStr}")`);
      continue;
    }

    const fromLoc = unit.location;
    const requested = Location.fromWml(wmlX, wmlY);
    const alreadyThere = requested.equals(fromLoc);
    const target = alreadyThere
      ? requested
      : findVacantTile(ctx.board, requested, { passCheck: checkPassability ? unit : undefined });
    if (!target) {
      ctx.log('error', `[move_unit]: could not find a vacant hex near (${wmlX}, ${wmlY})`);
      continue;
    }

    // Real Lua's own facing rule: purely left/right, from the ORIGINAL hex
    // to the FINAL one -- not `directionTo`'s full 6-direction geometry.
    if (fromLoc.x < target.x) unit.facing = Direction.SouthEast;
    else if (fromLoc.x > target.x) unit.facing = Direction.SouthWest;

    // Phase 17: `move_unit.lua:103` hands the *visible* move to
    // `[move_unit_fake]` before relocating the unit for real, so the
    // walk plays out before whatever the event does next (a line of
    // dialogue, usually). Headless this resolves instantly and the
    // teleport below is all that happens, exactly as before.
    if (!alreadyThere) {
      const route = findPath(ctx.board, unit, target, { seeAll: true, ignoreUnit: true }).steps;
      const path = route.length > 0 ? route : [fromLoc, target];
      yield* playBeat({ kind: 'moveUnit', unit, path });
    }

    ctx.board.moveUnit(fromLoc, target);
    if (fireEvent) ctx.raise('moveto', target, fromLoc);
  }
}

// --- [teleport] / [tunnel] (Phase 18a) ---

/**
 * `[teleport]` (wml-tags.lua + `game_lua_kernel::intf_teleport`): moves
 * the first unit matching `[filter]` (default: the unit at `$x1,$y1`) to
 * `x,y=` or `location_id=` -- the nearest vacant hex to it, passable for
 * the unit unless `check_passability=no`. Clears shroud around the
 * destination unless `clear_shroud=no`, captures a village there, and with
 * `animate=yes` plays the move (a jump, not a walk) first.
 */
function* actionTeleport(cfg: WmlConfig, ctx: EventContext): Flow {
  const filter = cfg.child('filter');
  const unit = filter ? findUnits(ctx.board, filter)[0] : ctx.board.unitAt(ctx.loc1);
  if (!unit) return; // no error if no unit matches
  let dst: Location;
  const locationId = cfg.getString('location_id', '');
  if (locationId) dst = ctx.board.map.specialLocation(locationId);
  else dst = Location.fromWml(cfg.getNumber('x', 0), cfg.getNumber('y', 0));
  const from = unit.location;
  if (dst.equals(from) || !ctx.board.map.onBoard(dst)) return;
  const checkPassability = cfg.getBoolean('check_passability', true);
  const target = findVacantTile(ctx.board, dst, { passCheck: checkPassability ? unit : undefined });
  if (!target || !ctx.board.map.onBoard(target)) return;

  if (cfg.getBoolean('animate', false)) yield* playBeat({ kind: 'moveUnit', unit, path: [from, target] });
  ctx.board.moveUnit(from, target);

  const team = ctx.board.getTeam(unit.side);
  if (cfg.getBoolean('clear_shroud', true) && team) {
    const clearer = new ShroudClearer(ctx.board);
    clearer.clearUnit(target, unit, team);
    clearer.fireEvents(ctx.raise);
  }
  if (ctx.board.map.isVillage(target)) ctx.board.captureVillage(target, unit.side);
}

/** `[tunnel]` (action_wml.cpp): adds a tunnel (both ways unless `bidirectional=no`) to the board's `[tunnel]`s, or with `remove=yes` drops those named in `id=`. */
function actionTunnel(cfg: WmlConfig, ctx: EventContext): void {
  if (cfg.getBoolean('remove', false)) {
    for (const id of cfg.getString('id', '').split(',').map((s) => s.trim()).filter(Boolean)) ctx.board.tunnels.remove(id);
    return;
  }
  const missing = ['source', 'target', 'filter'].filter((tag) => cfg.children(tag).length !== 1);
  if (missing.length > 0) {
    ctx.log('error', `[tunnel] needs exactly one each of [source], [target] and [filter] (problem: ${missing.join(', ')})`);
    return;
  }
  ctx.board.tunnels.addFromWml(cfg.clone());
}

// --- [objectives] ---

/** `remove_ssf_info_from`: the side-filter keys, which do not belong in a stored `[objectives]`. */
function withoutSideFilter(cfg: WmlConfig): WmlConfig {
  const out = new WmlConfig();
  for (const name of cfg.attributeNames()) {
    if (!['side', 'team_name', 'side_in', 'controller'].includes(name)) out.setAttribute(name, cfg.get(name)!);
  }
  for (const { tag, config } of cfg.allChildren()) {
    if (!['has_unit', 'enemy_of', 'allied_with', 'has_enemy', 'has_ally'].includes(tag)) out.addChild(tag, config);
  }
  return out;
}

/** `generate_objectives`, with each `[show_if]` evaluated now. */
function generateObjectives(cfg: WmlConfig, ctx: EventContext): ScenarioObjectives {
  return parseScenarioObjectives(cfg, (showIf) => conditionalPassed(ctx.variables.expandConfigDeep(showIf), ctx));
}

/**
 * `wml_actions.objectives` (`objectives.lua`): generates the objectives for
 * the sides the tag's side filter picks (all when it picks none or all),
 * stores the raw config for `[show_objectives]` (slot 0 when for every
 * side), and marks them changed unless `silent=yes`.
 */
function actionObjectives(raw: WmlConfig, ctx: EventContext): void {
  // Variables are substituted now unless delayed_variable_substitution=yes.
  const cfg = raw.getBoolean('delayed_variable_substitution', false) ? raw : ctx.variables.expandConfigDeep(raw);
  const sides = findSides(ctx, cfg);
  const silent = cfg.getBoolean('silent', false);
  const objectives = generateObjectives(cfg, ctx);
  const stored = withoutSideFilter(cfg);
  const all = ctx.board.teams().map((t) => t.side);
  const forAll = sides.length === 0 || sides.length === all.length;
  if (forAll) ctx.objectivesConfigBySide.set(0, stored);
  for (const side of forAll ? all : sides) {
    if (!forAll) ctx.objectivesConfigBySide.set(side, stored);
    ctx.objectivesBySide.set(side, objectives);
    if (silent) ctx.objectivesChanged.delete(side);
    else ctx.objectivesChanged.add(side);
  }
}

/** `wml_actions.show_objectives`: regenerates the stored objectives (re-evaluating `[show_if]`) for the sides picked (all if none) and marks them to be shown. */
function actionShowObjectives(cfg: WmlConfig, ctx: EventContext): void {
  const maybeParsed = (c: WmlConfig | undefined) =>
    c && c.getBoolean('delayed_variable_substitution', false) ? ctx.variables.expandConfigDeep(c) : c;
  const cfg0 = maybeParsed(ctx.objectivesConfigBySide.get(0));
  const objectives0 = cfg0 && generateObjectives(cfg0, ctx);
  let sides = findSides(ctx, cfg);
  if (sides.length === 0) sides = ctx.board.teams().map((t) => t.side);
  for (const side of sides) {
    const own = maybeParsed(ctx.objectivesConfigBySide.get(side));
    const objectives = own ? generateObjectives(own, ctx) : objectives0;
    if (objectives) ctx.objectivesBySide.set(side, objectives);
    ctx.objectivesChanged.add(side);
  }
}

// --- registry ---

/**
 * Mirrors `wml_actions.endlevel` (`data/lua/wml/endlevel.lua`): the
 * scenario ends in victory if a human side wins, else in defeat if a human
 * side loses or `result=defeat`. Repeated firings are ignored.
 */
function actionEndlevel(cfg: WmlConfig, ctx: EventContext): void {
  if (ctx.endLevel) {
    ctx.log('warn', 'Repeated [endlevel] execution, ignoring');
    return;
  }
  const sideResults = new Map<number, WmlConfig>();
  for (const r of cfg.children('result')) sideResults.set(r.getNumber('side', 0), r);

  const carryover: EndLevelState['carryover'] = new Map();
  let humanVictory = false;
  let humanDefeat = false;
  const cfgResult = cfg.getString('result', 'victory');
  for (const team of ctx.board.teams()) {
    const sideResult = sideResults.get(team.side);
    const outcome = sideResult?.getString('result', '') || cfgResult;
    if (outcome !== 'victory' && outcome !== 'defeat') {
      ctx.log('error', `invalid result= key in [endlevel] '${outcome}'`);
      return;
    }
    if (team.controller === 'human') {
      if (outcome === 'victory') humanVictory = true;
      else humanDefeat = true;
    }
    const pick = (key: string): WmlConfig | undefined =>
      sideResult?.hasAttribute(key) ? sideResult : cfg.hasAttribute(key) ? cfg : undefined;
    const entry: { bonus?: boolean; carryoverAdd?: boolean; carryoverPercentage?: number } = {};
    const bonusCfg = pick('bonus');
    if (bonusCfg) entry.bonus = bonusCfg.getBoolean('bonus');
    const addCfg = pick('carryover_add');
    if (addCfg) entry.carryoverAdd = addCfg.getBoolean('carryover_add');
    const pctCfg = pick('carryover_percentage');
    if (pctCfg) entry.carryoverPercentage = pctCfg.getNumber('carryover_percentage');
    if (Object.keys(entry).length > 0) carryover.set(team.side, entry);
  }

  const proceed = humanVictory || (!humanDefeat && cfgResult !== 'defeat');
  ctx.endLevel = {
    result: proceed ? 'victory' : 'defeat',
    carryover,
    ...(cfg.hasAttribute('next_scenario') ? { nextScenario: cfg.getString('next_scenario') } : {}),
    ...(cfg.hasAttribute('end_text') ? { endText: cfg.getString('end_text') } : {}),
    ...(cfg.hasAttribute('end_text_duration') ? { endTextDuration: Math.min(Math.max(Math.trunc(cfg.getNumber('end_text_duration', 0)), 0), 5000) } : {}),
    ...(cfg.hasAttribute('end_credits') ? { endCredits: cfg.getBoolean('end_credits', true) } : {}),
    carryoverReport: cfg.getBoolean('carryover_report', true),
    ...(cfg.getString('music', '') !== '' ? { music: cfg.getString('music').split(',').map((t) => t.trim()).filter((t) => t !== '') } : {}),
  };
}

// --- [sound] ---

/**
 * `[sound] name= repeat=` (`wml-tags.lua` over `wesnoth.audio.play`): a sound
 * effect, `repeat=` extra times. `name=` is required.
 */
function actionSound(cfg: WmlConfig, ctx: EventContext): void {
  const name = cfg.getString('name', '');
  if (name === '') {
    ctx.log('error', '[sound] missing required name= attribute');
    return;
  }
  ctx.playSound({ files: name, repeats: Math.trunc(cfg.getNumber('repeat', 0)), group: 'sound', dropIfLate: false });
}

/** `[sound_source]` (`wesnoth.audio.sources[id] = cfg`): adds a source, or replaces the one with the same id. */
function actionSoundSource(cfg: WmlConfig, ctx: EventContext): void {
  if (cfg.getString('id', '') === '') {
    ctx.log('error', '[sound_source] missing required id= attribute');
    return;
  }
  ctx.soundSources.add(soundSourceFromConfig(cfg));
}

/** `[remove_sound_source] id=a,b`. */
function actionRemoveSoundSource(cfg: WmlConfig, ctx: EventContext): void {
  const ids = cfg.getString('id', '');
  if (ids === '') {
    ctx.log('error', '[remove_sound_source] missing required id= attribute');
    return;
  }
  for (const id of ids.split(',')) ctx.soundSources.remove(id.trim());
}

/**
 * `[volume] music= sound=`: percent (0-100) of the player's own setting
 * (`tonumber(...) or 100`); `sound=` scales effects and sound sources, not the
 * interface or the bell (`set_sound_volume`).
 */
function actionVolume(cfg: WmlConfig, ctx: EventContext): void {
  const scale: { music?: number; sound?: number } = {};
  for (const key of ['music', 'sound'] as const) {
    if (!cfg.hasAttribute(key)) continue;
    const parsed = Number(cfg.getString(key));
    const percent = Number.isFinite(parsed) ? parsed : 100;
    if (percent < 0 || percent > 100) {
      ctx.log('error', `[volume] ${key}=: volume must be in range 0..100`);
      continue;
    }
    scale[key] = percent;
  }
  ctx.onVolume?.(scale);
}

// --- [heal_unit] ---

/**
 * Real subset of `data/lua/wml/heal_unit.lua`: `[filter]` (defaults to the
 * unit at `$x1,$y1`, i.e. `ctx.loc1` -- matches upstream reading
 * `wesnoth.current.event_context.x1/y1`), `amount` (a number, or `"full"`/
 * omitted for a full heal -- upstream's own default), `moves` (`"full"` or
 * an amount added, default 0), `restore_attacks`, and `restore_statuses`
 * (default `true`, clearing poisoned/petrified/slowed -- `unhealable` is
 * not modelled as a status the way upstream's `status.unhealable` is, see
 * `Unit.ts`, so it's not cleared here). NOT ported: `[filter_second]`
 * (healer-of-record, used only for the `animate=` visual), `variable=`
 * (per-unit result recording).
 */
function actionHealUnit(cfg: WmlConfig, ctx: EventContext): void {
  const filterCfg = cfg.child('filter');
  const units = filterCfg
    ? findUnits(ctx.board, ctx.variables.expandConfig(filterCfg))
    : ctx.loc1.valid()
      ? [ctx.board.unitAt(ctx.loc1)].filter((u): u is Unit => u !== undefined)
      : [];

  const amountStr = cfg.getString('amount', 'full');
  const movesStr = cfg.getString('moves', '');
  const restoreAttacks = cfg.getBoolean('restore_attacks', false);
  const restoreStatuses = cfg.getBoolean('restore_statuses', true);

  for (const unit of units) {
    if (amountStr === 'full') {
      unit.hitpoints = unit.maxHitpoints;
    } else {
      const amount = Number(amountStr) || 0;
      unit.hitpoints = Math.floor(Math.max(1, Math.min(unit.maxHitpoints, unit.hitpoints + amount)));
    }

    if (movesStr === 'full') {
      unit.movesLeft = unit.maxMoves;
    } else if (movesStr !== '') {
      unit.movesLeft = Math.min(unit.maxMoves, unit.movesLeft + (Number(movesStr) || 0));
    }

    if (restoreAttacks) unit.attacksLeft = unit.maxAttacksPerTurn;

    if (restoreStatuses) {
      unit.setStatus('poisoned', false);
      unit.setStatus('petrified', false);
      unit.setStatus('slowed', false);
    }
  }
}

// --- [set_menu_item] / [clear_menu_item] ---

/**
 * Real subset of upstream's `[set_menu_item]` (`src/game_events/action_wml.
 * cpp`'s `menu_item` handling + `src/menu_events.cpp`'s right-click menu
 * build): `id` (required) and `description` (the menu label, defaulting to
 * `id`), plus a `[command]` child -- the WML action body `runActionSequence`
 * runs (via `GameSession.runMenuItem`, packages/ui) when the player picks
 * this entry from the context menu. Registering just STORES the definition
 * in `ctx.menuItems` (mirrors `actionObjectives`/`ctx.objectivesBySide`'s
 * own "populate a map the UI reads later" pattern) -- it does not run
 * anything itself. NOT ported: `[show_if]`/`[filter_location]` (real
 * per-hex enablement -- this port's menu items are offered unconditionally
 * on every hex, see `GameSession.menuItems`'s own doc comment),
 * `image=`/`needs_select=`/`hotkey=`.
 */
function actionSetMenuItem(cfg: WmlConfig, ctx: EventContext): void {
  const id = cfg.getString('id', '');
  if (id === '') {
    ctx.log('error', '[set_menu_item] missing required id=');
    return;
  }
  ctx.menuItems.set(id, {
    id,
    description: cfg.getString('description', id),
    command: cfg.child('command') ?? new WmlConfig(),
  });
}

/** `id=` removes that one entry; omitted clears every menu item (matches upstream's own `[clear_menu_item]` with no id=). */
function actionClearMenuItem(cfg: WmlConfig, ctx: EventContext): void {
  const id = cfg.getString('id', '');
  if (id === '') ctx.menuItems.clear();
  else ctx.menuItems.delete(id);
}

// --- [fire_event] ---

/**
 * Port of `wml-tags.lua`'s `fire_event`: fires an event *immediately*,
 * draining it (and anything it raises) before the rest of this action
 * sequence continues. `[primary_unit]`/`[secondary_unit]` are unit
 * filters supplying `$x1|$y1`/`$x2|$y2`; `[data]` is passed through as
 * the event's own data, with `[primary_attack]`/`[secondary_attack]`
 * folded into it as `[first]`/`[second]` (upstream's own shuffling, so
 * weapon-filtered handlers see what they expect).
 */
function* actionFireEvent(cfg: WmlConfig, ctx: EventContext): Flow {
  const name = cfg.getString('name', '');
  const id = cfg.getString('id', '');
  if (name === '' && id === '') {
    ctx.log('error', '[fire_event] missing required name= or id=');
    return;
  }

  const filterLoc = (tag: string): Location => {
    const filterCfg = cfg.child(tag);
    if (!filterCfg) return Location.NULL;
    const unit = findUnits(ctx.board, ctx.variables.expandConfig(filterCfg))[0];
    return unit ? unit.location : Location.NULL;
  };

  const data = cfg.child('data') ?? new WmlConfig();
  const primaryAttack = cfg.child('primary_attack');
  const secondaryAttack = cfg.child('secondary_attack');
  if (primaryAttack) data.addChild('first', primaryAttack);
  if (secondaryAttack) data.addChild('second', secondaryAttack);

  yield* ctx.fireNow(name, filterLoc('primary_unit'), filterLoc('secondary_unit'), data, id);
}

/** `[allow_undo]` (`wml-tags.lua`): this event did nothing an undo would have to take back. */
function actionAllowUndo(_cfg: WmlConfig, ctx: EventContext): void {
  ctx.setUndoable(true);
}

/** `[disallow_undo]`: the opposite, for an event that already allowed it. */
function actionDisallowUndo(_cfg: WmlConfig, ctx: EventContext): void {
  ctx.setUndoable(false);
}

/**
 * `[on_undo]`: WML to run if the action behind this event is undone
 * (`wesnoth.experimental.game_events.add_undo_actions`). Variables are
 * substituted now unless `delayed_variable_substitution=yes`, as upstream's
 * `wml.parsed`/`wml.literal` split. It does not by itself allow undo --
 * an event pairing it with `[allow_undo]` is what makes an action undoable.
 */
function actionOnUndo(cfg: WmlConfig, ctx: EventContext): void {
  if (!ctx.addUndoCommands) {
    ctx.log('debug', '[on_undo]: no undo stack in this context');
    return;
  }
  const body = cfg.getBoolean('delayed_variable_substitution', false) ? cfg.clone() : ctx.variables.expandConfigDeep(cfg);
  ctx.addUndoCommands(body);
}

/**
 * Builds a fresh registry with every action tag this module implements
 * (plus the presentation no-ops and extension-point placeholders)
 * pre-registered. Callers needing combat/recruit/Lua support should
 * `.register()` real handlers over the placeholders afterward.
 */
export function createDefaultActionRegistry(): ActionRegistry {
  const registry = new ActionRegistry();

  registry.register('message', actionMessage);
  registry.register('if', actionIf);
  registry.register('set_variable', actionSetVariable);
  registry.register('set_variables', actionSetVariables);
  registry.register('clear_variable', actionClearVariable);
  registry.register('store_unit', actionStoreUnit);
  // Phase 18d (miscWml.ts).
  registry.register('store_starting_location', actionStoreStartingLocation);
  registry.register('store_locations', actionStoreLocations);
  registry.register('store_villages', actionStoreVillages);
  registry.register('store_unit_type', actionStoreUnitType);
  registry.register('store_side', actionStoreSide);
  registry.register('store_turns', actionStoreTurns);
  registry.register('store_map_dimensions', actionStoreMapDimensions);
  registry.register('unit_worth', actionUnitWorth);
  registry.register('set_recruit', actionSetRecruit);
  registry.register('hide_unit', actionHideUnit);
  registry.register('unhide_unit', actionUnhideUnit);
  registry.register('put_to_recall_list', actionPutToRecallList);
  registry.register('modify_turns', actionModifyTurns);
  registry.register('wml_message', actionWmlMessage);
  registry.register('terrain', actionTerrain);
  registry.register('cancel_action', actionCancelAction);
  registry.register('terrain_mask', actionTerrainMask);
  registry.register('item', actionItem);
  registry.register('label', actionLabel);
  registry.register('remove_item', actionRemoveItem);
  registry.register('store_items', actionStoreItems);
  registry.register('unstore_unit', actionUnstoreUnit);
  registry.register('kill', actionKill);
  registry.register('modify_unit', actionModifyUnit);
  registry.register('unit', actionUnit);
  registry.register('gold', actionGold);
  registry.register('store_gold', actionStoreGold);
  registry.register('allow_recruit', actionAllowRecruit);
  registry.register('disallow_recruit', actionDisallowRecruit);
  registry.register('object', actionObject);
  registry.register('event', actionEvent);
  registry.register('remove_event', actionRemoveEvent);
  registry.register('remove_object', actionRemoveObject);
  registry.register('remove_trait', actionRemoveTrait);
  registry.register('transform_unit', actionTransformUnit);
  registry.register('capture_village', actionCaptureVillage);
  registry.register('recall', actionRecall);
  registry.register('role', actionRole);
  registry.register('move_unit', actionMoveUnit);
  registry.register('teleport', actionTeleport);
  registry.register('tunnel', actionTunnel);
  registry.register('objectives', actionObjectives);
  registry.register('show_objectives', actionShowObjectives);
  registry.register('endlevel', actionEndlevel);
  registry.register('remove_shroud', actionRemoveShroud);
  registry.register('place_shroud', actionPlaceShroud);
  registry.register('lift_fog', actionLiftFog);
  registry.register('reset_fog', actionResetFog);
  registry.register('time_area', actionTimeArea);
  registry.register('remove_time_area', actionRemoveTimeArea);
  registry.register('replace_schedule', actionReplaceSchedule);
  registry.register('store_time_of_day', actionStoreTimeOfDay);
  registry.register('heal_unit', actionHealUnit);
  registry.register('set_menu_item', actionSetMenuItem);
  registry.register('clear_menu_item', actionClearMenuItem);
  registry.register('fire_event', actionFireEvent);
  registry.register('allow_undo', actionAllowUndo);
  registry.register('disallow_undo', actionDisallowUndo);
  registry.register('on_undo', actionOnUndo);
  registerFlowActions((tag, handler) => registry.register(tag, handler));
  registerSupportActions((tag, handler) => registry.register(tag, handler));

  registry.register('music', (cfg, ctx) => applyMusicAction(ctx.music, cfg));
  registry.register('sound', actionSound);
  registry.register('sound_source', actionSoundSource);
  registry.register('remove_sound_source', actionRemoveSoundSource);
  registry.register('volume', actionVolume);
  for (const tag of ['redraw', 'highlight']) {
    registry.register(tag, noop);
  }
  registerCutsceneActions((tag, handler) => registry.register(tag, handler));

  registry.register('attack', extensionPoint('attack', 'packages/engine/src/actions/'));
  registry.register('recruit', extensionPoint('recruit', 'packages/engine/src/actions/'));
  registry.register('lua', extensionPoint('lua', 'packages/lua-bridge/ (Phase 3)'));

  return registry;
}

// Re-exported for pump.ts / tests without pulling in the whole model surface directly.
export { Location };
