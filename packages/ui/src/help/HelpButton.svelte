<script lang="ts">
  /**
   * Upstream's `help` button (`button_25x25.cfg`): the question-mark icon at the bottom left of the unit
   * dialogs (`units_dialog`, `unit_advance`), which opens the help on the selected unit type.
   */
  import { ENGINE_IMAGES } from '../gameData.js';
  import { t } from '../i18n/locale.js';

  let { onclick, disabled = false }: { onclick: () => void; disabled?: boolean } = $props();
</script>

<button class="help-button" title={t('Help')} aria-label={t('Help')} {disabled} {onclick} data-testid="dialog-help">
  <img src={`${ENGINE_IMAGES}/icons/action/help_25.png`} alt="" draggable="false" />
</button>

<style>
  .help-button {
    all: unset;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 30px;
    min-height: 30px;
    cursor: pointer;
    border-radius: 50%;
  }
  .help-button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .help-button:focus-visible {
    outline: 2px solid #e4c860;
  }
  .help-button:hover:not(:disabled) img {
    filter: brightness(1.25);
  }
  @media (pointer: coarse) {
    .help-button {
      min-width: 44px;
      min-height: 44px;
    }
  }
</style>
