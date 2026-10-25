/**
 * Where the port's source and licences are (Phase 28 S9): the source link is what satisfies the GPL's
 * source offer for the deployed game, and the licence files ship with it (`apps/web/public/licenses/`).
 */
export const SOURCE_URL = 'https://github.com/tnecio/wesnothweb2';

/** Upstream Battle for Wesnoth's own site -- this port's game content and design all come from there. */
export const WESNOTH_ORG_URL = 'https://wesnoth.org';

/** Upstream's Liberapay: donations go to the Wesnoth project, not to this (unofficial) port. */
export const WESNOTH_DONATE_URL = 'https://liberapay.com/Wesnoth/donate';

/** The licence files, as paths `dataUrl` resolves. */
export const LICENSE_FILES = {
  readme: 'licenses/README.txt',
  gpl: 'licenses/COPYING.txt',
  wesnothCopyrights: 'licenses/wesnoth-copyrights.csv',
} as const;
