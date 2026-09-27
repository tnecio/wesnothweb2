<script lang="ts">
  import { t } from './i18n/locale.js';
  /**
   * Phase 16 N7: the campaign outro (`gui2::dialogs::outro`,
   * `data/gui/themes/default/dialogs/outro.cfg`): black screen, centred
   * script text, each screen fading in over 500 ms, held for
   * `end_text_duration`, fading out, then the next. Escape (or a click)
   * skips it, as upstream's "Press ESC to skip".
   *
   * Fades are CSS opacity transitions driven by a few timers -- no
   * per-frame work while a screen is held.
   */
  import { onDestroy } from 'svelte';
  import { OUTRO_FADE_MS, type OutroScreen } from './story/outro.js';

  let {
    screens,
    holdMs,
    onDone,
  }: {
    screens: readonly OutroScreen[];
    holdMs: number;
    onDone: () => void;
  } = $props();

  let screenIndex = $state(0);
  const current = $derived(screens[screenIndex]);
  let visible = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;

  function later(ms: number, then: () => void): void {
    timer = setTimeout(then, ms);
  }

  function showScreen(): void {
    // Next frame, so the opacity transition starts from 0.
    requestAnimationFrame(() => {
      visible = true;
      later(OUTRO_FADE_MS + holdMs, () => {
        visible = false;
        later(OUTRO_FADE_MS, () => {
          if (screenIndex + 1 < screens.length) {
            screenIndex += 1;
            showScreen();
          } else {
            finish();
          }
        });
      });
    });
  }

  function finish(): void {
    if (finished) return;
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
    onDone();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      finish();
    }
  }

  // Screens are fixed for the outro's lifetime.
  // svelte-ignore state_referenced_locally
  if (screens.length > 0) showScreen();
  else queueMicrotask(finish);

  onDestroy(() => {
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
  });
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -- Escape is handled window-wide -->
<div class="outro" role="dialog" aria-label={t('The End')} tabindex="-1" onclick={finish}>
  {#if current}
    <div class="text" style:opacity={visible ? 1 : 0} style:transition-duration="{OUTRO_FADE_MS}ms">
      {#each current.lines as line, i (i)}
        <div class="line {line.size}">{line.text}</div>
        {#if i === 0 && current.lines.length > 1 && line.size === 'normal'}
          <div class="gap"></div>
        {/if}
      {/each}
    </div>
  {/if}
  <div class="skip">{t('Press ESC to skip')}</div>
</div>

<style>
  .outro {
    direction: ltr; /* Wesnoth does not mirror its GUI for right-to-left languages; text runs pick their own direction (dir="auto") */
    position: fixed;
    inset: 0;
    z-index: 300;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 10px;
    background: #000;
    color: rgb(215, 215, 215);
    cursor: default;
  }
  .text {
    font-family: var(--font-script);
    font-size: calc(60px * var(--font-scale, 1));
    line-height: 1.15;
    text-align: center;
    transition-property: opacity;
    transition-timing-function: linear;
  }
  .line.large {
    font-size: calc(72px * var(--font-scale, 1));
  }
  .line.small {
    font-size: calc(35px * var(--font-scale, 1));
  }
  .gap {
    height: 0.6em;
  }
  .skip {
    position: absolute;
    right: 20px;
    bottom: 20px;
    font-family: var(--font-ui);
    font-size: calc(17px * var(--font-scale, 1));
  }
  @media (max-width: 600px) {
    .text {
      font-size: calc(40px * var(--font-scale, 1));
    }
    .line.large {
      font-size: calc(46px * var(--font-scale, 1));
    }
    .line.small {
      font-size: calc(24px * var(--font-scale, 1));
    }
  }
</style>
