/**
 * Story screen parsing (Phase 16 N1): resolves a scenario's `[story]` WML
 * into the parts the story viewer shows.
 *
 * Ports `src/storyscreen/controller.cpp`, `parser.cpp` and `part.cpp`:
 * - Every `[story]` child of the scenario is concatenated into one sequence
 *   (`playsingle_controller.cpp`: `cfg.append_children(iter)` per `[story]`)
 *   and shown in a single viewer, before `prestart`.
 * - `[if]`/`[elseif]`/`[else]` and `[switch]`/`[case]`/`[else]` branch at
 *   both story and part level, evaluated against the current game state
 *   (`conditionalPassed`, the session's variables).
 * - A part always starts with one background layer built from its shortcut
 *   attributes (`background=`, `scale_background=`, ...), even when it has
 *   no file, followed by its `[background_layer]`s in document order.
 * - A part that shows its title but has none uses the scenario name.
 *
 * Attribute values are `$variable`-substituted, as upstream's `vconfig`
 * does on access. `[deprecated_message]`/`[wml_message]` are forwarded to
 * the context's log.
 */

import type { EventContext } from '../events/context.js';
import { conditionalPassed } from '../events/conditionalWml.js';
import type { WmlConfig } from '../wml/config.js';

export interface StoryBackgroundLayer {
  /** Image path as written in WML (not yet rooted to a data directory); empty when the layer has no file. */
  readonly image: string;
  readonly scaleHorizontally: boolean;
  readonly scaleVertically: boolean;
  readonly tileHorizontally: boolean;
  readonly tileVertically: boolean;
  readonly keepAspectRatio: boolean;
  readonly baseLayer: boolean;
}

/** A `[part][image]`: drawn on top of the background, positioned in base-layer image coordinates. */
export interface StoryFloatingImage {
  readonly file: string;
  readonly x: number;
  readonly y: number;
  /** Milliseconds to wait after drawing this image before drawing the next one. */
  readonly delay: number;
  readonly resizeWithBackground: boolean;
  readonly centered: boolean;
}

export type StoryTextLayout = 'top' | 'middle' | 'bottom';

export interface ResolvedStoryPart {
  readonly showTitle: boolean;
  readonly title: string;
  readonly text: string;
  readonly textLayout: StoryTextLayout;
  readonly textAlignment: string;
  readonly titleAlignment: string;
  /** Title position as percentages (0–100) of the free space on each axis. */
  readonly titlePosition: { readonly x: number; readonly y: number };
  readonly music: string;
  readonly sound: string;
  readonly voice: string;
  readonly backgroundLayers: readonly StoryBackgroundLayer[];
  readonly floatingImages: readonly StoryFloatingImage[];
}

/** WML boolean parsing as `config_attribute_value::to_bool`: yes/true/on and non-zero numbers are true. */
function toBool(value: string | number | boolean | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const s = value.trim().toLowerCase();
  if (s === 'yes' || s === 'true' || s === 'on') return true;
  if (s === 'no' || s === 'false' || s === 'off') return false;
  const n = Number(s);
  return s !== '' && !Number.isNaN(n) ? n !== 0 : fallback;
}

