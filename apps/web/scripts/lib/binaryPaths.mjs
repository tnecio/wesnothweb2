/**
 * A campaign's `[binary_path]`s, as `data/`-relative dirs in search order: its own
 * (`campaigns/<id>`), then those of the shared resources its `_main.cfg` includes. For example,
 * `{internal/Rogue_Mage}` adds `internal/Rogue_Mage`, and `{internal/Weather}` adds `internal/Weather`.
 * Upstream searches every binary path's `images/` (`get_binary_file_location`). The resources hold
 * images that core does not have, so they come after the campaign's own and before core.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The `[binary_path] path=`s a config file declares, as `data/`-relative dirs. */
function declaredBinaryPaths(file) {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/\[binary_path\][^[]*?path\s*=\s*"?data\/([^"\s]+?)\/?"?\s*\n/g)].map((m) => m[1]);
}

/** `dataRoot`: the checkout's `wesnoth/data`. `wesnothId`: the campaign's directory name. */
export function campaignBinaryPaths(dataRoot, wesnothId) {
  const dirs = [`campaigns/${wesnothId}`];
  const mainCfg = path.join(dataRoot, 'campaigns', wesnothId, '_main.cfg');
  if (fs.existsSync(mainCfg)) {
    for (const m of fs.readFileSync(mainCfg, 'utf8').matchAll(/^\s*\{(internal\/[A-Za-z0-9_]+)\/?\}/gm)) {
      const included = path.join(dataRoot, m[1], '_main.cfg');
      if (fs.existsSync(included)) dirs.push(...declaredBinaryPaths(included));
    }
  }
  return [...new Set(dirs)];
}
