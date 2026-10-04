<script lang="ts">
  /**
   * Phase 28c: a campaign's own dialog (`gui.show_dialog`), drawn from its `[resolution]` WML as the engine
   * modelled it (`guiDialog.ts`): grids of rows and columns with their borders and alignment, labels (Pango
   * markup when `use_markup=yes`, larger for `definition=title`), images, buttons, menu buttons, spacers, and
   * listboxes whose rows the player picks. A button answers `click:<id>` with its return value (its Lua callback
   * runs; a return value of 0 leaves the dialog open); picking a listbox row or a menu button's option answers
   * `select:<id>:<row>` and the dialog stays open unless the campaign's callback closes it; Escape cancels.
   */
  import Modal from './Modal.svelte';
  import Markup from './markup/Markup.svelte';
  import IpfImage from './images/IpfImage.svelte';
  import { TString, guiLinkAnswer, guiSelectionAnswer, type GuiDialogSpec, type GuiNode, type GuiCell, type GuiText, type InteractionResult } from '@wesnothweb2/engine';
  import { ts } from './i18n/locale.js';
  import { stripPango } from './markup/pango.js';

  let { dialog, onAnswer }: { dialog: GuiDialogSpec; onAnswer: (answer: InteractionResult) => void } = $props();

  /**
   * GUI2 sizes a window to its content. `Modal`'s box is an inline-size container (its dialogs re-flow to
   * their own width), so it cannot shrink to content by itself: the content is laid out in a wide box, its
   * root grid measured, and the box set to that width (never wider than the screen allows).
   */
  let content: HTMLDivElement | undefined = $state();
  let boxWidth = $state('min(95vw, 70rem)');
  $effect(() => {
    void dialog;
    const root = content?.firstElementChild;
    if (!root) return;
    // Images arrive after the first layout: follow the content as it grows.
    const observer = new ResizeObserver(() => {
      boxWidth = `min(95vw, ${Math.ceil(root.getBoundingClientRect().width) + 36}px)`;
    });
    observer.observe(root);
    return () => observer.disconnect();
  });

  function text(value: GuiText): string {
    return typeof value === 'string' ? value : ts(TString.fromJSON(value));
  }

  function cellStyle(cell: GuiCell): string {
    const pad = (side: 'top' | 'bottom' | 'left' | 'right') => (cell.border.includes(side) ? `${cell.borderSize}px` : '0');
    const justify = { left: 'start', center: 'center', right: 'end', stretch: 'stretch' }[cell.horizontalAlignment];
    const align = { top: 'start', center: 'center', bottom: 'end', stretch: 'stretch' }[cell.verticalAlignment];
    return `padding: ${pad('top')} ${pad('right')} ${pad('bottom')} ${pad('left')}; justify-self: ${justify}; align-self: ${align};`;
  }

  function visibility(node: GuiNode): string {
    return node.visibility === 'hidden' ? 'visibility: hidden;' : '';
  }
</script>

