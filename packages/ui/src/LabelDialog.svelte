<script lang="ts">
  /**
   * Phase 18: "Place Label" -- `gui/dialogs/edit_label.cpp`: the label's
   * text (the hex's current label, if any) and a "Team only" checkbox. An
   * empty text removes the label. Presentational only; `GameShell` places it.
   */
  import Modal from './Modal.svelte';

  let {
    initialText,
    initialTeamOnly,
    onPlace,
    onCancel,
  }: {
    initialText: string;
    initialTeamOnly: boolean;
    onPlace: (text: string, teamOnly: boolean) => void;
    onCancel: () => void;
  } = $props();

  let text = $state(initialText);
  let teamOnly = $state(initialTeamOnly);

  function submit(): void {
    onPlace(text.trim(), teamOnly);
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  }
</script>

<Modal title="Place Label" onClose={onCancel} width="26rem">
  {#snippet children()}
    <label class="field">
      <span>Label</span>
      <!-- svelte-ignore a11y_autofocus -- the one field in a dialog opened to type in it -->
      <input type="text" bind:value={text} data-autofocus autofocus maxlength="200" onkeydown={handleKeydown} />
    </label>
    <label class="check">
      <input type="checkbox" bind:checked={teamOnly} />
      <span>Team only</span>
    </label>

    <div class="footer">
      <div class="spacer"></div>
      <button class="primary" onclick={submit}>OK</button>
      <button onclick={onCancel}>Cancel</button>
    </div>
  {/snippet}
</Modal>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-bottom: 0.6rem;
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
  .check {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.75rem;
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
