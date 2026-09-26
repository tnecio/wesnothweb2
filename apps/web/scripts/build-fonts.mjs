#!/usr/bin/env node
/**
 * Phase 20 Stage 4: turns upstream's fonts (`fonts/*.ttf|otf` in the full Wesnoth checkout) into the
 * WOFF2 files `packages/ui/src/fonts.css` serves. Needs python3-fonttools and python3-brotli (`python3 -m fontTools.subset`).
 *
 *   - Lato (the UI font, Regular/Bold/Italic/BoldItalic), subset to Latin: everything the shipped
 *     Latin-script languages need (Polish, Czech, Hungarian, Finnish, Italian, Spanish, Galician,
 *     English). Its Cyrillic and Greek are not shipped; the fallback below covers them.
 *   - WesScript (story and title font), whole (~40 KB).
 *   - DejaVu Sans Regular/Bold (the fallback: Arabic, Hebrew, Cyrillic, Greek, ...), whole. A web font
 *     is only fetched when a character needs it, so a Latin-script player never downloads it.
 *   - DejaVu Sans Mono (`family_order_monospace`), whole; nothing draws monospace text yet.
 *
 * No CJK or Bengali font ships: none of the shipped languages needs one. The loader in
 * `packages/ui/src/i18n/fonts.ts` can fetch upstream's NotoSansJP/Droid/Lohit on demand if a language
 * that names them is added.
 *
 * Source: `$WESNOTH_FONTS`, else `~/wesnothweb/wesnoth/fonts`.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const outDir = path.join(repoRoot, 'packages/ui/src/assets/fonts');
const srcDir = [process.env.WESNOTH_FONTS, path.join(os.homedir(), 'wesnothweb/wesnoth/fonts')].find((d) => d && fs.existsSync(d));
if (!srcDir) throw new Error('upstream fonts not found; set WESNOTH_FONTS');
fs.mkdirSync(outDir, { recursive: true });

// Basic Latin, Latin-1, Latin Extended-A/B, Latin Extended Additional, general punctuation, currency, arrows, math.
const LATIN = 'U+0000-024F,U+1E00-1EFF,U+2000-206F,U+20A0-20CF,U+2100-214F,U+2190-21FF,U+2200-22FF,U+25A0-25FF';

const jobs = [
  ['Lato-Regular.ttf', 'lato-latin-400-normal', LATIN],
  ['Lato-Bold.ttf', 'lato-latin-700-normal', LATIN],
  ['Lato-Italic.ttf', 'lato-latin-400-italic', LATIN],
  ['Lato-BoldItalic.ttf', 'lato-latin-700-italic', LATIN],
  ['WesScript-Regular.otf', 'wesscript-400-normal', null],
  ['DejaVuSans.ttf', 'dejavu-sans-400-normal', null],
  ['DejaVuSans-Bold.ttf', 'dejavu-sans-700-normal', null],
  ['DejaVuSansMono.ttf', 'dejavu-sans-mono-400-normal', null],
];

let total = 0;
for (const [file, name, unicodes] of jobs) {
  const out = path.join(outDir, `${name}.woff2`);
  const args = [path.join(srcDir, file), `--output-file=${out}`, '--flavor=woff2', '--layout-features=*', '--no-hinting'];
  if (unicodes) args.push(`--unicodes=${unicodes}`);
  else args.push('--unicodes=*');
  execFileSync('python3', ['-m', 'fontTools.subset', ...args]);
  const size = fs.statSync(out).size;
  total += size;
  console.log(`${name}.woff2  ${(size / 1024).toFixed(0)} KB`);
}
console.log(`total ${(total / 1024).toFixed(0)} KB`);