{#snippet widget(node: GuiNode)}
  {#if node.visibility !== 'invisible'}
    {#if node.type === 'grid'}
      <div class="grid" style="grid-template-columns: repeat({Math.max(1, ...node.rows.map((r) => r.length))}, auto); {visibility(node)}">
        {#each node.rows as row}
          {#each row as cell}
            <div class="cell" style={cellStyle(cell)}>{@render widget(cell.widget)}</div>
          {/each}
        {/each}
      </div>
    {:else if node.type === 'label'}
      <div class="label" class:title={node.title} style="text-align: {node.textAlignment}; {visibility(node)}" data-gui-id={node.id || undefined}>
        {#if node.markup}<Markup
            text={text(node.label)}
            help={node.rich}
            onLink={node.linkHandler ? (dst) => onAnswer(guiLinkAnswer(node.id, dst)) : undefined}
          />{:else}{text(node.label)}{/if}
      </div>
    {:else if node.type === 'image'}
      {#if node.label}<span style={visibility(node)}><IpfImage src={node.label} /></span>{/if}
    {:else if node.type === 'button'}
      <button
        class="button"
        style={visibility(node)}
        data-gui-id={node.id || undefined}
        disabled={!node.enabled}
        onclick={() => onAnswer({ value: node.returnValue, text: `click:${node.id}` })}
      >
        {#if node.markup}<Markup text={text(node.label)} />{:else}{text(node.label)}{/if}
      </button>
    {:else if node.type === 'menu_button'}
      <select
        class="menu-button"
        style={visibility(node)}
        data-gui-id={node.id || undefined}
        disabled={!node.enabled}
        value={node.selectedIndex}
        onchange={(e) => onAnswer(guiSelectionAnswer(node.id, Number((e.currentTarget as HTMLSelectElement).value)))}
      >
        {#each node.options as option, i}
          <!-- A <select> shows plain text: the option's markup is stripped. -->
          <option value={i + 1}>{stripPango(text(option))}</option>
        {/each}
      </select>
    {:else if node.type === 'spacer'}
      <div style="width: {node.width}px; height: {node.height}px;"></div>
    {:else if node.type === 'listbox'}
      <div class="listbox" class:horizontal={node.horizontal} role="listbox" style={visibility(node)} data-gui-id={node.id || undefined}>
        {#each node.rows as row, i}
          <button
            class="row"
            role="option"
            aria-selected={node.selectedIndex === i + 1}
            class:selected={node.selectedIndex === i + 1}
            onclick={() => onAnswer(guiSelectionAnswer(node.id, i + 1))}
          >
            {@render widget(row)}
          </button>
        {/each}
      </div>
    {:else if node.type === 'panel'}
      <div style={visibility(node)}>{@render widget(node.child)}</div>
    {:else}
      <div class="unknown">[{node.tag}]</div>
    {/if}
  {/if}
{/snippet}

<svelte:window
  onkeydown={(e) => {
    // `window::signal_handler_sdl_key_down`: Enter closes the window with OK. A button with focus handles its
    // own Enter; a listbox row and a menu button do not, as upstream's handle only the arrow keys. HttT
    // Classic's character choice has no button and its first row has the focus; TDG's spell dialog opens
    // with the focus on a menu button.
    if (e.key !== 'Enter' || e.defaultPrevented) return;
    const target = e.target as HTMLElement | null;
    if (target && target.getAttribute('role') !== 'option' && ['A', 'BUTTON', 'INPUT', 'TEXTAREA'].includes(target.tagName)) return;
    e.preventDefault();
    onAnswer({ value: -1 });
  }}
/>

<Modal onClose={() => onAnswer({ value: -2 })} width={boxWidth}>
  {#snippet children()}
    <div class="gui-dialog" data-testid="gui-dialog" bind:this={content}>{@render widget(dialog.root)}</div>
  {/snippet}
</Modal>

<style>
  .gui-dialog {
    max-height: 85vh;
    overflow: auto;
  }
  .grid {
    display: inline-grid;
  }
  /* GUI2 labels don't wrap unless their definition says so: the texts carry their own line breaks. */
  .label {
    white-space: pre;
  }
  .title {
    font-size: 1.35rem;
    font-weight: bold;
    color: var(--gold, #d4b35a);
  }
  .button {
    font: inherit;
    padding: 0.4rem 1.1rem;
    border-radius: 4px;
    border: 1px solid #2f5a7a;
    background: #1a3350;
    color: #d7e8f5;
    cursor: pointer;
  }
  .button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .menu-button {
    font: inherit;
    padding: 0.3rem 0.6rem;
    border-radius: 4px;
    border: 1px solid #2f5a7a;
    background: #1a3350;
    color: #d7e8f5;
  }
  .button:hover,
  .button:focus-visible {
    background: #2a5a86;
    border-color: #4a8ab8;
  }
  .listbox {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .listbox.horizontal {
    flex-direction: row;
    flex-wrap: wrap;
    justify-content: center;
  }
  .row {
    background: transparent;
    border: 2px solid transparent;
    padding: 0.25rem;
    cursor: pointer;
    color: inherit;
  }
  .row:hover,
  .row:focus-visible {
    border-color: rgba(212, 179, 90, 0.5);
  }
  .row.selected {
    border-color: var(--gold, #d4b35a);
  }
  .unknown {
    color: #c77;
    font-size: 0.8rem;
  }
</style>
