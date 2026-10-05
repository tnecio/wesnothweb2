import { describe, expect, it } from 'vitest';
import {
  HOTKEY_COMMANDS,
  addBinding,
  bindingsFor,
  clearBindings,
  commandsBoundTo,
  hotkeyFromEvent,
  parseHotkeyOverrides,
} from './hotkeys.js';

const key = (k: string, mods: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('hotkey registry', () => {
  it('has upstream hotkeys.cfg defaults', () => {
    expect(bindingsFor('recruit', {}, false)).toEqual([{ key: 'r', ctrl: true }]);
    expect(bindingsFor('zoom-in', {}, false)).toEqual([{ key: '=' }, { key: '+', shift: true }]);
    // #ifdef APPLE alt=yes #else ctrl=yes
    expect(bindingsFor('end-turn', {}, false)).toEqual([{ key: ' ', ctrl: true }]);
    expect(bindingsFor('end-turn', {}, true)).toEqual([{ key: ' ', alt: true }]);
    expect(new Set(HOTKEY_COMMANDS.map((c) => c.id)).size).toBe(HOTKEY_COMMANDS.length);
  });

  it('a player binding replaces the defaults; a cleared command has none', () => {
    const o = clearBindings('undo', {});
    expect(bindingsFor('undo', o, false)).toEqual([]);
    expect(bindingsFor('redo', o, false)).toEqual([{ key: 'r' }]);
  });

  it('adding a key bound elsewhere moves it', () => {
    const k = { key: 'r' };
    expect(commandsBoundTo(k, {}, 'undo', false).map((c) => c.id)).toEqual(['redo']);
    const o = addBinding('undo', k, {}, false);
    expect(bindingsFor('undo', o, false)).toEqual([{ key: 'u' }, { key: 'r' }]);
    expect(bindingsFor('redo', o, false)).toEqual([]);
    // Adding the same key again changes nothing.
    expect(bindingsFor('undo', addBinding('undo', k, o, false), false)).toEqual([{ key: 'u' }, { key: 'r' }]);
  });

  it('parses what it saved, dropping unknown commands and bad entries', () => {
    const o = addBinding('undo', { key: 'z', ctrl: true }, {}, false);
    expect(parseHotkeyOverrides(JSON.stringify(o))).toEqual(o);
    expect(parseHotkeyOverrides('{"nope":[{"key":"x"}],"undo":[{"key":""},{"key":"q","shift":true,"ctrl":"yes"}]}')).toEqual({ undo: [{ key: 'q', shift: true }] });
    expect(parseHotkeyOverrides('not json')).toEqual({});
    expect(parseHotkeyOverrides(null)).toEqual({});
  });

  it('reads a binding from a keypress', () => {
    expect(hotkeyFromEvent(key('Shift', { shiftKey: true }), false)).toBeNull();
    expect(hotkeyFromEvent(key('Escape'), false)).toBeNull();
    expect(hotkeyFromEvent(key('R', { ctrlKey: true, shiftKey: true }), false)).toEqual({ key: 'r', ctrl: true, shift: true });
    expect(hotkeyFromEvent(key('k', { metaKey: true }), true)).toEqual({ key: 'k', ctrl: true });
    expect(hotkeyFromEvent(key('F2'), false)).toEqual({ key: 'F2' });
  });
});
