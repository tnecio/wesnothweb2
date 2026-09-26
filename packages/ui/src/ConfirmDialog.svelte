<script lang="ts">
  /** A yes/no question (`gui2::show_message` with `yes_no_buttons`). Presentational only. */
  import Modal from './Modal.svelte';
  import { t } from './i18n/locale.js';

  let {
    title,
    message,
    onYes,
    onNo,
  }: {
    title: string;
    message: string;
    onYes: () => void;
    onNo: () => void;
  } = $props();
</script>

<Modal {title} onClose={onNo} width="24rem">
  {#snippet children()}
    <p>{message}</p>
    <div class="footer">
      <div class="spacer"></div>
      <!-- svelte-ignore a11y_autofocus -- the default answer, as upstream's dialog focuses it -->
      <button class="primary" data-autofocus autofocus onclick={onYes}>{t('Yes')}</button>
      <button onclick={onNo}>{t('No')}</button>
    </div>
  {/snippet}
</Modal>

<style>
  p {
    margin: 0 0 0.9rem;
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
