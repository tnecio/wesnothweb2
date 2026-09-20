<script lang="ts">
  /**
   * Shared modal framework (Phase 13): a GUI2-like overlay + dark,
   * gold-bordered dialog box, Escape-to-close, and a basic focus trap --
   * reused by every real Wesnoth dialog this project ports (recruit,
   * recall, attack, damage-calculation, and the pre-existing
   * AdvancementDialog/ObjectivesDialog, migrated onto this rather than
   * each hand-rolling its own overlay). Not a pixel-accurate recreation of
   * real Wesnoth's 9-slice parchment/stone dialog chrome (no real texture
   * assets are sliced here) -- a solid dark panel with a gold border and
   * title bar, close enough to read as "the same kind of dialog" without
   * needing to hunt down and slice real GUI2 image assets, consistent
   * with this project's general chrome-approximation stance elsewhere
   * (e.g. `SidePanel.svelte`'s own plain-CSS panels).
   *
   * Escape closes the dialog only if a caller supplies `onClose` --
   * dialogs with no safe "cancel" state (there are none currently, but a
   * future one could omit it to force an explicit button choice).
   */
  import type { Snippet } from 'svelte';

  let {
    title,
    onClose,
    width = '40rem',
    labelledBy,
    children,
  }: {
    title?: string;
    onClose?: () => void;
    /** CSS width (e.g. `'52rem'`); the box never exceeds 95vw regardless. */
    width?: string;
    /** Use instead of `title` when the dialog draws its own heading inside `children` (e.g. a two-column layout with no single title bar) -- sets `aria-label` directly rather than relying on a `.modal-title` element that doesn't exist. */
    labelledBy?: string;
    children: Snippet;
  } = $props();

  let boxEl: HTMLDivElement | undefined = $state();

  function focusableElements(): HTMLElement[] {
    if (!boxEl) return [];
    return Array.from(boxEl.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && onClose) {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'Tab') {
      const items = focusableElements();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  $effect(() => {
    // Phase 15: a dialog whose first focusable element isn't the one a
    // keyboard user wants (the recall list's first button is "Rename")
    // marks the right one with `data-autofocus`.
    const preferred = boxEl?.querySelector<HTMLElement>('[data-autofocus]');
    const target = preferred ?? focusableElements()[0] ?? boxEl;
    target?.focus();
  });
</script>

<div class="modal-overlay">
  <div
    class="modal-box"
    style:width
    bind:this={boxEl}
    role="dialog"
    aria-modal="true"
    aria-label={labelledBy ?? title}
    tabindex="-1"
    onkeydown={handleKeydown}
  >
    {#if title}
      <div class="modal-title">{title}</div>
    {/if}
    <div class="modal-body">
      {@render children()}
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.6);
    font-family: sans-serif;
  }
  .modal-box {
    max-width: 95vw;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    background: linear-gradient(#131722, #0a0d15);
    border: 2px solid #8a6a2e;
    border-radius: 6px;
    box-shadow:
      0 8px 32px rgba(0, 0, 0, 0.7),
      inset 0 0 0 1px rgba(255, 213, 74, 0.15);
    color: #d7cba8;
    outline: none;
  }
  .modal-title {
    padding: 0.6rem 1rem;
    font-size: 1.15rem;
    font-weight: 700;
    color: #e4c860;
    border-bottom: 1px solid #4a3d1e;
    flex: 0 0 auto;
  }
  .modal-body {
    padding: 1rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
</style>
