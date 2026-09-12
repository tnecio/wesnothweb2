#!/usr/bin/env node
/**
 * Builds `apps/web/public/team-colors.json`: the real `[color_range]`/
 * `[color_palette]` data from `wesnoth/data/core/team-colors.cfg`, shipped
 * as ONE static asset shared across every scenario (this content is core
 * data, not scenario-specific -- same reasoning as `build-terrain-graphics-
 * rules.mjs`'s own doc comment).
 *
 * Real, reported bug (bugs3.md #3): unit sprites render in their raw
 * reference palette (magenta) instead of the unit's side color, because
 * nothing ever supplied `ImageCache.setColorData` real palette/range data.
 * Real Wesnoth recolors every unit sprite at render time via `unit::
 * TC_image_mods()`: `~RC(flag_rgb>side_color_id)`, where `flag_rgb` is
 * almost always "magenta" (`unit_type`'s own `flag_rgb=`, defaulting to
 * "magenta") and `side_color_id` is the side's own `[side] color=` (a
 * named color_range id), or, if unset, `default_colors[side-1]` -- the
 * `default=yes`-marked `[color_range]`s, in file order (`game_config.cpp`'s
 * `add_color_info`). This script emits that same file-order `defaultColors`
 * list so the runtime doesn't need to re-derive it, alongside every named
 * range (for an explicit `color=`) and the `magenta` reference palette
 * itself (for `~RC`'s "from" side).
 *
 * Run with: npx tsx apps/web/scripts/build-team-colors.mjs
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');
const outPath = path.join(repoRoot, 'apps/web/public/team-colors.json');

const { parseWmlFile } = await import(path.join(repoRoot, 'packages/engine/src/wml/index.ts'));

console.log('Parsing core/team-colors.cfg...');
const cfg = parseWmlFile(path.join(dataRoot, 'core/team-colors.cfg'), { dataRoot, defines: new Map() });

/** "RRGGBB" (or "RGB") hex string -> [r,g,b]. Mirrors `color_t::from_hex_string`. */
function parseHex(hex) {
  const s = hex.trim();
  if (s.length === 3) {
    return [parseInt(s[0] + s[0], 16), parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16)];
  }
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

const ranges = {};
const defaultColors = [];
for (const rangeCfg of cfg.children('color_range')) {
  const id = rangeCfg.getString('id');
  const rgb = rangeCfg.getString('rgb', '');
  if (!id || !rgb) continue;
  const parts = rgb.split(',').map((s) => parseHex(s));
  const [mid, max, min, rep] = parts;
  if (!mid || !max || !min || !rep) continue;
  ranges[id] = { mid, max, min, rep };
  if (rangeCfg.getBoolean('default', false)) defaultColors.push(id);
}

const palettes = {};
for (const paletteCfg of cfg.children('color_palette')) {
  for (const key of paletteCfg.attributeNames()) {
    const value = paletteCfg.getString(key, '');
    if (!value) continue;
    palettes[key] = value.split(',').map((s) => parseHex(s));
  }
}

const output = { palettes, ranges, defaultColors };
fs.writeFileSync(outPath, JSON.stringify(output));
console.log(`Wrote ${outPath}: ${Object.keys(ranges).length} ranges, ${Object.keys(palettes).length} palettes, ${defaultColors.length} default colors.`);
