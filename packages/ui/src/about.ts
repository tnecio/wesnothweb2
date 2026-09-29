/**
 * Where the port's source and licences are (Phase 28 S9): the source link is what satisfies the GPL's
 * source offer for the deployed game, and the licence files ship with it (`apps/web/public/licenses/`).
 */
export const SOURCE_URL = 'https://github.com/tnecio/wesnothweb2';

/** The licence files, as paths `dataUrl` resolves. */
export const LICENSE_FILES = {
  readme: 'licenses/README.txt',
  gpl: 'licenses/COPYING.txt',
  wesnothCopyrights: 'licenses/wesnoth-copyrights.csv',
} as const;