function toInt(value: string | number | boolean | undefined): number {
  if (value === undefined || typeof value === 'boolean') return 0;
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** Reads attributes with `$variable` substitution, like a `vconfig`. */
class VAttrs {
  constructor(
    private readonly cfg: WmlConfig,
    private readonly ctx: EventContext,
  ) {}

  has(key: string): boolean {
    return this.cfg.hasAttribute(key);
  }

  raw(key: string): string | number | boolean | undefined {
    const v = this.cfg.get(key);
    return typeof v === 'string' ? this.ctx.variables.substitute(v) : v;
  }

  str(key: string): string {
    const v = this.raw(key);
    return v === undefined ? '' : String(v);
  }

  bool(key: string, fallback: boolean): boolean {
    return toBool(this.raw(key), fallback);
  }
}

/**
 * Walks a config's children in order, handing each to `helper` first and
 * applying `[if]`/`[switch]`/`[deprecated_message]`/`[wml_message]` to the
 * rest -- `story_parser::resolve_wml`.
 */
function resolveFlow(cfg: WmlConfig, ctx: EventContext, helper: (tag: string, node: WmlConfig) => boolean): void {
  for (const { tag, config: node } of cfg.allChildren()) {
    if (helper(tag, node)) continue;

    if (tag === 'if') {
      if (conditionalPassed(node, ctx)) {
        const then = node.child('then');
        if (then) resolveFlow(then, ctx, helper);
      } else {
        let elseifMatched = false;
        for (const elseif of node.children('elseif')) {
          if (conditionalPassed(elseif, ctx)) {
            const then = elseif.child('then');
            if (then) resolveFlow(then, ctx, helper);
            elseifMatched = true;
            break;
          }
        }
        const elseCfg = node.child('else');
        if (elseCfg && !elseifMatched) resolveFlow(elseCfg, ctx, helper);
      }
    } else if (tag === 'switch') {
      const actual = String(ctx.variables.get(new VAttrs(node, ctx).str('variable')) ?? '');
      let caseFound = false;
      for (const c of node.children('case')) {
        // Every matching [case] is entered, not just the first.
        if (actual === new VAttrs(c, ctx).str('value')) {
          caseFound = true;
          resolveFlow(c, ctx, helper);
        }
      }
      if (!caseFound) {
        for (const e of node.children('else')) resolveFlow(e, ctx, helper);
      }
    } else if (tag === 'deprecated_message') {
      const a = new VAttrs(node, ctx);
      ctx.log('warn', `[deprecated_message] ${a.str('what')}: ${a.str('message')}`);
    } else if (tag === 'wml_message') {
      const a = new VAttrs(node, ctx);
      const logger = a.str('logger');
      ctx.log(logger === 'err' || logger === 'error' ? 'error' : logger === 'warn' || logger === 'warning' ? 'warn' : 'info', a.str('message'));
    }
  }
}

function parseBackgroundLayer(cfg: WmlConfig, ctx: EventContext): StoryBackgroundLayer {
  const a = new VAttrs(cfg, ctx);
  let scaleHorizontally = true;
  let scaleVertically = true;
  let tileHorizontally = false;
  let tileVertically = false;
  if (a.has('scale')) {
    scaleHorizontally = scaleVertically = a.bool('scale', true);
  } else {
    if (a.has('scale_vertically')) scaleVertically = a.bool('scale_vertically', true);
    if (a.has('scale_horizontally')) scaleHorizontally = a.bool('scale_horizontally', true);
  }
  if (a.has('tile')) {
    tileHorizontally = tileVertically = a.bool('tile', false);
  } else {
    if (a.has('tile_vertically')) tileVertically = a.bool('tile_vertically', false);
    if (a.has('tile_horizontally')) tileHorizontally = a.bool('tile_horizontally', false);
  }
  return {
    image: a.str('image'),
    scaleHorizontally,
    scaleVertically,
    tileHorizontally,
    tileVertically,
    keepAspectRatio: a.has('keep_aspect_ratio') ? a.bool('keep_aspect_ratio', true) : true,
    baseLayer: a.has('base_layer') ? a.bool('base_layer', false) : false,
  };
}

function parseFloatingImage(cfg: WmlConfig, ctx: EventContext): StoryFloatingImage {
  const a = new VAttrs(cfg, ctx);
  return {
    file: a.str('file'),
    x: toInt(a.raw('x')),
    y: toInt(a.raw('y')),
    delay: toInt(a.raw('delay')),
    resizeWithBackground: a.bool('resize_with_background', false),
    centered: a.bool('centered', false),
  };
}

function textLayoutFrom(s: string): StoryTextLayout {
  return s === 'top' ? 'top' : s === 'middle' ? 'middle' : 'bottom';
}

function decodeHPosition(s: string): number {
  return s === 'center' ? 50 : s === 'right' ? 100 : 0;
}

/** The ternaries keep the title from overlapping the text block (part.cpp). */
function decodeVPosition(s: string, layout: StoryTextLayout): number {
  if (s === 'top') return layout === 'top' ? 50 : 0;
  if (s === 'middle') return layout === 'middle' ? 0 : 50;
  if (s === 'bottom') return layout === 'bottom' ? 50 : 100;
  return 0;
}

function splitList(s: string): string[] {
  return s
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

function parsePart(cfg: WmlConfig, ctx: EventContext, scenarioName: string): ResolvedStoryPart {
  const a = new VAttrs(cfg, ctx);

  // Shortcut syntax -> the part's first background layer, always present.
  let shortcutScaleH = true;
  let shortcutScaleV = true;
  let shortcutTileH = false;
  let shortcutTileV = false;
  if (a.has('scale_background')) {
    shortcutScaleH = shortcutScaleV = a.bool('scale_background', true);
  } else {
    if (a.has('scale_background_vertically')) shortcutScaleV = a.bool('scale_background_vertically', true);
    if (a.has('scale_background_horizontally')) shortcutScaleH = a.bool('scale_background_horizontally', true);
  }
  if (a.has('tile_background')) {
    shortcutTileH = shortcutTileV = a.bool('tile_background', false);
  } else {
    if (a.has('tile_background_vertically')) shortcutTileV = a.bool('tile_background_vertically', false);
    // Upstream bug kept on purpose: tile_background_horizontally sets the VERTICAL flag (part.cpp:159-161).
    if (a.has('tile_background_horizontally')) shortcutTileV = a.bool('tile_background_horizontally', false);
  }
  const backgroundLayers: StoryBackgroundLayer[] = [
    {
      image: a.str('background'),
      scaleHorizontally: shortcutScaleH,
      scaleVertically: shortcutScaleV,
      tileHorizontally: shortcutTileH,
      tileVertically: shortcutTileV,
      keepAspectRatio: a.has('keep_aspect_ratio') ? a.bool('keep_aspect_ratio', true) : true,
      baseLayer: false,
    },
  ];
  const floatingImages: StoryFloatingImage[] = [];

  let showTitle = a.has('show_title') ? a.bool('show_title', false) : false;
  const text = a.str('story');
  let title = '';
  if (a.has('title')) {
    title = a.str('title');
    if (!a.has('show_title')) showTitle = true;
  }
  const textLayout = a.has('text_layout') ? textLayoutFrom(a.str('text_layout')) : 'bottom';

  let titlePosition = { x: 0, y: 0 };
  if (a.has('title_position')) {
    const raw = a.str('title_position');
    if (raw === 'centered') {
      titlePosition = { x: 50, y: 50 };
    } else {
      const vals = splitList(raw);
      if (vals.length === 1) titlePosition = { x: decodeHPosition(vals[0]!), y: decodeVPosition(vals[0]!, textLayout) };
      else if (vals.length >= 2) titlePosition = { x: decodeHPosition(vals[0]!), y: decodeVPosition(vals[1]!, textLayout) };
    }
  }

  resolveFlow(cfg, ctx, (tag, node) => {
    if (tag === 'background_layer') {
      backgroundLayers.push(parseBackgroundLayer(node, ctx));
      return true;
    }
    if (tag === 'image') {
      floatingImages.push(parseFloatingImage(node, ctx));
      return true;
    }
    return false;
  });

  if (showTitle && title === '') title = scenarioName;

  return {
    showTitle,
    title,
    text,
    textLayout,
    textAlignment: a.has('text_alignment') ? a.str('text_alignment') : 'left',
    titleAlignment: a.has('title_alignment') ? a.str('title_alignment') : 'left',
    titlePosition,
    music: a.str('music'),
    sound: a.str('sound'),
    voice: a.str('voice'),
    backgroundLayers,
    floatingImages,
  };
}

/**
 * Resolves the story parts to show before a scenario starts. `scenarioCfg`
 * is the whole `[scenario]`; its `[story]` children are concatenated in
 * order. Evaluate this right before `prestart`, with the session's live
 * context, so `[if]`/`[switch]` see carried-over variables only.
 */
export function resolveStory(scenarioCfg: WmlConfig, scenarioName: string, ctx: EventContext): ResolvedStoryPart[] {
  const parts: ResolvedStoryPart[] = [];
  for (const story of scenarioCfg.children('story')) {
    resolveFlow(story, ctx, (tag, node) => {
      // controller.cpp skips an empty [part].
      if (tag !== 'part') return false;
      if (node.attributeNames().length > 0 || node.allChildren().length > 0) parts.push(parsePart(node, ctx, scenarioName));
      return true;
    });
  }
  return parts;
}
