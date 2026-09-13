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
}
