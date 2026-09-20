/**
 * Phase 14: a single command registry (id/label/enabled/handler) that
 * `TopBar.svelte`'s menu bar and `ContextMenu.svelte`'s right-click menu
 * both dispatch through, per real Wesnoth's own hotkey_command model
 * (`src/hotkey/hotkey_command.cpp`) -- deliberately NOT a full port of
 * that (no icon/tooltip/scope/category fields), just enough real
 * structure for a second consumer (the context menu) to reuse the exact
 * same command definitions the menu bar already needed, rather than each
 * hand-rolling its own list. `GameShell.svelte` builds the actual command
 * list(s) as `$derived` values (they close over live session state/
 * handlers, which this module -- deliberately dependency-free -- has no
 * access to). Phase 15's keyboard shortcuts are expected to dispatch
 * through this same shape later.
 */
export interface Command {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly handler: () => void;
  /** Phase 15: this command's keyboard binding -- shown in menus, dispatched by `GameShell`'s global handler. */
  readonly hotkey?: Hotkey;
}

/**
 * Phase 15: one keyboard binding, in the shape upstream's own `[hotkey]`
 * blocks use (`data/core/hotkeys.cfg`: a `key=` plus `ctrl=`/`shift=`/
 * `alt=` flags).
 *
 * `key` is matched against `KeyboardEvent.key` case-insensitively, so
 * `'r'` matches however the OS reports its case; `shift` still has to
 * match exactly, which is what separates `n` (next unit) from `shift+n`
 * (previous unit). Non-character keys use the DOM's own names
 * (`'Enter'`, `'Escape'`, `'ArrowLeft'`, `' '` for space).
 *
 * `ctrl` means "the platform's command modifier": Control everywhere,
 * Command on macOS -- the same split upstream's `{IF_APPLE_CMD_ELSE_CTRL}`
 * macro makes for most of these bindings.
 */
export interface Hotkey {
  readonly key: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

/** True on macOS, where `Hotkey.ctrl` means the Command key (see `Hotkey`). */
export function usesCommandKey(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = (navigator as Navigator & { platform?: string }).platform ?? '';
  return /Mac|iPhone|iPad/.test(platform || navigator.userAgent);
}

/**
 * Whether `event` is exactly `hotkey`: same key, same set of modifiers.
 * A modifier the binding doesn't name must NOT be held, so recruit
 * (`ctrl+r`) never fires on the browser's own `ctrl+shift+r`.
 */
export function matchesHotkey(event: KeyboardEvent, hotkey: Hotkey): boolean {
  if (event.key.toLowerCase() !== hotkey.key.toLowerCase()) return false;
  const onMac = usesCommandKey();
  const commandHeld = onMac ? event.metaKey : event.ctrlKey;
  const otherModifier = onMac ? event.ctrlKey : event.metaKey;
  return (
    commandHeld === !!hotkey.ctrl &&
    event.shiftKey === !!hotkey.shift &&
    event.altKey === !!hotkey.alt &&
    !otherModifier
  );
}

/**
 * Phase 15 H4: whether an Enter keypress belongs to the focused control
 * rather than to the dialog's primary action.
 *
 * `Modal` focuses the first focusable element, which in a list dialog is
 * the first list option -- Enter there should confirm the dialog, not
 * merely re-pick the option already highlighted. Buttons that do their
 * own thing (Cancel, Rename, Damage Calculations) carry no
 * `data-list-option`, so Enter is left to them.
 */
export function onPlainButton(target: EventTarget | null): boolean {
  return target instanceof HTMLButtonElement && !target.hasAttribute('data-list-option');
}

/** Display names for keys whose `KeyboardEvent.key` reads badly in a menu. */
const KEY_LABELS: Record<string, string> = {
  ' ': 'Space',
  escape: 'Esc',
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  enter: 'Enter',
};

/** A menu-ready label for a binding, e.g. `Ctrl+Space` (`⌘+Space` on macOS). */
export function formatHotkey(hotkey: Hotkey): string {
  const onMac = usesCommandKey();
  const parts: string[] = [];
  if (hotkey.ctrl) parts.push(onMac ? '⌘' : 'Ctrl');
  if (hotkey.alt) parts.push(onMac ? '⌥' : 'Alt');
  if (hotkey.shift) parts.push('Shift');
  const lower = hotkey.key.toLowerCase();
  parts.push(KEY_LABELS[lower] ?? (hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key));
  return parts.join('+');
}
