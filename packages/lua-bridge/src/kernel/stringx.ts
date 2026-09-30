/**
 * The C++ halves of `stringx` and `mathx` (`lua_stringx.cpp`, `lua_mathx.cpp`), with the string utilities they
 * call (`serialization/string_utils.cpp`, `formula/string_utils.cpp`). Their Lua halves are
 * `data/lua/core/stringx.lua` and `mathx.lua`, run unchanged by `load_core`.
 */
import { TString } from '@wesnothweb2/engine/src/i18n/tstring.js';
import { dsgettext } from '@wesnothweb2/engine/src/i18n/gettext.js';
import { formatMessage } from '@wesnothweb2/engine/src/i18n/format.js';
import { VariableStore, varNodeFromConfig } from '@wesnothweb2/engine/src/events/variables.js';
import type { Rng } from '@wesnothweb2/engine/src/rng/Rng.js';
import {
  lua,
  lauxlib,
  to_luastring,
  argError,
  checkInteger,
  checkString,
  luaError,
  optString,
  pushString,
  pushStringArray,
  tableGet,
  toBoolean,
  type LuaKernel,
  type LuaState,
} from './kernel.js';

const REMOVE_EMPTY = 0x01;
const STRIP_SPACES = 0x02;

const isSpace = (c: string): boolean => c === '\r' || c === '\n' || c === ' ' || c === '\t' || c === '\v' || c === '\f';

/** `boost::trim` (the locale's spaces; ASCII here). */
function trim(s: string): string {
  return s.replace(/^[\s]+|[\s]+$/g, '');
}

/** `utils::trim` on a view: only space, tab, CR and LF. */
function trimView(s: string): string {
  return s.replace(/^[ \t\r\n]+/, '').replace(/[ \t\r\n]+$/, '');
}

/** `utils::split`. */
export function split(s: string, sep = ',', flags = REMOVE_EMPTY | STRIP_SPACES): string[] {
  const out: string[] = [];
  if (s === '') return out;
  for (let item of s.split(sep)) {
    if (flags & STRIP_SPACES) item = trimView(item);
    if (!(flags & REMOVE_EMPTY) || item !== '') out.push(item);
  }
  return out;
}

/** `utils::quoted_split`. */
export function quotedSplit(val: string, c = ',', flags = REMOVE_EMPTY | STRIP_SPACES, quote = '\\'): string[] {
  const out: string[] = [];
  let i1 = 0;
  let i2 = 0;
  const push = (v: string) => {
    if (flags & STRIP_SPACES) v = trim(v);
    if (!(flags & REMOVE_EMPTY) || v !== '') out.push(v);
  };
  while (i2 < val.length) {
    if (val[i2] === quote) {
      i2++;
      if (i2 < val.length) i2++;
    } else if (val[i2] === c) {
      push(val.slice(i1, i2));
      i2++;
      if (flags & STRIP_SPACES) while (i2 < val.length && val[i2] === ' ') i2++;
      i1 = i2;
    } else i2++;
  }
  push(val.slice(i1, i2));
  return out;
}

