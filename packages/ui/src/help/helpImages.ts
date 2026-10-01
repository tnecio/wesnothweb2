/**
 * Where a help page's image lives (Phase 24). Upstream looks an image up in each binary path's `images/`
 * (core's `data/core/images/` first), then in the game's own root, so `images/buttons/...` is the engine's
 * `images/` directory and `icons/profiles/blade.png`, found in no binary path, is too. The renderer spells
 * an engine image `engine/<path>` (`imageUrl`); `HelpData.engineImages` lists the images only the engine
 * has.
 */
const REF_OPS = /(BLIT|MASK|BG|LIGHTEN|DARKEN)\(([^,)~]+)/g;

/** `ref` with every file in it (the image and the files its path functions name) rooted as the renderer wants. */
export function helpImageRef(ref: string, engineImages: ReadonlySet<string>): string {
  const root = (p: string): string => {
    const path = p.startsWith('data/') ? p.slice('data/'.length) : p;
    if (path.startsWith('images/')) return 'engine/' + path.slice('images/'.length);
    return engineImages.has(path) ? 'engine/' + path : path;
  };
  const tilde = ref.indexOf('~');
  if (tilde === -1) return root(ref);
  const mods = ref.slice(tilde + 1).replace(REF_OPS, (_m, op: string, arg: string) => `${op}(${root(arg)}`);
  return `${root(ref.slice(0, tilde))}~${mods}`;
}
