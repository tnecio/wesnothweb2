<script lang="ts">
  /**
   * Phase 14: real Wesnoth's right-click context menu -- a small popup at
   * the cursor listing whatever `Command[]` `GameShell.svelte` built for
   * the right-clicked hex (see `commands.ts`'s own doc comment: the SAME
   * registry shape `TopBar.svelte`'s dropdowns consume). Positioned at
   * raw viewport coordinates (`x`/`y`, from `SnapshotBoard`'s
   * `onHexRightClick`'s `clientX`/`clientY`), clamped so it never renders
   * off the right/bottom edge of the window.
   */
  import type { Command } from './commands.js';

  let {
    x,
    y,
    commands,
    onClose,
  }: {
    x: number;
    y: number;
    commands: readonly Command[];
    onClose: () => void;
  } = $props();

  let menuEl: HTMLDivElement | undefined = $state();
  let style = $state('');

  $effect(() => {
    if (!menuEl) return;
    const rect = menuEl.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 4);
    const top = Math.min(y, window.innerHeight - rect.height - 4);
    style = `left: ${Math.max(0, left)}px; top: ${Math.max(0, top)}px;`;
  });

  function run(cmd: Command): void {
    if (!cmd.enabled) return;
    cmd.handler();
    onClose();
  }

  function handleWindowClick(e: MouseEvent): void {
    if (menuEl && !menuEl.contains(e.target as Node)) onClose();
  }
  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onclick={handleWindowClick} oncontextmenu={handleWindowClick} onkeydown={handleKeydown} />

<div class="context-menu" bind:this={menuEl} {style} role="menu">
  {#each commands as cmd (cmd.id)}
    <button role="menuitem" disabled={!cmd.enabled} onclick={() => run(cmd)}>{cmd.label}</button>
  {/each}
</div>

<style>
  .context-menu {
    position: fixed;
    z-index: 60;
    display: flex;
    flex-direction: column;
    min-width: 11rem;
    background: #1a1710;
    border: 1px solid #8a6a2e;
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    padding: 0.25rem 0;
    font-family: var(--font-ui);
    font-size: 0.85rem;
  }
  .context-menu button {
    font: inherit;
    text-align: left;
    padding: 0.4rem 0.9rem;
    border: none;
    background: transparent;
    color: #eee;
    cursor: pointer;
  }
  .context-menu button:hover:not(:disabled) {
    background: #35301f;
  }
  .context-menu button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  /* Phase 23, a finger (the menu opens on a long press): entries at least 44 px tall. */
  @media (pointer: coarse) {
    .context-menu button {
      min-height: 44px;
    }
  }
</style>
