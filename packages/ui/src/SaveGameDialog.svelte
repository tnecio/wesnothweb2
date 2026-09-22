<script lang="ts">
  /**
   * "Save Game" -- names the slot, mirroring `gui/dialogs/game_save.cpp`:
   * a single text field pre-filled with the name upstream would have
   * chosen (`<label> Turn <n>`), and a confirmation when that name is
   * already taken, since a save is not recoverable once overwritten.
   *
   * Presentational only, like every other dialog here: it takes the
   * suggested name and the existing names, and hands a chosen name back.
   * `GameShell` owns the storage.
   */
  import Modal from './Modal.svelte';

  let {
    suggestedName,
    existingNames,
    onSave,
    onCancel,
  }: {
    suggestedName: string;
    existingNames: readonly string[];
    onSave: (name: string) => void;
    onCancel: () => void;
  } = $props();

  let name = $state(suggestedName);
  let confirmingOverwrite = $state(false);

  let trimmed = $derived(name.trim());
  let overwrites = $derived(existingNames.includes(trimmed));

  function submit(): void {
    if (trimmed === '') return;
    if (overwrites && !confirmingOverwrite) {
      confirmingOverwrite = true;
      return;
    }
    onSave(trimmed);
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  }
</script>

<Modal title="Save Game" onClose={onCancel} width="30rem">
  {#snippet children()}
    <label class="field">
      <span>Save as</span>
      <!-- svelte-ignore a11y_autofocus -- the one field in a dialog opened to type in it -->
      <input
        type="text"
        bind:value={name}
        data-autofocus
        autofocus
        onkeydown={handleKeydown}
        oninput={() => (confirmingOverwrite = false)}
      />
    </label>

    {#if confirmingOverwrite}
      <p class="warning">A save called "{trimmed}" already exists. Save again to overwrite it.</p>
    {:else if overwrites}
      <p class="hint">This will replace the existing save of the same name.</p>
    {/if}

    <div class="footer">
      <div class="spacer"></div>
      <button class="primary" disabled={trimmed === ''} onclick={submit}>
        {confirmingOverwrite ? 'Overwrite' : 'Save'}
      </button>
      <button onclick={onCancel}>Cancel</button>
    </div>
  {/snippet}
</Modal>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-bottom: 0.75rem;
  }
  .field span {
    font-size: 0.85rem;
    opacity: 0.85;
  }
  .field input {
    font: inherit;
    background: #0e1420;
    border: 1px solid #4a4432;
    color: #eee;
    border-radius: 3px;
    padding: 0.35rem 0.45rem;
  }
  .warning {
    margin: 0 0 0.75rem;
    color: #e8b45a;
    font-size: 0.9rem;
  }
  .hint {
    margin: 0 0 0.75rem;
    opacity: 0.7;
    font-size: 0.9rem;
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
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
