<script lang="ts">
  /**
   * Phase 28 S6: shown when something breaks at run time (see `errorReporting.svelte.ts`). The player can
   * carry on, go back to the menu, reload the latest autosave of the campaign they were playing, or copy /
   * download a report to send to the developers themselves. Reloading goes through a full page load, so no
   * broken state survives it.
   */
  import Modal from '../Modal.svelte';
  import { fmt, t, tx } from '../i18n/locale.js';
  import { listSaves, type SaveMeta } from '../persistence.js';
  import { buildReport, dismissError, errorState, gameContext } from './errorReporting.svelte.js';

  let includeSave = $state(false);
  let copied = $state(false);
  let autosave = $state<SaveMeta | null>(null);

  const error = $derived(errorState.current);
  const context = $derived(error && errorState.contextVersion >= 0 ? gameContext() : {});

  $effect(() => {
    const campaignId = error ? context.campaignId : undefined;
    autosave = null;
    if (!campaignId) return;
    void listSaves()
      .then((saves) => {
        autosave =
          saves
            // The start-of-scenario save counts: on turn 1 it is the only automatic one, as upstream.
            .filter((s) => s.campaignId === campaignId && (s.kind === 'autosave' || s.kind === 'scenario-start'))
            .sort((a, b) => b.savedAt - a.savedAt)[0] ?? null;
      })
      .catch(() => {});
  });

  function report(): string {
    return error ? buildReport(error, includeSave) : '';
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(report());
      copied = true;
    } catch {
      download();
    }
  }

  function download(): void {
    const url = URL.createObjectURL(new Blob([report()], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `wesnoth-error-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function loadAutosave(): void {
    if (!autosave?.campaignId) return;
    location.href = `/play/${autosave.campaignId}?save=${encodeURIComponent(autosave.name)}`;
  }
</script>

{#if error}
  <Modal title={tx('Something went wrong')} onClose={dismissError} width="34rem">
    {#snippet children()}
      <div class="error-screen" data-testid="error-screen">
        <p>{tx('The game hit an error it did not expect. You can try to carry on, but it may not behave correctly.')}</p>
        <pre class="message">{error.message}</pre>
        {#if context.scenarioId}
          <p class="where">
            {context.turn
              ? fmt(tx('Scenario: $scenario, turn $turn'), { scenario: context.scenarioName ?? context.scenarioId, turn: context.turn })
              : fmt(tx('Scenario: $scenario'), { scenario: context.scenarioName ?? context.scenarioId })}
          </p>
        {/if}
        <p class="hint">{tx('A report helps fix it. It stays on your device unless you send it yourself.')}</p>
        {#if context.saveData}
          <label class="include">
            <input type="checkbox" bind:checked={includeSave} />
            {tx('Include the current game in the report')}
          </label>
        {/if}
        <div class="footer">
          <button onclick={copy} data-testid="error-copy">{copied ? tx('Copied') : tx('Copy report')}</button>
          <button onclick={download}>{tx('Download report')}</button>
          <div class="spacer"></div>
        </div>
        <div class="footer">
          {#if autosave}
            <button onclick={loadAutosave} data-testid="error-load-autosave">{tx('Load latest autosave')}</button>
          {/if}
          <button onclick={() => (location.href = '/')}>{tx('Back to menu')}</button>
          <div class="spacer"></div>
          <!-- svelte-ignore a11y_autofocus -- continuing is the least disruptive answer -->
          <button class="primary" data-autofocus autofocus onclick={dismissError}>{t('Continue')}</button>
        </div>
      </div>
    {/snippet}
  </Modal>
{/if}

<style>
  p {
    margin: 0 0 0.7rem;
  }
  .message {
    margin: 0 0 0.7rem;
    padding: 0.5rem 0.7rem;
    max-height: 8rem;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    background: #0d1a28;
    border: 1px solid #2f5a7a;
    border-radius: 4px;
    font-size: 0.85rem;
  }
  .where,
  .hint {
    font-size: 0.9rem;
    opacity: 0.85;
  }
  .include {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    margin-bottom: 0.8rem;
    font-size: 0.9rem;
  }
  .footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
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