/** `utils::parenthetical_split` (a separator of `''` splits into parenthesised and bare parts). */
export function parentheticalSplit(val: string, separator: string, left = '(', right = ')', flags = REMOVE_EMPTY | STRIP_SPACES): string[] {
  const out: string[] = [];
  const part: string[] = [];
  let inParenthesis = false;
  let i1 = 0;
  if (flags & STRIP_SPACES) while (i1 < val.length && isSpace(val[i1]!)) i1++;
  let i2 = i1;
  if (left.length !== right.length) return out;
  while (i2 < val.length) {
    const ch = val[i2]!;
    if (!inParenthesis && separator && ch === separator) {
      let v = val.slice(i1, i2);
      if (flags & STRIP_SPACES) v = v.replace(/\s+$/, '');
      if (!(flags & REMOVE_EMPTY) || v !== '') out.push(v);
      i2++;
      if (flags & STRIP_SPACES) while (i2 < val.length && isSpace(val[i2]!)) i2++;
      i1 = i2;
      continue;
    }
    if (part.length > 0 && ch === part[part.length - 1]) {
      part.pop();
      if (!separator && part.length === 0) {
        let v = val.slice(i1, i2);
        if (flags & STRIP_SPACES) v = trim(v);
        out.push(v);
        i2++;
        i1 = i2;
      } else {
        if (part.length === 0) inParenthesis = false;
        i2++;
      }
      continue;
    }
    let found = false;
    for (let i = 0; i < left.length; i++) {
      if (ch === left[i]) {
        if (!separator && part.length === 0) {
          let v = val.slice(i1, i2);
          if (flags & STRIP_SPACES) v = trim(v);
          out.push(v);
          i2++;
          i1 = i2;
        } else i2++;
        part.push(right[i]!);
        found = true;
        break;
      }
    }
    if (!found) i2++;
    else inParenthesis = true;
  }
  let v = val.slice(i1, i2);
  if (flags & STRIP_SPACES) v = trim(v);
  if (!(flags & REMOVE_EMPTY) || v !== '') out.push(v);
  return out;
}

