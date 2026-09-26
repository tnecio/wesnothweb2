<script lang="ts">
  /**
   * Phase 18: "Label Settings" -- `gui/dialogs/label_settings.cpp`: which
   * kinds of map label to show, one checkbox per category (a side's labels
   * in that side's colour). OK applies, Cancel leaves them as they were.
   */
  import Modal from './Modal.svelte';
  import { t, tx } from './i18n/locale.js';

  let {
    categories,
    sideColors,
    onApply,
    onCancel,
  }: {
    categories: readonly { id: string; name: string; visible: boolean; side?: number }[];
    /** CSS colour per side, for the side rows. */
    sideColors: ReadonlyMap<number, string>;
    onApply: (hidden: string[]) => void;
    onCancel: () => void;
  } = $props();

  let visible = $state<Record<string, boolean>>(Object.fromEntries(categories.map((c) => [c.id, c.visible])));

  function apply(): void {
    onApply(categories.filter((c) => !visible[c.id]).map((c) => c.id));
  }
</script>

<Modal title={tx('Label Settings')} onClose={onCancel} width="24rem">
  {#snippet children()}
    <ul>
      {#each categories as cat (cat.id)}
        <li>
          <label>
            <input type="checkbox" bind:checked={visible[cat.id]} />
            <span style:color={cat.side !== undefined ? sideColors.get(cat.side) : undefined}>{cat.name}</span>
          </label>
        </li>
      {/each}
    </ul>
    <div class="footer">
      <div class="spacer"></div>
      <!-- svelte-ignore a11y_autofocus -- confirming is the usual answer -->
      <button class="primary" data-autofocus autofocus onclick={apply}>{t('OK')}</button>
      <button onclick={onCancel}>{t('Cancel')}</button>
    </div>
  {/snippet}
</Modal>

<style>
  ul {
    list-style: none;
    margin: 0 0 0.9rem;
    padding: 0;
  }
  li label {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.2rem 0;
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .spacer {
    flex: 1 1 auto;
  }
  button {
    font: inherit;
    padding: 0.4rem 1.1rem;
    border-radius: 4px;
    border: 1px solid #2f5a7a;
    background: #1a3350;
    color: #d7e8f5;
    cursor: pointer;
  }
  button.primary {
    background: #2a5a86;
    border-color: #4a8ab8;
  }
</style>
