<script lang="ts">
  /**
   * Language picker (Phase 20). Lists the shipped languages by their own
   * names and switches the running game at once -- nothing reloads, and text
   * already on screen (an open dialogue included) is retranslated. The full
   * preferences dialog that will host this comes with Phase 24.
   */
  import Modal from './Modal.svelte';
  import { languageTag, locale, t } from './i18n/locale.js';

  let { onClose }: { onClose: () => void } = $props();

  let busy = $state(false);

  async function choose(code: string): Promise<void> {
    if (busy || code === locale.current) return;
    busy = true;
    try {
      await locale.setLanguage(code);
    } finally {
      busy = false;
    }
  }
</script>

<Modal title={t('Language')} {onClose} width="24rem">
  {#snippet children()}
    <div class="list" role="radiogroup" aria-label={t('Language')} data-testid="language-list">
      {#each locale.languages as lang (lang.code)}
        <label class="row" class:selected={lang.code === locale.current} lang={languageTag(lang.code)} dir={lang.rtl ? 'rtl' : 'ltr'}>
          <input
            type="radio"
            name="language"
            value={lang.code}
            checked={lang.code === locale.current}
            disabled={busy}
            data-autofocus={lang.code === locale.current ? '' : undefined}
            data-testid={`language-${lang.code}`}
            onchange={() => void choose(lang.code)}
          />
          <span class="name">{lang.name}</span>
        </label>
      {/each}
    </div>
    <div class="footer">
      <div class="spacer"></div>
      <button class="primary" onclick={onClose}>{t('Close')}</button>
    </div>
  {/snippet}
</Modal>

<style>
  .list {
    display: grid;
    gap: 0.15rem;
    margin: 0.4rem 0;
    max-height: 60vh;
    overflow-y: auto;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.35rem 0.6rem;
    border-radius: 4px;
    cursor: pointer;
  }
  .row:hover {
    background: #1a3350;
  }
  .row.selected {
    background: #22456a;
  }
  .name {
    flex: 1 1 auto;
  }
  .footer {
    display: flex;
    margin-top: 0.9rem;
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
