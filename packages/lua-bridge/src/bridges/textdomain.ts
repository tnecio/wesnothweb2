/**
 * `wesnoth.textdomain(domain)`, the Lua side of translation. Upstream's returns a callable that
 * yields a translatable string userdata (`tstring`); here it yields the translated plain string
 * (Lua strings cannot follow a later language switch -- real `tstring` userdata is Phase 29).
 * The lookup is the engine's own `dsgettext`/`dsngettext`, so `_ "female^Name"` strips its
 * context and plural forms follow the catalogue's rule exactly as in WML.
 */
import { dsgettext, dsngettext } from '@wesnothweb2/engine/src/i18n/gettext.js';
import { setNestedField, type LuaState } from '../luaEnv.js';

export const TEXTDOMAIN_LUA_SOURCE = `
-- wesnoth.textdomain(domain) -> _ ; _"msgid" or _("singular", "plural", n)
function wesnoth.textdomain(domain)
  return function(msgid, plural, n)
    if plural ~= nil then
      return wesnoth.__ngettext(nil, domain, msgid, plural, n)
    end
    return wesnoth.__gettext(nil, domain, msgid)
  end
end
`;

/** Installs `wesnoth.textdomain` (assumes bootstrap.ts's `wesnoth` global table already exists). */
export function installTextdomainBridge(L: LuaState, run: (source: string) => void): void {
  // fengari-interop hands the first Lua argument to a JS function as `this`, so the Lua side passes nil first.
  setNestedField(L, ['wesnoth', '__gettext'], (domain: string, msgid: string) => dsgettext(domain, msgid));
  setNestedField(L, ['wesnoth', '__ngettext'], (domain: string, singular: string, plural: string, n: number) =>
    dsngettext(domain, singular, plural, Number(n)),
  );
  run(TEXTDOMAIN_LUA_SOURCE);
}
