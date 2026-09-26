/**
 * Where upstream's translation sources (`po/<domain>/<lang>.po` and the
 * `<domain>.pot` templates) live. The `wesnoth` submodule here is
 * data-only, so the full upstream checkout is used: `$WESNOTH_PO` if set,
 * else `wesnoth/po` in this repo, else the sibling checkout at
 * `~/wesnothweb/wesnoth/po`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export function findPoRoot() {
  const candidates = [
    process.env.WESNOTH_PO,
    path.join(repoRoot, 'wesnoth/po'),
    path.join(os.homedir(), 'wesnothweb/wesnoth/po'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(path.join(c, 'wesnoth'))) return c;
  throw new Error(`upstream po/ tree not found; set WESNOTH_PO (tried: ${candidates.join(', ')})`);
}
