/**
 * Localized art, ported from upstream's `filesystem::get_localized_path` (`filesystem.cpp`).
 *
 * A picture `dir/name.ext` may have a translated twin at `dir/l10n/<code>/name.ext` (a
 * standalone replacement) or, failing that, a `dir/l10n/<code>/name--overlay.ext` that is drawn
 * over the original (journey maps whose place names are written in the player's language).
 * `<code>` comes from the language's own `language code for localized resources^en_US`
 * message (`wesnoth-lib`), a priority list ("sv,da"), with `en_US` always last because the
 * original image may itself be split into base and overlay.
 *
 * Pure: it names the candidates in priority order; the caller checks which one exists (the build
 * script against the disk, the UI against the table of images that were built).
 */

/** `dir/l10n/<code>/<name><suffix>.<ext>` for `dir/name.ext` (the suffix goes before the extension). */
export function localizedPath(file: string, code: string, suffix = ''): string {
  const slash = file.lastIndexOf('/');
  const dir = slash === -1 ? '' : file.slice(0, slash);
  const base = slash === -1 ? file : file.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  const localBase = dot === -1 ? base + suffix : base.slice(0, dot) + suffix + base.slice(dot);
  return `${dir === '' ? '' : dir + '/'}l10n/${code}/${localBase}`;
}

/** The language codes to try for localized resources, in priority order, `en_US` last. */
export function resourceLanguageCodes(message: string): string[] {
  const codes = message
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c !== '');
  if (!codes.includes('en_US')) codes.push('en_US');
  return codes;
}
