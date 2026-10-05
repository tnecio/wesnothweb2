/**
 * Phase 24: the hotkey registry (`hotkey/hotkey_command.cpp`, `hotkey_item.cpp`). Every command a key can
 * reach, with upstream's default bindings from `data/core/hotkeys.cfg`, in that file's order of use in
 * the game; the player's own bindings, saved per browser like our other preferences, replace a command's
 * defaults as a whole, as upstream's saved `[hotkey]` entries do (a cleared command saves an empty list).
 *
 * The menus, the context menu and `GameShell`'s key handler all take their bindings from here
 * (`hotkeyPrefs.bindings`), and the preferences' Hotkeys tab edits them. Ids are the port's command ids; `upstream`
 * names the `hotkeys.cfg` command each one is.
 *
 * `parseHotkeyOverrides` and `bindingsFor` are pure (tested in node); `hotkeyPrefs` is the live store.
 */
import { createSubscriber } from 'svelte/reactivity';
import { usesCommandKey, type Hotkey } from './commands.js';
import { t, tx } from './i18n/locale.js';

export interface HotkeyCommand {
  /** The port's command id (`Command.id`). */
  readonly id: string;
  /** The `hotkeys.cfg` command name, where upstream has one. */
  readonly upstream?: string;
  /** Upstream's description of the command (`hotkey_command.cpp`), as the Hotkeys tab lists it. */
  readonly label: () => string;
  /** Upstream's default bindings. `mac` is the macOS variant where `hotkeys.cfg` has an `#ifdef APPLE`. */
  readonly defaults: readonly Hotkey[];
  readonly macDefaults?: readonly Hotkey[];
}

const ctrl = (key: string, more: Partial<Hotkey> = {}): Hotkey => ({ key, ctrl: true, ...more });

