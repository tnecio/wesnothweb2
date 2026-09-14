<script lang="ts">
  /**
   * Phase 16 N4: the story screen shown before a scenario starts -- a port
   * of `gui2::dialogs::story_viewer` (`src/gui/dialogs/story_viewer.cpp`)
   * and its theme (`data/gui/themes/default/dialogs/story_viewer.cfg`,
   * `widgets/panel_story_viewer.cfg`).
   *
   * - Background layers and floating images are positioned by the pure
   *   functions in `story/storyLayout.ts`, from pixel sizes in the story
   *   asset table, so nothing reflows when pixels arrive.
   * - Floating images appear one after another, each `delay` ms after the
   *   previous; changing part cancels the chain.
   * - Text and title fade in over 10 steps of 20 ms. Next during the
   *   fade-in completes it; Next/Back during the fade-out jumps straight to
   *   the new part. Background and images switch only once the old text has
   *   faded out, like upstream's `display_part`.
   * - Keys: Space/Enter/Right next, Backspace/Left back, Escape skips.
   *   Clicking the text also advances.
   *
   * `GameShell` owns what happens after the story (`onDone`).
   */
  import { onDestroy } from 'svelte';
  import type { ResolvedStoryPart } from '@wesnothweb2/engine';
  import { layoutFloatingImage, layoutStoryPart, titleOrigin, type Size } from './story/storyLayout.js';
  import { pickStoryImage, GAME_IMAGES_BASE, type StoryAssets } from './story/storyImages.js';

  let {
    parts,
    assets,
    onDone,
  }: {
    parts: readonly ResolvedStoryPart[];
    /** Rooted image table for this scenario; null renders text only. */
    assets: StoryAssets | null;
    onDone: () => void;
  } = $props();

  const ENGINE_IMAGES = '/game-images-engine';
  const FADE_STEP_MS = 20;

  /** The part being navigated to. */
  let partIndex = $state(0);
  /** The part whose background, images and text are on screen. */
  let shownIndex = $state(0);
  let fadeState: 'in' | 'out' | 'none' = 'none';
  let fadeStep = 0;
  let alpha = $state(0);
  /** How many of the shown part's floating images have appeared. */
  let revealed = $state(0);
  let closed = false;

  let viewportW = $state(0);
  let viewportH = $state(0);
  let titleW = $state(0);
  let titleH = $state(0);
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;

  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  let imageTimer: ReturnType<typeof setTimeout> | undefined;

  const part = $derived(parts[shownIndex]);
  const viewport = $derived<Size>({ w: viewportW, h: viewportH });

  function sizeOf(image: string): Size | undefined {
    const entry = assets?.images[image];
    return entry ? { w: entry.w, h: entry.h } : undefined;
  }

  function urlOf(image: string, drawnWidth: number): string | undefined {
    const entry = assets?.images[image];
    return entry ? pickStoryImage(entry, drawnWidth, dpr).url : undefined;
  }

  const layout = $derived(part && viewportW > 0 ? layoutStoryPart(part, viewport, sizeOf) : null);

  /** Every image URL a part shows at the current viewport size. */
  function partUrls(index: number): string[] {
    const p = parts[index];
    if (!p || viewportW <= 0) return [];
    const l = layoutStoryPart(p, viewport, sizeOf);
    const urls = l.layers.map((layer) => urlOf(layer.image, layer.w)).filter((u): u is string => !!u);
    for (const image of p.floatingImages) {
      const size = sizeOf(image.file);
      const url = size ? urlOf(image.file, size.w) : undefined;
      if (url) urls.push(url);
    }
    return urls;
  }

  /**
   * Decoded images for the previous, shown and next part. Holding the
   * `Image` keeps the decoded bitmap alive, so moving to a neighbouring part
   * paints immediately; anything further away is dropped.
   */
  const preloaded = new Map<string, HTMLImageElement>();
  let decodedUrls = $state<ReadonlySet<string>>(new Set());

  $effect(() => {
    const wanted = new Set([...partUrls(shownIndex), ...partUrls(partIndex + 1), ...partUrls(shownIndex - 1)]);
    for (const url of wanted) {
      if (preloaded.has(url)) continue;
      const img = new Image();
      img.src = url;
      preloaded.set(url, img);
      img
        .decode()
        .catch(() => undefined)
        .then(() => {
          if (preloaded.get(url) === img) decodedUrls = new Set([...decodedUrls, url]);
        });
    }
    for (const url of [...preloaded.keys()]) {
      if (wanted.has(url)) continue;
      preloaded.delete(url);
      if (decodedUrls.has(url)) decodedUrls = new Set([...decodedUrls].filter((u) => u !== url));
    }
  });

  /** The shown part's background art has not finished decoding. */
  const artPending = $derived(
    layout ? layout.layers.some((layer) => {
      const url = urlOf(layer.image, layer.w);
      return !!url && !decodedUrls.has(url);
    }) : false,
  );
  /** Only surface the wait once it is long enough to notice. */
  let showLoading = $state(false);
  $effect(() => {
    if (!artPending) {
      showLoading = false;
      return;
    }
    const timer = setTimeout(() => (showLoading = true), 150);
    return () => clearTimeout(timer);
  });

  const floating = $derived.by(() => {
    if (!part || !layout) return [];
    const out: { key: number; url: string; x: number; y: number; w: number; h: number }[] = [];
    part.floatingImages.forEach((image, i) => {
      if (i >= revealed) return;
      const size = sizeOf(image.file);
      const url = size ? urlOf(image.file, size.w) : undefined;
      if (!size || !url) return;
      const rect = layoutFloatingImage(image, layout.base, size);
      out.push({ key: i, url, x: rect.x, y: rect.y, w: rect.w, h: rect.h });
    });
    return out;
  });

  const hasBackground = $derived(part ? part.backgroundLayers.some((l) => l.image !== '') : false);
  const showTitle = $derived(!!part && part.showTitle && part.title !== '');
  const showPanel = $derived(!!part && part.text !== '' && hasBackground);
  const title = $derived(showTitle && part ? titleOrigin(part.titlePosition, viewport, { w: titleW, h: titleH }) : { x: 0, y: 0 });
  /** `_GUI_SPACER_WIDTH`: the side columns holding the arrows. */
  const sideWidth = $derived(Math.trunc((viewportW - Math.min(viewportW / 1.5, 1000)) / 2));
  const panelMinHeight = $derived(Math.max(150, Math.trunc(viewportH / 4)));

  function clearImageTimer(): void {
    if (imageTimer !== undefined) clearTimeout(imageTimer);
    imageTimer = undefined;
  }

  /** `draw_floating_image`: reveal images until one has a delay, then schedule the rest. */
  function drawFloatingImages(from: number, forPart: number): void {
    const images = parts[forPart]?.floatingImages ?? [];
    let i = from;
    while (forPart === partIndex && i < images.length) {
      const image = images[i]!;
      i += 1;
      revealed = i;
      if (image.delay > 0) {
        imageTimer = setTimeout(() => drawFloatingImages(i, forPart), image.delay);
        return;
      }
    }
    imageTimer = undefined;
  }

  function displayPart(): void {
    shownIndex = partIndex;
    revealed = 0;
    alpha = 0;
    beginFade(true);
    clearImageTimer();
    drawFloatingImages(0, partIndex);
  }

  function beginFade(fadeIn: boolean): void {
    fadeStep = fadeIn ? 0 : 10;
    fadeState = fadeIn ? 'in' : 'out';
    scheduleFadeTick();
  }

  function haltFade(): void {
    if (fadeTimer !== undefined) clearTimeout(fadeTimer);
    fadeTimer = undefined;
    fadeStep = -1;
    fadeState = 'none';
  }

  function scheduleFadeTick(): void {
    if (fadeTimer !== undefined) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(fadeTick, FADE_STEP_MS);
  }

  function fadeTick(): void {
    fadeTimer = undefined;
    if (fadeState === 'none') return;
    if (fadeState === 'in' && fadeStep > 10) {
      haltFade();
      return;
    }
    if (fadeState === 'out' && fadeStep < 0) {
      haltFade();
      displayPart();
      return;
    }
    alpha = Math.min(Math.max(fadeStep * 25.5, 0), 255) / 255;
    // End the fade on the step that reaches full/zero alpha instead of one tick later (upstream's
    // extra 20 ms tick). While the main thread is busy -- the board is built behind the story -- that
    // tick can be delayed by seconds, and a Next pressed meanwhile would only "finish" an already
    // finished fade and be swallowed.
    if (fadeState === 'in' && fadeStep >= 10) {
      haltFade();
      return;
    }
    if (fadeState === 'out' && fadeStep <= 0) {
      haltFade();
      displayPart();
      return;
    }
    fadeStep += fadeState === 'in' ? 1 : -1;
    scheduleFadeTick();
  }

  function close(): void {
    if (closed) return;
    closed = true;
    haltFade();
    clearImageTimer();
    onDone();
  }

  /** `nav_button_callback`. */
  function navigate(direction: 1 | -1): void {
    if (closed) return;
    if (fadeState === 'in') {
      haltFade();
      if (direction === 1) {
        alpha = 1;
        return;
      }
    }
    if (fadeState === 'out') {
      haltFade();
      displayPart();
      return;
    }
    partIndex += direction;
    if (partIndex >= parts.length) {
      close();
      return;
    }
    if (partIndex < 0) partIndex = 0;
    beginFade(false);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
      e.preventDefault();
      navigate(1);
    } else if (e.key === 'Backspace' || e.key === 'ArrowLeft') {
      e.preventDefault();
      navigate(-1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  if (parts.length > 0) displayPart();

  onDestroy(() => {
    haltFade();
    clearImageTimer();
  });
</script>

<svelte:window onkeydown={onKeydown} />

{#if part}
  <div class="story" role="dialog" aria-modal="true" aria-label="Story" bind:clientWidth={viewportW} bind:clientHeight={viewportH}>
    {#if layout}
      {#each layout.layers as layer, i (`${shownIndex}:${i}`)}
        {@const url = urlOf(layer.image, layer.w)}
        {@const size = sizeOf(layer.image)}
        {#if url && size}
          <div
            class="layer"
            style:left="{layer.x}px"
            style:top="{layer.y}px"
            style:width="{layer.w}px"
            style:height="{layer.h}px"
            style:background-image="url('{url}')"
            style:background-size={layer.tile ? `${size.w}px ${size.h}px` : '100% 100%'}
            style:background-repeat={layer.tile ? 'repeat' : 'no-repeat'}
            style:background-position={layer.tile ? 'center' : '0 0'}
          ></div>
        {/if}
      {/each}
      {#each floating as image (`${shownIndex}:${image.key}`)}
        <img class="floating" src={image.url} alt="" style:left="{image.x}px" style:top="{image.y}px" style:width="{image.w}px" style:height="{image.h}px" />
      {/each}
    {/if}

    {#if showLoading}
      <div class="loading" role="status">Loading…</div>
    {/if}

    <div class="title-decor" style:background-image="url('{ENGINE_IMAGES}/dialogs/story_title_decor.png')"></div>

    {#if showTitle}
      <div
        class="title"
        bind:clientWidth={titleW}
        bind:clientHeight={titleH}
        style:left="{title.x}px"
        style:top="{title.y}px"
        style:opacity={alpha}
        style:text-align={part.titleAlignment}
      >
        {part.title}
      </div>
    {/if}

    <div class="stack stack-{part.textLayout}" style:min-height="{panelMinHeight}px">
      {#if showPanel}
        <div class="panel" class:panel-not-bottom={part.textLayout !== 'bottom'} style:background-image="url('{ENGINE_IMAGES}/dialogs/translucent65-background.png')">
          {#if part.textLayout !== 'top' || showTitle}
            <div class="panel-border-top" style:background-image="url('{ENGINE_IMAGES}/dialogs/translucent65-border-top.png')"></div>
          {/if}
          {#if part.textLayout !== 'bottom'}
            <div class="panel-border-bottom" style:background-image="url('{ENGINE_IMAGES}/dialogs/translucent65-border-bottom.png')"></div>
          {/if}
        </div>
      {/if}

      <div class="side" style:width="{sideWidth}px">
        <button class="arrow" aria-label="Previous" disabled={partIndex === 0} onclick={() => navigate(-1)}>
          <img src="{ENGINE_IMAGES}/misc/ornate_big_arrow_decor_left.png" alt="" />
        </button>
      </div>

      <div class="middle">
        <!-- svelte-ignore a11y_click_events_have_key_events -- keyboard navigation is handled window-wide above -->
        <div class="text" role="button" tabindex="-1" style:opacity={alpha} style:text-align={part.textAlignment} onclick={() => navigate(1)}>
          {part.text}
        </div>
        <button class="skip" onclick={close}>Skip</button>
      </div>

      <div class="side" style:width="{sideWidth}px">
        <button class="arrow" aria-label="Next" onclick={() => navigate(1)}>
          <img src="{ENGINE_IMAGES}/misc/ornate_big_arrow_decor_right.png" alt="" />
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  @font-face {
    /* Stand-in for upstream's WesScript (see docs/PROGRESS.md, Phase 16): IM Fell English, SIL OFL 1.1. */
    font-family: 'Story Script';
    src: url('./assets/fonts/im-fell-english-latin-400-normal.woff2') format('woff2');
    font-display: swap;
  }

  .story {
    --story-script-font: 'Story Script', 'Palatino Linotype', Palatino, Georgia, serif;
    position: fixed;
    inset: 0;
    z-index: 100;
    overflow: hidden;
    background: #000;
    color: rgb(215, 215, 215);
    font-family: Lato, 'Segoe UI', system-ui, sans-serif;
    user-select: none;
  }

  .layer,
  .floating {
    position: absolute;
    pointer-events: none;
  }

  .loading {
    position: absolute;
    top: 16px;
    right: 20px;
    padding: 4px 12px;
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.6);
    font-size: 14px;
    color: rgb(186, 172, 125);
    pointer-events: none;
    animation: loading-pulse 1.2s ease-in-out infinite;
  }
  @keyframes loading-pulse {
    50% {
      opacity: 0.45;
    }
  }

  .title-decor {
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    height: 100px;
    background-size: 100% 100%;
    opacity: 0.75;
    pointer-events: none;
  }

  .title {
    position: absolute;
    font-family: var(--story-script-font);
    font-size: 32px;
    line-height: 1.2;
    white-space: nowrap;
    color: rgb(215, 215, 215);
    pointer-events: none;
  }

  .stack {
    position: absolute;
    left: 0;
    right: 0;
    display: flex;
    align-items: stretch;
  }
  .stack-bottom {
    bottom: 0;
  }
  .stack-top {
    top: 0;
  }
  .stack-middle {
    top: 50%;
    transform: translateY(-50%);
  }

  .panel {
    position: absolute;
    inset: 0;
    background-size: 100% 100%;
    pointer-events: none;
  }
  .panel-not-bottom {
    bottom: 8px;
  }
  .panel-border-top,
  .panel-border-bottom {
    position: absolute;
    left: 0;
    right: 0;
    background-size: 100% 100%;
  }
  .panel-border-top {
    top: 0;
    height: 5px;
  }
  .panel-border-bottom {
    bottom: -8px;
    height: 8px;
  }

  .side {
    position: relative;
    flex: none;
    display: flex;
    align-items: flex-end;
    justify-content: center;
  }

  .middle {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .text {
    margin: 20px;
    max-height: 40vh;
    overflow-y: auto;
    white-space: pre-wrap;
    font-size: 17px; /* GUI_FONT_SIZE_DEFAULT */
    line-height: 1.45;
    cursor: pointer;
    outline: none;
  }

  .arrow {
    margin: 20px;
    padding: 0;
    border: 0;
    background: none;
    cursor: pointer;
  }
  .arrow img {
    display: block;
  }
  .arrow:disabled {
    cursor: default;
    filter: grayscale(1);
    opacity: 0.5;
  }
  .arrow:not(:disabled):hover img {
    filter: brightness(1.25) sepia(0.3);
  }

  .skip {
    align-self: center;
    margin: 0 20px 20px;
    padding: 2px 24px;
    border: 0;
    background: none;
    font-family: var(--story-script-font);
    font-size: 20px;
    color: rgba(215, 215, 215, 0.8);
    text-shadow: 0 0 2px #000, 0 0 2px #000;
    cursor: pointer;
  }
  .skip:hover {
    color: rgb(255, 230, 170);
  }

  @media (max-width: 600px) {
    .arrow {
      margin: 12px 4px;
    }
    .arrow img {
      width: 40px;
      height: auto;
    }
    .text {
      margin: 12px 4px;
      font-size: 15px;
    }
  }
</style>