/** `utils::map_split`: later keys win, and the result is ordered by key (a `std::map`). */
export function mapSplit(val: string, major: string, minor: string, flags: number, defaultValue: string): Map<string, string> {
  const res = new Map<string, string>();
  for (const item of split(val, major, flags)) {
    const pos = item.indexOf(minor);
    if (pos < 0) res.set(item, defaultValue);
    else res.set(item.slice(0, pos), item.slice(pos + 1));
  }
  return new Map([...res.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** `utils::stoi`: surrounding spaces allowed, then a whole integer. */
function stoi(s: string): number {
  const t = s.trim();
  const m = /^[+-]?\d+/.exec(t);
  if (!m) throw new Error('invalid');
  return Number(m[0]);
}

function stod(s: string): number {
  const t = s.trim();
  const m = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(t);
  if (!m) throw new Error('invalid');
  return Number(m[0]);
}

const INT_MIN = -2147483648;
const INT_MAX = 2147483647;

function rangeSeparator(str: string): [string, string | undefined] {
  const pos = str.indexOf('-', 1);
  if (pos >= 0 && pos + 1 < str.length) return [str.slice(0, pos), str.slice(pos + 1)];
  return [str, undefined];
}

/** `utils::parse_range`. */
export function parseRange(str: string): [number, number] {
  const [a, b] = rangeSeparator(str);
  const res: [number, number] = [0, 0];
  try {
    res[0] = a === '-infinity' && b !== undefined ? INT_MIN : stoi(a);
    if (b === undefined) res[1] = res[0];
    else if (b === 'infinity') res[1] = INT_MAX;
    else {
      res[1] = stoi(b);
      if (res[1] < res[0]) res[1] = res[0];
    }
  } catch {
    // Invalid range: upstream logs and keeps what it parsed.
  }
  return res;
}

/** `utils::parse_range_real`. */
export function parseRangeReal(str: string): [number, number] {
  const [a, b] = rangeSeparator(str);
  const res: [number, number] = [0, 0];
  try {
    res[0] = a === '-infinity' && b !== undefined ? -Infinity : stod(a);
    if (b === undefined) res[1] = res[0];
    else if (b === 'infinity') res[1] = Infinity;
    else {
      res[1] = stod(b);
      if (res[1] < res[0]) res[1] = res[0];
    }
  } catch {
    // As parseRange.
  }
  return res;
}

const VGETTEXT = (msgid: string, symbols: Record<string, string>): string => formatMessage(dsgettext('wesnoth', msgid), symbols);

/** `utils::format_conjunct_list` / `format_disjunct_list`. */
export function formatList(conjunct: boolean, empty: string, elems: readonly string[]): string {
  const k = conjunct ? 'conjunct' : 'disjunct';
  const word = conjunct ? 'and' : 'or';
  if (elems.length === 0) return empty;
  if (elems.length === 1) return elems[0]!;
  if (elems.length === 2) return VGETTEXT(`${k} pair^$first ${word} $second`, { first: elems[0]!, second: elems[1]! });
  let prefix = VGETTEXT(`${k} start^$first, $second`, { first: elems[0]!, second: elems[1]! });
  for (let i = 2; i < elems.length - 1; i++) prefix = VGETTEXT(`${k} mid^$prefix, $next`, { prefix, next: elems[i]! });
  return VGETTEXT(`${k} end^$prefix, ${word} $last`, { prefix, last: elems[elems.length - 1]! });
}

function tableGetDefault(T: LuaState, idx: number, key: string, fallback: boolean): boolean {
  if (!tableGet(T, idx, key)) return fallback;
  const v = toBoolean(T, -1);
  lua.lua_pop(T, 1);
  return v;
}

/** Calls the global `tostring` on the value at `idx`. */
function luaToString(T: LuaState, idx: number): string {
  const abs = lua.lua_absindex(T, idx);
  lua.lua_getglobal(T, to_luastring('tostring'));
  lua.lua_pushvalue(T, abs);
  lua.lua_call(T, 1, 1);
  const s = checkString(T, -1);
  lua.lua_pop(T, 1);
  return s;
}

export function installStringx(k: LuaKernel): void {
  const L = k.L;
  k.defineAll(['stringx'], {
    split: (T) => {
      const str = checkString(T, 1);
      const sep = optString(T, 2, ',');
      let type: 'basic' | 'escaped' | 'paren' = 'basic';
      let left = '';
      let right = '';
      let flags = REMOVE_EMPTY | STRIP_SPACES;
      if (lua.lua_istable(T, 3)) {
        flags = 0;
        if (tableGetDefault(T, 3, 'remove_empty', true)) flags |= REMOVE_EMPTY;
        if (tableGetDefault(T, 3, 'strip_spaces', true)) flags |= STRIP_SPACES;
        const anim = tableGetDefault(T, 3, 'expand_anim', false);
        if (anim) return luaError(T, 'stringx.split: expand_anim is not available in this port yet');
        if (tableGet(T, 3, 'escape')) {
          type = 'escaped';
          left = checkString(T, -1);
          if (left.length !== 1) return luaError(T, 'escape must be a single character');
        } else if (tableGet(T, 3, 'quote')) {
          left = right = checkString(T, -1);
          type = 'paren';
        } else if (tableGet(T, 3, 'quote_left') && tableGet(T, 3, 'quote_right')) {
          left = checkString(T, -2);
          right = checkString(T, -1);
          type = 'paren';
        }
        if (type !== 'escaped' && left.length !== right.length) return luaError(T, 'left and right need to be strings of the same length');
      }
      const s = sep[0] ?? '\0';
      const parts = type === 'basic' ? split(str, s, flags) : type === 'escaped' ? quotedSplit(str, s, flags, left[0]) : parentheticalSplit(str, s, left, right, flags);
      pushStringArray(T, parts);
      return 1;
    },
    parenthetical_split: (T) => {
      const str = checkString(T, 1);
      const left = optString(T, 2, '(');
      const right = optString(T, 3, ')');
      if (left.length !== right.length) return luaError(T, 'left and right need to be strings of the same length');
      const strip = lua.lua_isnoneornil(T, 4) ? true : toBoolean(T, 4);
      pushStringArray(T, parentheticalSplit(str, '', left, right, strip ? STRIP_SPACES : 0));
      return 1;
    },
    map_split: (T) => {
      const str = checkString(T, 1);
      const sep = optString(T, 2, ',');
      const kv = optString(T, 3, ':');
      if (sep.length !== 1) return luaError(T, 'separator must be a single character');
      if (kv.length !== 1) return luaError(T, 'key_value_separator must be a single character');
      let flags = REMOVE_EMPTY | STRIP_SPACES;
      let dflt = '';
      if (lua.lua_istable(T, 4)) {
        flags = 0;
        if (tableGetDefault(T, 4, 'remove_empty', true)) flags |= REMOVE_EMPTY;
        if (tableGetDefault(T, 4, 'strip_spaces', true)) flags |= STRIP_SPACES;
        if (tableGet(T, 4, 'default')) dflt = checkString(T, -1);
      }
      const map = mapSplit(str, sep, kv, flags, dflt);
      lua.lua_createtable(T, 0, map.size);
      for (const [key, value] of map) {
        pushString(T, value);
        lua.lua_setfield(T, -2, to_luastring(key));
      }
      return 1;
    },
    join: (T) => {
      let sep: string;
      let listIdx: number;
      if (lua.lua_istable(T, 1)) {
        listIdx = 1;
        sep = optString(T, 2, ',');
      } else if (lua.lua_istable(T, 2)) {
        sep = checkString(T, 1);
        listIdx = 2;
      } else return luaError(T, 'invalid arguments to join, should have map and separator');
      const pieces: string[] = [];
      for (let i = 1; i <= lauxlib.luaL_len(T, listIdx); i++) {
        lua.lua_geti(T, listIdx, i);
        pieces.push(luaToString(T, -1));
        lua.lua_pop(T, 1);
      }
      pushString(T, pieces.join(sep));
      return 1;
    },
    join_map: (T) => {
      let sep: string;
      let kv: string;
      let mapIdx: number;
      if (lua.lua_istable(T, 1)) {
        mapIdx = 1;
        sep = optString(T, 2, ',');
        kv = optString(T, 3, ':');
      } else if (lua.lua_istable(T, 2)) {
        sep = checkString(T, 1);
        mapIdx = 2;
        kv = optString(T, 3, ':');
      } else if (lua.lua_istable(T, 3)) {
        sep = checkString(T, 1);
        kv = checkString(T, 2);
        mapIdx = 3;
      } else return luaError(T, 'invalid arguments to join_map, should have map, separator, and key_value_separator');
      const pieces = new Map<string, string>();
      lua.lua_pushnil(T);
      while (lua.lua_next(T, mapIdx) !== 0) {
        pieces.set(luaToString(T, -2), luaToString(T, -1));
        lua.lua_pop(T, 1);
      }
      const sorted = [...pieces.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      pushString(T, sorted.map(([key, value]) => `${key}${kv}${value}`).join(sep));
      return 1;
    },
    trim: (T) => {
      pushString(T, trim(checkString(T, 1)));
      return 1;
    },
    parse_range: (T) => {
      const str = checkString(T, 1);
      if (!lua.lua_isnoneornil(T, 2) && lua.lua_toboolean(T, 2)) {
        const [a, b] = parseRangeReal(str);
        lua.lua_pushnumber(T, a);
        lua.lua_pushnumber(T, b);
      } else {
        const [a, b] = parseRange(str);
        lua.lua_pushinteger(T, a);
        lua.lua_pushinteger(T, b);
      }
      return 2;
    },
    vformat: (T) => {
      // `config_variable_set` over the table: `$name` reads its attributes (and `$name[i].x` its children).
      const vars = new VariableStore(varNodeFromConfig(k.checkConfig(T, 2)));
      if (lua.lua_isstring(T, 1)) {
        pushString(T, vars.substitute(checkString(T, 1)));
        return 1;
      }
      const str = k.checkTString(T, 1);
      const frozen = vars.snapshot();
      k.pushTString(T, str.translatable ? TString.interpolated(str, (text) => frozen.substitute(text)) : TString.literal(vars.substitute(str.str())));
      return 1;
    },
    format_conjunct_list: (T) => formatListFn(k, T, true),
    format_disjunct_list: (T) => formatListFn(k, T, false),
  });

  // stringx indexes string; strings index stringx (so `s:split()` and `s:vformat{}` work), and a string may be
  // indexed by a number (`s[2]`).
  lua.lua_getglobal(L, to_luastring('stringx'));
  lua.lua_createtable(L, 0, 1);
  lua.lua_getglobal(L, to_luastring('string'));
  lua.lua_setfield(L, -2, to_luastring('__index'));
  lua.lua_setmetatable(L, -2);
  lua.lua_pop(L, 1);

  lua.lua_pushstring(L, to_luastring(''));
  lua.lua_getmetatable(L, -1);
  lua.lua_pushcfunction(L, (T: LuaState) => {
    if (lua.lua_type(T, 2) === lua.LUA_TSTRING) {
      lua.lua_getglobal(T, to_luastring('stringx'));
      lua.lua_pushvalue(T, 2);
      lua.lua_gettable(T, -2);
      return 1;
    }
    if (lua.lua_type(T, 2) === lua.LUA_TNUMBER) {
      const len = lua.lua_rawlen(T, 1);
      const i = checkInteger(T, 2);
      if (i === 0 || Math.abs(i) > len) {
        lua.lua_pushnil(T);
        return 1;
      }
      lua.lua_getglobal(T, to_luastring('string'));
      lua.lua_getfield(T, -1, to_luastring('sub'));
      lua.lua_pushvalue(T, 1);
      lua.lua_pushvalue(T, 2);
      lua.lua_pushvalue(T, 2);
      lua.lua_call(T, 3, 1);
      return 1;
    }
    return 0;
  });
  lua.lua_setfield(L, -2, to_luastring('__index'));
  lua.lua_pop(L, 2);

  // string.format accepts a translatable string as its format.
  lua.lua_getglobal(L, to_luastring('string'));
  lua.lua_getfield(L, -1, to_luastring('format'));
  lua.lua_pushcclosure(
    L,
    (T: LuaState) => {
      const nargs = lua.lua_gettop(T);
      if (k.isTStringLike(T, 1)) {
        lua.lua_getglobal(T, to_luastring('tostring'));
        lua.lua_pushvalue(T, 1);
        lua.lua_call(T, 1, 1);
        lua.lua_replace(T, 1);
      }
      lua.lua_pushvalue(T, lua.lua_upvalueindex(1));
      lua.lua_insert(T, 1);
      lua.lua_call(T, nargs, 1);
      return 1;
    },
    1,
  );
  lua.lua_setfield(L, -2, to_luastring('format'));
  lua.lua_pop(L, 1);
}

function formatListFn(k: LuaKernel, T: LuaState, conjunct: boolean): number {
  const empty = k.checkTString(T, 1).str();
  if (!lua.lua_istable(T, 2)) return argError(T, 2, 'table expected');
  const values: string[] = [];
  for (let i = 1, n = lauxlib.luaL_len(T, 2); i <= n; i++) {
    lua.lua_geti(T, 2, i);
    values.push(k.checkTString(T, -1).str());
    lua.lua_pop(T, 1);
  }
  pushString(T, formatList(conjunct, empty, values));
  return 1;
}

/** `lua_mathx.cpp`: `random` draws from the game's generator (`randomness::generator`), so replays repeat. */
export function installMathx(k: LuaKernel, rng: () => Rng): void {
  const L = k.L;
  k.defineAll(['mathx'], {
    random: (T) => {
      const gen = rng();
      if (lua.lua_isnoneornil(T, 1)) {
        lua.lua_pushnumber(T, gen.nextRandom() / 4294967296);
        return 1;
      }
      let min: number;
      let max: number;
      if (lua.lua_isnumber(T, 2)) {
        min = checkInteger(T, 1);
        max = checkInteger(T, 2);
      } else {
        min = 1;
        max = checkInteger(T, 1);
      }
      if (min > max) return argError(T, 1, 'min > max');
      lua.lua_pushinteger(T, gen.getRandomInt(min, max));
      return 1;
    },
    round: (T) => {
      const n = lua.lua_tonumber(T, 1);
      // std::round: halves away from zero.
      lua.lua_pushinteger(T, Math.sign(n) * Math.round(Math.abs(n)));
      return 1;
    },
  });
  lua.lua_getglobal(L, to_luastring('mathx'));
  lua.lua_createtable(L, 0, 1);
  lua.lua_getglobal(L, to_luastring('math'));
  lua.lua_setfield(L, -2, to_luastring('__index'));
  lua.lua_setmetatable(L, -2);
  lua.lua_pop(L, 1);
}