/** In the order `hotkeys.cfg` lists them, then the port's own keyboard-cursor commands. */
export const HOTKEY_COMMANDS: readonly HotkeyCommand[] = [
  { id: 'accelerated', upstream: 'accelerated', label: () => t('Toggle Accelerated Speed'), defaults: [ctrl('a')] },
  { id: 'best-enemy-moves', upstream: 'bestenemymoves', label: () => t('Best Possible Enemy Moves'), defaults: [ctrl('b')] },
  { id: 'clear-labels', upstream: 'clearlabels', label: () => t('Clear Labels'), defaults: [ctrl('c')] },
  { id: 'continue', upstream: 'continue', label: () => t('Continue Interrupted Move'), defaults: [{ key: 't' }] },
  { id: 'next-unit', upstream: 'cycle', label: () => t('Next Unit'), defaults: [{ key: 'n' }] },
  { id: 'previous-unit', upstream: 'cycleback', label: () => t('Previous Unit'), defaults: [{ key: 'n', shift: true }] },
  // `#ifdef APPLE alt=yes #else ctrl=yes`: Cmd+Space is the system's own on macOS.
  { id: 'end-turn', upstream: 'endturn', label: () => t('End Turn'), defaults: [ctrl(' ')], macDefaults: [{ key: ' ', alt: true }] },
  { id: 'help', upstream: 'help', label: () => t('Help'), defaults: [{ key: 'F1' }] },
  { id: 'label-team', upstream: 'labelteamterrain', label: () => t('Set Team Label'), defaults: [ctrl('l')] },
  { id: 'label', upstream: 'labelterrain', label: () => t('Set Label'), defaults: [{ key: 'l', alt: true }] },
  { id: 'leader', upstream: 'leader', label: () => t('Scroll to Leader'), defaults: [{ key: 'l' }] },
  { id: 'load', upstream: 'load', label: () => t('Load Game'), defaults: [ctrl('o')] },
  { id: 'mute', upstream: 'mute', label: () => t('Mute'), defaults: [ctrl('m', { alt: true })] },
  { id: 'objectives', upstream: 'objectives', label: () => t('Objectives'), defaults: [ctrl('j')] },
  { id: 'preferences', upstream: 'preferences', label: () => t('Preferences'), defaults: [ctrl('p')] },
  // Upstream's `quit` is Ctrl+W, which a browser keeps for closing the tab; the command has no default here.
  { id: 'quit-to-menu', upstream: 'quit', label: () => t('Quit to Menu'), defaults: [] },
  { id: 'recall', upstream: 'recall', label: () => t('Recall'), defaults: [{ key: 'r', alt: true }] },
  { id: 'recruit', upstream: 'recruit', label: () => t('Recruit'), defaults: [ctrl('r')] },
  { id: 'redo', upstream: 'redo', label: () => t('Redo'), defaults: [{ key: 'r' }] },
  { id: 'save', upstream: 'save', label: () => t('Save Game'), defaults: [ctrl('s')] },
  { id: 'show-enemy-moves', upstream: 'showenemymoves', label: () => t('Show Enemy Moves'), defaults: [ctrl('v')] },
  { id: 'toggle-ellipses', upstream: 'toggleellipses', label: () => t('Toggle Ellipses'), defaults: [ctrl('e')] },
  { id: 'toggle-grid', upstream: 'togglegrid', label: () => t('Toggle Grid'), defaults: [ctrl('g')] },
  { id: 'undo', upstream: 'undo', label: () => t('Undo'), defaults: [{ key: 'u' }] },
  { id: 'unit-list', upstream: 'unitlist', label: () => t('Unit List'), defaults: [{ key: 'u', alt: true }] },
  { id: 'zoom-default', upstream: 'zoomdefault', label: () => t('Default Zoom'), defaults: [{ key: '0' }] },
  // `zoomin` is bound twice: `=` and `+`, the shifted key on most layouts.
  { id: 'zoom-in', upstream: 'zoomin', label: () => t('Zoom In'), defaults: [{ key: '=' }, { key: '+', shift: true }] },
  { id: 'zoom-out', upstream: 'zoomout', label: () => t('Zoom Out'), defaults: [{ key: '-' }] },
  { id: 'language', upstream: 'changelanguage', label: () => t('Change Language'), defaults: [] },
  { id: 'label-settings', label: () => tx('Label Settings'), defaults: [] },
  // The port's keyboard cursor (Phase 15): upstream's arrow keys scroll the map instead, and its
  // `selectmoveaction` and `deselecthex` are bound to mouse buttons; here they act on the cursor's hex.
  { id: 'cursor-left', label: () => tx('Cursor Left'), defaults: [{ key: 'ArrowLeft' }] },
  { id: 'cursor-right', label: () => tx('Cursor Right'), defaults: [{ key: 'ArrowRight' }] },
  { id: 'cursor-up', label: () => tx('Cursor Up'), defaults: [{ key: 'ArrowUp' }] },
  { id: 'cursor-down', label: () => tx('Cursor Down'), defaults: [{ key: 'ArrowDown' }] },
  { id: 'cursor-act', upstream: 'selectmoveaction', label: () => t('Select/Move/Attack'), defaults: [{ key: 'Enter' }] },
  { id: 'deselect', upstream: 'deselecthex', label: () => t('Deselect Hex'), defaults: [{ key: 'Escape' }] },
];

const BY_ID = new Map(HOTKEY_COMMANDS.map((c) => [c.id, c]));

export function hotkeyCommand(id: string): HotkeyCommand | undefined {
  return BY_ID.get(id);
}

/** The player's bindings, by command id: each replaces that command's defaults. */
export type HotkeyOverrides = Readonly<Record<string, readonly Hotkey[]>>;

export const HOTKEYS_KEY = 'wesnothweb2.hotkeys';

function parseHotkey(v: unknown): Hotkey | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o['key'] !== 'string' || o['key'] === '') return null;
  const h: { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean } = { key: o['key'] };
  if (o['ctrl'] === true) h.ctrl = true;
  if (o['shift'] === true) h.shift = true;
  if (o['alt'] === true) h.alt = true;
  return h;
}

/** Reads what `hotkeyPrefs` wrote; unknown commands and malformed bindings are dropped. */
export function parseHotkeyOverrides(raw: string | null | undefined): HotkeyOverrides {
  let data: unknown;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const out: Record<string, Hotkey[]> = {};
  for (const [id, list] of Object.entries(data as Record<string, unknown>)) {
    if (!BY_ID.has(id) || !Array.isArray(list)) continue;
    out[id] = list.map(parseHotkey).filter((h): h is Hotkey => h !== null);
  }
  return out;
}

