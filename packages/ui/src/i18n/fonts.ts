/**
 * Font order per language. Upstream's `data/hardwired/fonts.cfg` marks `family_order`,
 * `family_order_monospace` and `family_order_script` translatable (`_ "Lato"`, `_ "DejaVu Sans Mono"`,
 * `_ "WesScript"`) so a translator can name a different font for a script Lato does not cover -- a
 * Japanese catalogue says "Noto Sans JP", and Arabic's says "لاتو", a name no installed font has, so
 * it falls through to the next family. The stack is: the translated names, then the English names
 * (bundled), then DejaVu Sans (bundled; covers Arabic, Hebrew, Cyrillic, Greek), then the system's.
 */

import { dsgettext } from '@wesnothweb2/engine';

export interface FontStacks {
  ui: string;
  script: string;
  mono: string;
}

const quote = (name: string): string => `"${name.replace(/"/g, '')}"`;

function stack(translated: string, english: string, generic: string, extra: readonly string[]): string {
  const names = [...new Set([translated, english, ...extra])].filter((n) => n.trim() !== '');
  return `${names.map(quote).join(', ')}, ${generic}`;
}

/** The three font stacks for the language whose catalogues are installed now. */
export function fontStacks(): FontStacks {
  return {
    ui: stack(dsgettext('wesnoth', 'Lato'), 'Lato', 'sans-serif', ['DejaVu Sans']),
    script: stack(dsgettext('wesnoth', 'WesScript'), 'WesScript', 'serif', ['DejaVu Sans']),
    mono: stack(dsgettext('wesnoth', 'DejaVu Sans Mono'), 'DejaVu Sans Mono', 'monospace', ['DejaVu Sans']),
  };
}

/**
 * Families that upstream ships for scripts our bundled fonts do not cover, fetched only when a language's
 * `family_order` names one (none of the shipped languages does). The files are not bundled: a language
 * that needs one adds it here and to `build-fonts.mjs`.
 */
export const ON_DEMAND_FONTS: Readonly<Record<string, string>> = {};

const requested = new Set<string>();

/** Starts loading any on-demand family the current stacks name; never throws (a missing file just leaves the fallback). */
export function loadOnDemandFonts(stacks: FontStacks): void {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return;
  for (const family of Object.keys(ON_DEMAND_FONTS)) {
    if (requested.has(family) || !Object.values(stacks).some((s) => s.includes(quote(family)))) continue;
    requested.add(family);
    const face = new FontFace(family, `url(${ON_DEMAND_FONTS[family]})`);
    face.load().then(
      () => (document.fonts as unknown as { add(f: FontFace): void }).add(face),
      () => undefined,
    );
  }
}
