<script lang="ts">
  /**
   * Phase 24: the preferences' Hotkeys tab (`preferences_dialog.cpp`'s hotkey page, `02_hotkeys.cfg`):
   * every command with its bindings, a filter on the description, columns that sort, and Add Hotkey,
   * Clear Hotkey and Defaults under the list. Add Hotkey waits for a key (`hotkey_bind`: "Press desired
   * hotkey (Esc cancels)"); a key another command has asks before it moves, as upstream's "Reassign
   * Hotkey" does. Upstream's scope columns (game, editor, main menu) and category menu are left out: the
   * port has only the game's hotkeys.
   */
  import Modal from './Modal.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { formatHotkey, type Hotkey } from './commands.js';
  import { HOTKEY_COMMANDS, addBinding, clearBindings, commandsBoundTo, hotkeyFromEvent, hotkeyPrefs, type HotkeyCommand } from './hotkeys.js';
  import { fmt, t } from './i18n/locale.js';

  let filter = $state('');
  let sortBy = $state<'action' | 'hotkey'>('action');
  let ascending = $state(true);
  let selectedId = $state<string | null>(null);
  let binding = $state(false);
  let reassign = $state<{ hotkey: Hotkey; from: HotkeyCommand } | null>(null);
  let notice = $state<{ title: string; text: string } | null>(null);

  function names(id: string): string {
    return hotkeyPrefs.bindings(id).map(formatHotkey).join(', ');
  }

  let rows = $derived.by(() => {
    const needle = filter.trim().toLowerCase();
    const list = HOTKEY_COMMANDS.filter((c) => !needle || c.label().toLowerCase().includes(needle)).map((c) => ({ command: c, label: c.label(), keys: names(c.id) }));
    const key = (r: (typeof list)[number]): string => (sortBy === 'action' ? r.label : r.keys);
    list.sort((a, b) => key(a).localeCompare(key(b)) * (ascending ? 1 : -1));
    return list;
  });

  let selected = $derived(rows.find((r) => r.command.id === selectedId)?.command ?? null);

  function sort(by: 'action' | 'hotkey'): void {
    if (sortBy === by) ascending = !ascending;
    else {
      sortBy = by;
      ascending = true;
    }
  }

  /** `hotkey_bind`: the first key that makes a binding closes it; Escape cancels. */
  function onBindKey(e: KeyboardEvent): void {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      binding = false;
      return;
    }
    const hotkey = hotkeyFromEvent(e);
    if (!hotkey || !selected) return;
    binding = false;
    const owner = commandsBoundTo(hotkey, hotkeyPrefs.overrides, selected.id)[0];
    if (owner) reassign = { hotkey, from: owner };
    else hotkeyPrefs.set(addBinding(selected.id, hotkey, hotkeyPrefs.overrides));
  }

  $effect(() => {
    if (!binding) return;
    window.addEventListener('keydown', onBindKey, true);
    return () => window.removeEventListener('keydown', onBindKey, true);
  });

  function add(): void {
    if (!selected) notice = { title: '', text: t('No hotkey selected') };
    else binding = true;
  }

  function clear(): void {
    if (!selected) notice = { title: '', text: t('No hotkey selected') };
    else hotkeyPrefs.set(clearBindings(selected.id, hotkeyPrefs.overrides));
  }

  function reset(): void {
    hotkeyPrefs.reset();
    notice = { title: t('Hotkeys Reset'), text: t('All hotkeys have been reset to their default values.') };
  }
</script>

<label class="filter">
  <span>{t('Filter:')}</span>
  <input type="search" bind:value={filter} title={t('Filters on hotkey description')} data-testid="hotkeys-filter" />
</label>

