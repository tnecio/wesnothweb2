<script lang="ts">
  /**
   * Phase 28c: a campaign's own dialog (`gui.show_dialog`), drawn from its `[resolution]` WML as the engine
   * modelled it (`guiDialog.ts`): grids of rows and columns with their borders and alignment, labels (Pango
   * markup when `use_markup=yes`, larger for `definition=title`), images, buttons, spacers, and listboxes whose
   * rows the player picks. A button answers with its return value; picking a listbox row answers
   * `select:<id>:<row>` and the dialog stays open unless the campaign's callback closes it; Escape cancels.
   */
  import Modal from './Modal.svelte';
  import Markup from './markup/Markup.svelte';
  import IpfImage from './images/IpfImage.svelte';
  import { TString, guiSelectionAnswer, type GuiDialogSpec, type GuiNode, type GuiCell, type GuiText, type InteractionResult } from '@wesnothweb2/engine';
  import { ts } from './i18n/locale.js';

  let { dialog, onAnswer }: { dialog: GuiDialogSpec; onAnswer: (answer: InteractionResult) => void } = $props();

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
        {#if node.markup}<Markup text={text(node.label)} />{:else}{text(node.label)}{/if}
      </div>
    {:else if node.type === 'image'}
      {#if node.label}<span style={visibility(node)}><IpfImage src={node.label} /></span>{/if}
    {:else if node.type === 'button'}
      <button style={visibility(node)} data-gui-id={node.id || undefined} onclick={() => onAnswer({ value: node.returnValue })}>
        {#if node.markup}<Markup text={text(node.label)} />{:else}{text(node.label)}{/if}
      </button>
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

<Modal onClose={() => onAnswer({ value: -2 })} width="auto">
  {#snippet children()}
    <div class="gui-dialog" data-testid="gui-dialog">{@render widget(dialog.root)}</div>
  {/snippet}
</Modal>

<style>
  .gui-dialog {
    max-width: min(92vw, 70rem);
    max-height: 85vh;
    overflow: auto;
  }
  .grid {
    display: grid;
  }
  .cell {
    min-width: 0;
  }
  .label {
    white-space: pre-wrap;
  }
  .title {
    font-size: 1.35rem;
    font-weight: bold;
    color: var(--gold, #d4b35a);
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
