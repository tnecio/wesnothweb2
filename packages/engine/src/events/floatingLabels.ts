/**
 * C1: floating labels (`font::floating_label`), which WML and Lua put on the screen and the display draws:
 *
 * - `[floating_text]` (`wml-tags.lua`) and `wesnoth.interface.float_label` (`game_display::float_label`): a
 *   label rising from a hex, in `font::LABEL_COLOR` unless given, for a second; not shown on a fogged hex.
 * - `[print]` (`wml-tags.lua`) and `wesnoth.interface.add_overlay_text`
 *   (`game_lua_kernel::intf_set_floating_label`): a label placed on the map area, centred by default,
 *   for `duration` ms then fading over `fade_time` ms. A new `[print]` replaces the last one.
 *
 * The engine only describes them (`EventContext.floatLabel`); they change nothing in the game.
 */
import type { WmlConfig } from '../wml/config.js';
import type { TString } from '../i18n/tstring.js';
import type { Location } from '../model/Location.js';
import type { EventContext } from './context.js';
import { findLocations } from './filter.js';

/** An RGB colour, 0-255 per channel. */
export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** `font::LABEL_COLOR`. */
export const FLOATING_LABEL_COLOR: RgbColor = { r: 107, g: 140, b: 255 };
/** `font::SIZE_SMALL`: `add_overlay_text`'s default size. */
export const OVERLAY_TEXT_SIZE = 15;

/** The label rising from a hex (`game_display::float_label`). */
export interface HexFloatingLabel {
  readonly kind: 'hex';
  readonly loc: Location;
  readonly text: string | TString;
  readonly color: RgbColor;
}

/** A label over the map area (`intf_set_floating_label`). `id` names it for `replace`/`remove`. */
export interface OverlayFloatingLabel {
  readonly kind: 'overlay';
  readonly id: number;
  readonly text: string | TString;
  readonly size: number;
  readonly color: RgbColor;
  /** Absent: transparent, and the text is outlined instead. */
  readonly bgcolor?: RgbColor & { readonly a: number };
  /** Milliseconds shown before fading; -1: until removed. */
  readonly duration: number;
  readonly fadeTime: number;
  readonly halign: 'left' | 'center' | 'right';
  readonly valign: 'top' | 'center' | 'bottom';
  /** Offset in pixels from the alignment point (`location=`). */
  readonly x: number;
  readonly y: number;
  /** `max_width=`: pixels, or a fraction of the map area's width. */
  readonly maxWidth?: { readonly px: number } | { readonly ratio: number };
}

export type FloatingLabelRequest = HexFloatingLabel | OverlayFloatingLabel | { readonly kind: 'removeOverlay'; readonly id: number };

/** `color_t::from_rgb_string`: `r,g,b`; anything else is null. */
export function parseRgbString(value: string): RgbColor | null {
  const fields = value.split(',').map((f) => f.trim());
  if (fields.length !== 3) return null;
  const [r, g, b] = fields.map((f) => Number.parseInt(f, 10));
  if (![r, g, b].every((c) => Number.isFinite(c))) return null;
  return { r: r! & 255, g: g! & 255, b: b! & 255 };
}

/** `color_t::from_hex_string`: `#rrggbb` or `rrggbb`. */
export function parseHexColor(value: string): RgbColor | null {
  const hex = value.startsWith('#') ? value.slice(1) : value;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  const n = Number.parseInt(hex, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** A new overlay label's id (`font::add_floating_label`'s counter). */
export function nextOverlayLabelId(ctx: EventContext): number {
  ctx.overlayLabelCounter = (ctx.overlayLabelCounter ?? 0) + 1;
  return ctx.overlayLabelCounter;
}

/** `wml_actions.floating_text`: a rising label on every matching hex. */
export function actionFloatingText(cfg: WmlConfig, ctx: EventContext): void {
  if (!cfg.hasAttribute('text')) {
    ctx.log('error', '[floating_text] missing required text= attribute');
    return;
  }
  const text = cfg.getTString('text') ?? cfg.getString('text');
  let color = FLOATING_LABEL_COLOR;
  if (cfg.hasAttribute('color')) {
    const parsed = parseRgbString(cfg.getString('color'));
    if (!parsed) {
      ctx.log('error', `[floating_text] invalid color= '${cfg.getString('color')}'`);
      return;
    }
    color = parsed;
  }
  for (const loc of findLocations(ctx.board, cfg)) ctx.floatLabel?.({ kind: 'hex', loc, text, color });
}

/**
 * `wml_actions.print`: `wesnoth.interface.add_overlay_text(text, {size, color, duration, fade_time})`,
 * removing the label the previous `[print]` made. `color=` is `r,g,b`; else `red=`/`green=`/`blue=`.
 */
export function actionPrint(cfg: WmlConfig, ctx: EventContext): void {
  if (ctx.printLabelId !== undefined) {
    ctx.floatLabel?.({ kind: 'removeOverlay', id: ctx.printLabelId });
    ctx.printLabelId = undefined;
  }
  let color = FLOATING_LABEL_COLOR;
  if (cfg.hasAttribute('color')) {
    const [r, g, b] = cfg.getString('color').split(',').map((c) => Number.parseInt(c.trim(), 10));
    color = { r: r ?? 0, g: g ?? 0, b: b ?? 0 };
  } else if (cfg.hasAttribute('red') || cfg.hasAttribute('green') || cfg.hasAttribute('blue')) {
    color = { r: cfg.getNumber('red', 0), g: cfg.getNumber('green', 0), b: cfg.getNumber('blue', 0) };
  }
  const durationRaw = cfg.getString('duration', '');
  const id = nextOverlayLabelId(ctx);
  ctx.printLabelId = id;
  ctx.floatLabel?.({
    kind: 'overlay',
    id,
    text: cfg.getTString('text') ?? cfg.getString('text', ''),
    size: cfg.getNumber('size', OVERLAY_TEXT_SIZE),
    color,
    duration: durationRaw === 'unlimited' ? -1 : cfg.getNumber('duration', 2000),
    fadeTime: cfg.getNumber('fade_time', 100),
    halign: 'center',
    valign: 'center',
    x: 0,
    y: 0,
  });
}