<div class="list" role="grid" aria-label={t('Hotkeys')} data-testid="hotkeys-list">
  <div class="row head" role="row">
    <button role="columnheader" aria-sort={sortBy === 'action' ? (ascending ? 'ascending' : 'descending') : 'none'} onclick={() => sort('action')}>{t('Action')}</button>
    <button role="columnheader" aria-sort={sortBy === 'hotkey' ? (ascending ? 'ascending' : 'descending') : 'none'} onclick={() => sort('hotkey')}>{t('Hotkey')}</button>
  </div>
  {#each rows as r (r.command.id)}
    <button
      class="row"
      role="row"
      class:selected={r.command.id === selectedId}
      aria-selected={r.command.id === selectedId}
      data-testid={`hotkey-row-${r.command.id}`}
      onclick={() => (selectedId = r.command.id)}
      ondblclick={() => {
        selectedId = r.command.id;
        add();
      }}
    >
      <span role="gridcell">{r.label}</span>
      <span role="gridcell" class="keys" data-testid={`hotkey-keys-${r.command.id}`}>{r.keys}</span>
    </button>
  {/each}
</div>

<div class="buttons">
  <button onclick={add} data-testid="hotkeys-add">{t('Add Hotkey')}</button>
  <button onclick={clear} data-testid="hotkeys-clear">{t('Clear Hotkey')}</button>
  <button onclick={reset} data-testid="hotkeys-reset">{t('Defaults')}</button>
</div>

{#if binding}
  <Modal width="22rem">
    {#snippet children()}
      <p class="bind" tabindex="-1" data-autofocus data-testid="hotkey-bind">{t('Press desired hotkey (Esc cancels)')}</p>
    {/snippet}
  </Modal>
{/if}

{#if reassign && selected}
  {@const r = reassign}
  {@const target = selected}
  <ConfirmDialog
    title={t('Reassign Hotkey')}
    message={fmt(t('“<b>$hotkey_sequence|</b>” is in use by “<b>$old_hotkey_action|</b>”.\nDo you wish to reassign it to “<b>$new_hotkey_action|</b>”?'), {
      hotkey_sequence: formatHotkey(r.hotkey),
      old_hotkey_action: r.from.label(),
      new_hotkey_action: target.label(),
    }).replace(/<\/?b>/g, '')}
    onYes={() => {
      hotkeyPrefs.set(addBinding(target.id, r.hotkey, hotkeyPrefs.overrides));
      reassign = null;
    }}
    onNo={() => (reassign = null)}
  />
{/if}

{#if notice}
  {@const n = notice}
  <Modal title={n.title || undefined} onClose={() => (notice = null)} width="24rem">
    {#snippet children()}
      <p class="notice">{n.text}</p>
      <div class="ok"><button data-autofocus onclick={() => (notice = null)}>{t('OK')}</button></div>
    {/snippet}
  </Modal>
{/if}

<style>
  .filter {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.6rem;
  }
  .filter input {
    flex: 1 1 auto;
    font: inherit;
    padding: 0.2rem 0.4rem;
    background: #0d1018;
    color: inherit;
    border: 1px solid #4a3d1e;
    border-radius: 3px;
  }
  .list {
    margin-top: 0.5rem;
    max-height: 16rem;
    overflow-y: auto;
    border: 1px solid #4a3d1e;
  }
  .row {
    display: grid;
    grid-template-columns: 1fr 10rem;
    gap: 0.5rem;
    width: 100%;
    padding: 0.2rem 0.5rem;
    font: inherit;
    text-align: left;
    background: transparent;
    color: inherit;
    border: 0;
    cursor: pointer;
  }
  .row.head {
    position: sticky;
    top: 0;
    padding: 0;
    background: #1a1712;
    cursor: default;
  }
  .row.head button {
    font: inherit;
    font-weight: 700;
    text-align: left;
    padding: 0.25rem 0.5rem;
    background: transparent;
    color: #e4c860;
    border: 0;
    cursor: pointer;
  }
  .row.selected {
    background: #2a3a55;
  }
  .keys {
    color: #b8c8d8;
  }
  .buttons,
  .ok {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.6rem;
  }
  .ok {
    justify-content: flex-end;
  }
  .buttons button,
  .ok button {
    font: inherit;
    padding: 0.3rem 0.9rem;
    border-radius: 4px;
    border: 1px solid #2f5a7a;
    background: #1a3350;
    color: #d7e8f5;
    cursor: pointer;
  }
  .bind {
    margin: 0.5rem 0;
    text-align: center;
    outline: none;
  }
  .notice {
    margin: 0;
    white-space: pre-line;
  }
</style>
