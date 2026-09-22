<script lang="ts">
  /**
   * "Load Game" -- the save manager, mirroring `gui/dialogs/game_load.cpp`:
   * every save with its campaign, scenario, turn, kind and date, filtered
   * by campaign, with rename, delete (confirmed), and the two file
   * operations this port needs that a desktop game does not -- download a
   * save as a real Wesnoth `.gz`, and upload one back.
   *
   * Presentational: it is handed the list and calls back. `GameShell`
   * owns storage and the Wesnoth-format conversion.
   */
  import Modal from './Modal.svelte';
  import type { SaveMeta } from './persistence.js';

  let {
    saves,
    campaignNames,
    busy = false,
    onLoad,
    onDelete,
    onRename,
    onDownload,
    onUpload,
    onCancel,
  }: {
    saves: readonly SaveMeta[];
    /** Campaign id -> display name, for the filter and the list's campaign column. */
    campaignNames: Record<string, string>;
    /** A file operation is in flight; the list stays visible but actions are inert. */
    busy?: boolean;
    onLoad: (name: string) => void;
    onDelete: (name: string) => void;
    onRename: (from: string, to: string) => void;
    onDownload: (name: string) => void;
    onUpload: (file: File) => void;
    onCancel: () => void;
  } = $props();

  let selectedName = $state<string | null>(saves[0]?.name ?? null);
  let campaignFilter = $state('');
  let confirmingDelete = $state<string | null>(null);
  let renaming = $state(false);
  let renameTo = $state('');
  let fileInput = $state<HTMLInputElement | undefined>();

  let filtered = $derived(
    campaignFilter === '' ? saves : saves.filter((s) => (s.campaignId ?? '') === campaignFilter),
  );
  let selected = $derived(filtered.find((s) => s.name === selectedName) ?? null);
  /** Campaign ids actually present in the list, so the filter never offers an empty option. */
  let campaignsPresent = $derived([...new Set(saves.map((s) => s.campaignId).filter((id): id is string => !!id))]);

  function campaignLabel(id: string | undefined): string {
    if (!id) return '--';
    return campaignNames[id] ?? id;
  }

  function kindLabel(kind: SaveMeta['kind']): string {
    if (kind === 'autosave') return 'Auto';
    if (kind === 'scenario-start') return 'Start';
    return '';
  }

  function when(savedAt: number): string {
    const d = new Date(savedAt);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  function select(name: string): void {
    selectedName = name;
    confirmingDelete = null;
    renaming = false;
  }

  function handleDelete(): void {
    if (!selected) return;
    if (confirmingDelete !== selected.name) {
      confirmingDelete = selected.name;
      return;
    }
    confirmingDelete = null;
    onDelete(selected.name);
  }

  function startRename(): void {
    if (!selected) return;
    renameTo = selected.name;
    renaming = true;
  }

  function commitRename(): void {
    if (!selected || renameTo.trim() === '' || renameTo.trim() === selected.name) {
      renaming = false;
      return;
    }
    const from = selected.name;
    renaming = false;
    onRename(from, renameTo.trim());
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (renaming || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (filtered.length === 0) return;
      const current = filtered.findIndex((s) => s.name === selectedName);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      select(filtered[(Math.max(0, current) + step + filtered.length) % filtered.length]!.name);
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<Modal labelledBy="Load Game" onClose={onCancel} width="52rem">
  {#snippet children()}
    <div class="header">
      <span class="title">Load Game</span>
      <div class="spacer"></div>
      {#if campaignsPresent.length > 1}
        <label class="filter">
          Campaign
          <select bind:value={campaignFilter}>
            <option value="">All</option>
            {#each campaignsPresent as id (id)}
              <option value={id}>{campaignLabel(id)}</option>
            {/each}
          </select>
        </label>
      {/if}
    </div>

    {#if saves.length === 0}
      <p class="empty">No saved games yet. Use Save Game, or upload a Wesnoth save file.</p>
    {:else if filtered.length === 0}
      <p class="empty">No saves for this campaign.</p>
    {:else}
      <div class="list">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Campaign</th>
              <th>Scenario</th>
              <th>Turn</th>
              <th>Saved</th>
            </tr>
          </thead>
          <tbody>
            {#each filtered as save (save.name)}
              <tr
                class:selected={save.name === selectedName}
                onclick={() => select(save.name)}
                ondblclick={() => onLoad(save.name)}
              >
                <td>
                  <button type="button" class="row-button" data-list-option onclick={() => select(save.name)}>
                    {save.name}
                  </button>
                  {#if kindLabel(save.kind)}<span class="kind">{kindLabel(save.kind)}</span>{/if}
                </td>
                <td>{campaignLabel(save.campaignId)}</td>
                <td>{save.scenarioName ?? save.scenarioId}</td>
                <td>{save.turnNumber ?? '--'}</td>
                <td class="when">{when(save.savedAt)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    {#if renaming}
      <div class="rename-row">
        <input
          type="text"
          bind:value={renameTo}
          onkeydown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') renaming = false;
          }}
        />
        <button class="small" onclick={commitRename}>OK</button>
        <button class="small" onclick={() => (renaming = false)}>Cancel</button>
      </div>
    {/if}

    {#if confirmingDelete}
      <p class="warning">Delete "{confirmingDelete}"? Press Delete again to confirm.</p>
    {/if}

    <div class="footer">
      <button onclick={startRename} disabled={!selected || busy}>Rename</button>
      <button onclick={handleDelete} disabled={!selected || busy}>Delete</button>
      <button onclick={() => selected && onDownload(selected.name)} disabled={!selected || busy}>Download</button>
      <button onclick={() => fileInput?.click()} disabled={busy}>Upload...</button>
      <input
        class="file-input"
        type="file"
        accept=".gz,application/gzip,application/json"
        bind:this={fileInput}
        onchange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (file) onUpload(file);
        }}
      />
      <div class="spacer"></div>
      <button class="primary" data-autofocus disabled={!selected || busy} onclick={() => selected && onLoad(selected.name)}>
        Load
      </button>
      <button onclick={onCancel}>Cancel</button>
    </div>
  {/snippet}
</Modal>

<style>
  .header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .title {
    font-size: 1.15rem;
    font-weight: 700;
    color: #e4c860;
  }
  .filter {
    font-size: 0.85rem;
    opacity: 0.85;
  }
  .filter select {
    font: inherit;
    background: #0e1420;
    border: 1px solid #4a4432;
    color: #eee;
    border-radius: 3px;
    padding: 0.15rem 0.3rem;
    margin-left: 0.3rem;
  }
  .empty {
    opacity: 0.75;
    padding: 1.5rem 0;
    text-align: center;
  }
  .list {
    max-height: 22rem;
    overflow-y: auto;
    border: 1px solid #4a4432;
    border-radius: 3px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
  }
  th {
    position: sticky;
    top: 0;
    background: #141a26;
    text-align: left;
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid #4a4432;
    font-size: 0.8rem;
    opacity: 0.8;
  }
  td {
    padding: 0.25rem 0.5rem;
    border-bottom: 1px solid #23283a;
  }
  tr {
    background: #1a2233;
    cursor: pointer;
  }
  tr.selected {
    background: #35411f;
    outline: 1px solid #ffd54a;
  }
  .row-button {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: #f1e6c8;
    cursor: pointer;
    text-align: left;
  }
  .kind {
    margin-left: 0.4rem;
    font-size: 0.75rem;
    padding: 0 0.3rem;
    border-radius: 3px;
    background: #2a3550;
    opacity: 0.9;
  }
  .when {
    white-space: nowrap;
    opacity: 0.85;
  }
  .rename-row {
    display: flex;
    gap: 0.3rem;
    margin-top: 0.5rem;
  }
  .rename-row input {
    flex: 1 1 auto;
    font: inherit;
    background: #0e1420;
    border: 1px solid #4a4432;
    color: #eee;
    border-radius: 3px;
    padding: 0.15rem 0.3rem;
  }
  .warning {
    margin: 0.5rem 0 0;
    color: #e8b45a;
    font-size: 0.9rem;
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .file-input {
    display: none;
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
  button.small {
    padding: 0.15rem 0.5rem;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
