<script lang="ts">
  /**
   * The credits (`gui2::dialogs::end_credits`): every credit group scrolling up over a title-screen picture at
   * upstream's 100 px/s, Up doubling the speed (to 400) and Down halving it (to 50), Escape closing.
   *
   * Three additions for the web: the scrolling can be paused (moving text that lasts more than a few
   * seconds needs an off switch); the viewport is a native scroll container and the auto-scroll drives its
   * `scrollTop` directly (padding above and below `.text` stands in for upstream's off-screen start and
   * its "last line stops half way up"), so a wheel, a touch drag or the scrollbar move the same position
   * the animation does -- including back up to the very top, which a transform-based scroll (visually
   * offset, but not truly scrolled) could not give back once it had moved on. Upstream has nothing like
   * this to lean on, but browsers are good at it, so there is no reason not to use it here. And with
   * `prefers-reduced-motion` the text does not move at all, it is an ordinary scrollable list. The data
   * (`credits.json`, ~30 KB) is fetched when the screen opens, not with the menu.
   */
  import { dataUrl } from '../dataUrls.js';
  import { LICENSE_FILES, SOURCE_URL } from '../about.js';
  import { imageUrl } from '@wesnothweb2/renderer';
  import Modal from '../Modal.svelte';
  import { languageTag, locale, t, ts, tx } from '../i18n/locale.js';
  import { changeScrollSpeed, creditsBackground, creditsLines, DEFAULT_SCROLL_SPEED, type CreditsJson, type CreditsLine } from './credits.js';

  /**
   * The port's own credit, ahead of every upstream group. Not in `credits.json` -- that file is
   * regenerated from upstream data alone (`build-campaigns.mjs`) and would drop a hand-added line on its
   * next rebuild.
   */
  const PORT_CREDIT: CreditsLine = { kind: 'header', text: 'Wesnoth on the Web port: Tomasz Necio (tnec.io)' };

  let { onClose, focusOn = undefined }: { onClose: () => void; focusOn?: string } = $props();

  let data = $state<CreditsJson | null>(null);
  let failed = $state(false);
  let background = $state<string | undefined>();
  let speed = $state(DEFAULT_SCROLL_SPEED);
  let paused = $state(false);
  let viewport = $state<HTMLDivElement | undefined>();
  let content = $state<HTMLDivElement | undefined>();

  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  $effect(() => {
    let cancelled = false;
    fetch(dataUrl('credits.json'))
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<CreditsJson>;
      })
      .then((json) => {
        if (cancelled) return;
        data = json;
        background = creditsBackground(json, (max) => Math.floor(Math.random() * (max + 1)), focusOn);
      })
      .catch((err) => {
        console.error('[credits] could not load credits.json:', err);
        if (!cancelled) failed = true;
      });
    return () => {
      cancelled = true;
    };
  });

  const lines = $derived(
    data ? [PORT_CREDIT, ...creditsLines(data, (s) => ts(s), (a, b) => a.localeCompare(b, languageTag(locale.current)), focusOn)] : [],
  );

  // The scroll: text enters at the bottom and moves up until the last line is half way up, then stays.
  // Padding above and below `.text` stands in for that (so `scrollTop` 0 is "nothing yet" and its max is
  // "the last line half way up"), and each frame nudges the *current* `scrollTop` forward -- not a value
  // computed independently of it -- so a manual scroll (anywhere, including back to the very top) just
  // becomes the new starting point instead of being overwritten next frame.
  $effect(() => {
    if (reduceMotion || !viewport || !content || lines.length === 0) return;
    const vh = viewport.clientHeight;
    content.style.paddingTop = `${vh}px`;
    content.style.paddingBottom = `${vh / 2}px`;
    viewport.scrollTop = 0;
    let frame = 0;
    let last = performance.now();
    const step = (now: number): void => {
      const dt = Math.min(now - last, 100);
      last = now;
      if (!paused && viewport) {
        const max = viewport.scrollHeight - viewport.clientHeight;
        viewport.scrollTop = Math.min(max, viewport.scrollTop + (speed * dt) / 1000);
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      if (content) {
        content.style.paddingTop = '';
        content.style.paddingBottom = '';
      }
    };
  });

  function onKey(e: KeyboardEvent): void {
    if (reduceMotion) return;
    if (e.key === 'ArrowUp') speed = changeScrollSpeed(speed, 'up');
    else if (e.key === 'ArrowDown') speed = changeScrollSpeed(speed, 'down');
    else return;
    e.preventDefault();
  }
</script>

<Modal title={t('Credits')} {onClose} width="48rem">
  {#snippet children()}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -- Up/Down change the scroll speed, as upstream's dialog does -->
    <div class="frame" onkeydown={onKey} data-testid="credits">
      <div
        class="viewport"
        class:static={reduceMotion}
        bind:this={viewport}
        tabindex={0}
        style:background-image={background ? `url(${imageUrl(background.replace(/^data\//, ''))})` : undefined}
      >
        <div class="shade">
          {#if failed}
            <p class="note">{tx('The credits could not be loaded.')}</p>
          {:else if data === null}
            <p class="note">{tx('Loading...')}</p>
          {:else}
            <div class="text" bind:this={content} data-testid="credits-text">
              {#each lines as line}
                {#if line.kind === 'gap'}
                  <div class="gap" aria-hidden="true"></div>
                {:else}
                  <div class={line.kind} dir="auto">{line.text}</div>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      </div>
    </div>
    <div class="footer">
      {#if !reduceMotion}
        <button onclick={() => (paused = !paused)} aria-pressed={paused} data-testid="credits-pause">{paused ? tx('Resume scrolling') : tx('Pause scrolling')}</button>
      {/if}
      <span class="spacer"></span>
      <!-- Phase 28 S9: the licences the game ships under, and where its source is. -->
      <nav class="legal" aria-label={tx('Licences and source code')} data-testid="credits-legal">
        <a href={dataUrl(LICENSE_FILES.readme)} target="_blank" rel="noopener">{tx('Licences')}</a>
        <a href={dataUrl(LICENSE_FILES.wesnothCopyrights)} target="_blank" rel="noopener">{tx('Art and music credits (CSV)')}</a>
        <a href={SOURCE_URL} target="_blank" rel="noopener">{tx('Source code')}</a>
      </nav>
      <button class="primary" data-autofocus onclick={onClose} data-testid="credits-close">{t('Close')}</button>
    </div>
  {/snippet}
</Modal>

<style>
  .frame {
    display: flex;
    flex-direction: column;
  }
  .viewport {
    position: relative;
    height: min(30rem, 60vh);
    overflow-y: auto;
    overflow-x: hidden;
    border: 1px solid #4a3d1e;
    border-radius: 4px;
    background: #05070c center / cover no-repeat;
  }
  .shade {
    min-height: 100%;
    background: rgba(0, 0, 0, 0.62);
  }
  .text {
    text-align: center;
    padding: 0 1rem;
  }
  .static .text {
    padding: 1rem;
  }
  .gap {
    height: 1.4rem;
  }
  .header {
    font-size: 1.9rem;
    font-weight: 700;
    color: #f1e6c8;
  }
  .title {
    font-size: 1.4rem;
    color: #e4c860;
  }
  .name {
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .note {
    padding: 1rem;
    text-align: center;
  }
  .footer {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.7rem;
  }
  .spacer {
    flex: 1 1 auto;
  }
  button {
    font: inherit;
    padding: 0.4rem 1.1rem;
    border-radius: 4px;
    border: 1px solid #4a3d1e;
    background: #1a1712;
    color: inherit;
    cursor: pointer;
  }
  .legal {
    display: flex;
    flex-wrap: wrap;
    gap: 0.8rem;
    font-size: 0.85rem;
  }
  .legal a {
    color: #d8c38a;
  }
  button.primary {
    background: #6a4a1e;
    border-color: #8a6a2e;
    color: #f1e6c8;
  }
</style>