export function defaultBindings(command: HotkeyCommand, onMac = usesCommandKey()): readonly Hotkey[] {
  return onMac && command.macDefaults ? command.macDefaults : command.defaults;
}

/** A command's bindings: the player's, else upstream's defaults. */
export function bindingsFor(id: string, overrides: HotkeyOverrides, onMac = usesCommandKey()): readonly Hotkey[] {
  const own = overrides[id];
  if (own) return own;
  const command = BY_ID.get(id);
  return command ? defaultBindings(command, onMac) : [];
}

export function sameHotkey(a: Hotkey, b: Hotkey): boolean {
  return a.key.toLowerCase() === b.key.toLowerCase() && !!a.ctrl === !!b.ctrl && !!a.shift === !!b.shift && !!a.alt === !!b.alt;
}

/** The commands `hotkey` is bound to now, other than `exceptId` (`hotkey::has_hotkey_item` conflicts). */
export function commandsBoundTo(hotkey: Hotkey, overrides: HotkeyOverrides, exceptId?: string, onMac = usesCommandKey()): HotkeyCommand[] {
  return HOTKEY_COMMANDS.filter((c) => c.id !== exceptId && bindingsFor(c.id, overrides, onMac).some((b) => sameHotkey(b, hotkey)));
}

/**
 * Binds `hotkey` to `id` (`hotkey_bind` then `add_hotkey`): it is added to the command's bindings and
 * taken off any other command that had it, as upstream's reassignment does.
 */
export function addBinding(id: string, hotkey: Hotkey, overrides: HotkeyOverrides, onMac = usesCommandKey()): HotkeyOverrides {
  const next: Record<string, readonly Hotkey[]> = { ...overrides };
  for (const other of commandsBoundTo(hotkey, overrides, id, onMac)) {
    next[other.id] = bindingsFor(other.id, overrides, onMac).filter((b) => !sameHotkey(b, hotkey));
  }
  const own = bindingsFor(id, overrides, onMac);
  next[id] = own.some((b) => sameHotkey(b, hotkey)) ? own : [...own, hotkey];
  return next;
}

/** Clear Hotkey: the command keeps no binding (`clear_hotkeys(command)`). */
export function clearBindings(id: string, overrides: HotkeyOverrides): HotkeyOverrides {
  return { ...overrides, [id]: [] };
}

/**
 * The binding a keypress would make (`hotkey_bind`'s `sdl_event_`), or null while only modifiers are
 * down. Escape cancels in that dialog, so it is not offered here either.
 */
export function hotkeyFromEvent(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>, onMac = usesCommandKey()): Hotkey | null {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Escape', 'Dead', 'Unidentified'].includes(e.key)) return null;
  const h: { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean } = { key: e.key.length === 1 ? e.key.toLowerCase() : e.key };
  if (onMac ? e.metaKey : e.ctrlKey) h.ctrl = true;
  if (e.shiftKey) h.shift = true;
  if (e.altKey) h.alt = true;
  return h;
}

function load(): string | null {
  try {
    return localStorage.getItem(HOTKEYS_KEY);
  } catch {
    return null;
  }
}

class HotkeyPrefsStore {
  #value: HotkeyOverrides = parseHotkeyOverrides(load());
  #notify: () => void = () => {};
  #subscribe = createSubscriber((update) => {
    this.#notify = update;
    return () => {
      this.#notify = () => {};
    };
  });

  /** The player's bindings (reactive when read in a component or effect). */
  get overrides(): HotkeyOverrides {
    this.#subscribe();
    return this.#value;
  }

  bindings(id: string): readonly Hotkey[] {
    return bindingsFor(id, this.overrides);
  }

  set(next: HotkeyOverrides): void {
    this.#value = parseHotkeyOverrides(JSON.stringify(next));
    try {
      if (Object.keys(this.#value).length === 0) localStorage.removeItem(HOTKEYS_KEY);
      else localStorage.setItem(HOTKEYS_KEY, JSON.stringify(this.#value));
    } catch {
      /* lasts for this page only */
    }
    this.#notify();
  }

  /** Reset Defaults (`hotkey::reset_default_hotkeys`). */
  reset(): void {
    this.set({});
  }
}

export const hotkeyPrefs = new HotkeyPrefsStore();
