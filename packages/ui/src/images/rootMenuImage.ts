/**
 * A `[campaign]` image path as the renderer roots it. Campaign metadata writes full data paths
 * (`data/campaigns/Liberty/images/portraits/x.webp`), which the image search would look for under the
 * campaign's `images/`; the rooted form (`campaigns/...`, `core/...`) is relative to `wesnoth/data`.
 * A BLIT argument is itself a path, so it is normalised too.
 */
export function rootMenuImage(ref: string): string {
  const fix = (path: string): string => (path.startsWith('data/') ? path.slice('data/'.length) : path);
  const tilde = ref.indexOf('~');
  const path = tilde === -1 ? ref : ref.slice(0, tilde);
  const mods = tilde === -1 ? '' : ref.slice(tilde + 1);
  const fixedMods = mods.replace(/(BLIT|MASK|BG|LIGHTEN)\(([^,)~]+)/g, (_m, op: string, arg: string) => `${op}(${fix(arg)}`);
  return fixedMods ? `${fix(path)}~${fixedMods}` : fix(path);
}
