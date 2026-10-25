<script lang="ts">
  /**
   * Phase 30: "Report a bug". The player says what happened (and, if they like, what they expected and how to
   * reach them), chooses whether to attach the current game and the recent warnings and errors, and sends it to
   * the developer (`bugReport.ts`). On success they get a reference; when it cannot be sent (offline, no
   * report server in this build) they can copy or download the same report instead.
   */
  import Modal from '../Modal.svelte';
  import { fmt, t, tx } from '../i18n/locale.js';
  import { gameContext, recentLog } from '../errors/errorReporting.svelte.js';
  import { buildBugReport, bugReportText, sendBugReport, type BugReportInput } from './bugReport.js';
  import { bugReportDialog, closeBugReport } from './bugReportDialog.svelte.js';
  import { environmentInfo, statsUrl } from './stats.js';

  const url = statsUrl();
  const context = gameContext();
  const inGame = !!context.saveData;

  let description = $state('');
  let expected = $state('');
  let contact = $state('');
  let includeSave = $state(inGame);
  let includeLog = $state(true);
  let status = $state<'editing' | 'sending' | 'sent' | 'failed'>(url ? 'editing' : 'failed');
  let reference = $state('');
  let failure = $state('');
  let copied = $state(false);

  function report() {
    const input: BugReportInput = { description, expected, contact, includeSave, includeLog };
    return buildBugReport(input, {
      environment: environmentInfo(),
      userAgent: navigator.userAgent,
      page: location.href,
      context,
      log: recentLog,
      crash: bugReportDialog.crash,
    });
  }

  async function send(): Promise<void> {
    if (!url || description.trim() === '') return;
    status = 'sending';
    try {
      reference = await sendBugReport(url, report());
      status = 'sent';
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      status = 'failed';
    }
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(bugReportText(report()));
      copied = true;
    } catch {
      download();
    }
  }

  function download(): void {
    const href = URL.createObjectURL(new Blob([bugReportText(report())], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = href;
    a.download = `wesnoth-bug-report-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
</script>

<Modal title={tx('Report a Bug')} onClose={closeBugReport} width="36rem">
  {#snippet children()}
    <div class="bug-report" data-testid="bug-report">
      {#if status === 'sent'}
        <p data-testid="bug-report-sent">{tx('Thank you! Your report was sent.')}</p>
        <p>{fmt(tx('Its reference is $id.'), { id: reference })}</p>
        <div class="footer">
          <div class="spacer"></div>
          <button class="primary" data-autofocus onclick={closeBugReport}>{t('Close')}</button>
        </div>
      {:else}
        {#if context.scenarioId}
          <p class="where">
            {context.turn
              ? fmt(tx('Scenario: $scenario, turn $turn'), { scenario: context.scenarioName ?? context.scenarioId, turn: context.turn })
              : fmt(tx('Scenario: $scenario'), { scenario: context.scenarioName ?? context.scenarioId })}
          </p>
        {/if}
        <label class="field">
          <span>{tx('What happened?')}</span>
          <!-- svelte-ignore a11y_autofocus -- the dialog exists to be typed into -->
          <textarea rows="4" bind:value={description} data-autofocus autofocus data-testid="bug-report-description"></textarea>
        </label>
        <label class="field">
          <span>{tx('What did you expect to happen? (optional)')}</span>
          <textarea rows="2" bind:value={expected}></textarea>
        </label>
        <label class="field">
          <span>{tx('How can we reach you about it? (optional: an email or forum name, stored with the report)')}</span>
          <input type="text" bind:value={contact} autocomplete="off" />
        </label>
        {#if inGame}
          <label class="include">
            <input type="checkbox" bind:checked={includeSave} data-testid="bug-report-include-save" />
            {tx('Attach the current game, so the developer can open it where you are')}
          </label>
        {/if}
        <label class="include">
          <input type="checkbox" bind:checked={includeLog} />
          {tx('Attach the recent warnings and errors the game logged')}
        </label>
        <p class="hint">
          {tx('The report also says which version of the game and which browser you use. It goes to the developer of this web port and is deleted after a year.')}
        </p>
        {#if status === 'failed'}
          <p class="failed" data-testid="bug-report-failed">
            {url ? fmt(tx('The report could not be sent ($reason). You can copy or download it and send it yourself.'), { reason: failure }) : tx('This version of the game cannot send reports. You can copy or download one and send it yourself.')}
          </p>
        {/if}
        <div class="footer">
          {#if status === 'failed'}
            <button onclick={copy} data-testid="bug-report-copy">{copied ? tx('Copied') : tx('Copy report')}</button>
            <button onclick={download}>{tx('Download report')}</button>
          {/if}
          <div class="spacer"></div>
          <button onclick={closeBugReport}>{t('Cancel')}</button>
          {#if url}
            <button class="primary" disabled={description.trim() === '' || status === 'sending'} onclick={send} data-testid="bug-report-send">
              {status === 'sending' ? tx('Sending...') : tx('Send')}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/snippet}
</Modal>

<style>
  p {
    margin: 0 0 0.7rem;
  }
  .where,
  .hint {
    font-size: 0.9rem;
    opacity: 0.85;
  }
  .failed {
    font-size: 0.9rem;
    color: #f0b090;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-bottom: 0.7rem;
    font-size: 0.9rem;
  }
  textarea,
  input[type='text'] {
    font: inherit;
    padding: 0.4rem 0.5rem;
    border-radius: 4px;
    border: 1px solid #2f5a7a;
    background: #0d1a28;
    color: #e6e1cf;
    resize: vertical;
  }
  .include {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    margin-bottom: 0.6rem;
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
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button.primary {
    background: #2a5a86;
    border-color: #4a8ab8;
  }
</style>
