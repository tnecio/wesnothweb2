<script lang="ts">
  /**
   * Phase 16 N6: the `[message]` dialog, a port of upstream's
   * `wml_message_left`/`_right`/`_double` windows
   * (`data/gui/themes/default/dialogs/wml_message.cfg`,
   * `src/gui/dialogs/wml_message.cpp`) for messages recorded by the engine
   * (`RecordedMessage`, resolved like `message.lua`).
   *
   * The window covers the map area; a translucent panel runs along its
   * bottom with the title and text, and the portrait stands on the bottom
   * edge on the side the message asks for (left unless `~RIGHT()` or
   * `image_pos=right`). Geometry comes from `story/messageLayout.ts`.
   * Portraits come from the scenario's asset table (rooted, right-sized);
   * the next message's portraits are preloaded. Click anywhere, Enter,
   * Space or Escape continues (`click_dismiss`).
   *
   * Still shown one after another once the events have run; in-order,
   * blocking dialogue and `[option]` are Phase 17.
   */
  import type { RecordedMessage } from '@wesnothweb2/engine';
  import { imageUrl } from '@wesnothweb2/renderer';
  import { pickStoryImage, type StoryAssets } from './story/storyImages.js';
  import { layoutMessage, scaledSizeFromPath, type Size } from './story/messageLayout.js';

  let {
    messages,
    index,
    onNext,
    assets = null,
    getMapRect,
  }: {
    messages: readonly RecordedMessage[];
    index: number;
    onNext: () => void;
    assets?: StoryAssets | null;
    /** The board's on-screen rectangle; the dialog covers it. Falls back to the whole window. */
    getMapRect?: () => DOMRect | null;
  } = $props();

  const ENGINE_IMAGES = '/game-images-engine';
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;

  let innerWidth = $state(typeof window === 'undefined' ? 1280 : window.innerWidth);
  let innerHeight = $state(typeof window === 'undefined' ? 720 : window.innerHeight);
  /** Natural sizes of portraits missing from the asset table, learned when they load. */
  let learnedSizes = $state<Record<string, Size>>({});

  const msg = $derived(messages[index]);

  const area = $derived.by(() => {
    void index;
    const rect = getMapRect?.();
    // Deviation for small screens: when the board is squeezed narrower than a readable dialog
    // (the in-game layout is not mobile-ready yet, Phase 23), cover the whole window instead.
    return rect && rect.width >= 600
      ? { x: rect.left, y: rect.top, w: rect.width, h: innerHeight - rect.top }
      : { x: 0, y: 0, w: innerWidth, h: innerHeight };
  });

  function basePath(ref: string): string {
    return ref.split('~')[0] ?? ref;
  }

  function portraitSize(ref: string): Size | undefined {
    if (ref === '') return undefined;
    const entry = assets?.images[basePath(ref)];
    if (entry) return { w: entry.w, h: entry.h };
    return scaledSizeFromPath(ref) ?? learnedSizes[ref];
  }

  function portraitUrl(ref: string, drawnWidth: number): string {
    const entry = assets?.images[basePath(ref)];
    return entry ? pickStoryImage(entry, drawnWidth, dpr).url : imageUrl(basePath(ref));
  }

  const layout = $derived(
    msg ? layoutMessage(area, portraitSize(msg.portrait), msg.leftSide, portraitSize(msg.secondPortrait)) : null,
  );

  /** Which portrait ends up in which column (see `layoutMessage`). */
  const leftRef = $derived(msg && msg.leftSide ? msg.portrait : '');
  const rightRef = $derived(msg ? (msg.leftSide ? msg.secondPortrait : msg.portrait || msg.secondPortrait) : '');
  const leftMirror = $derived(!!msg?.mirror);
  const rightMirror = $derived(msg ? (msg.leftSide || msg.portrait === '' ? msg.secondMirror : msg.mirror) : false);

  function learnSize(ref: string, e: Event): void {
    if (portraitSize(ref)) return;
    const img = e.currentTarget as HTMLImageElement;
    learnedSizes = { ...learnedSizes, [ref]: { w: img.naturalWidth, h: img.naturalHeight } };
  }

  /** Keep the next message's portraits warm so it paints at once. */
  const preloaded = new Map<string, HTMLImageElement>();
  $effect(() => {
    const next = messages[index + 1];
    const refs = next ? [next.portrait, next.secondPortrait].filter((r) => r !== '') : [];
    for (const ref of refs) {
      const size = portraitSize(ref);
      const url = portraitUrl(ref, size?.w ?? 500);
      if (preloaded.has(url)) continue;
      const img = new Image();
      img.src = url;
      preloaded.set(url, img);
      img.decode().catch(() => undefined);
    }
  });

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') {
      e.preventDefault();
      onNext();
    }
  }
</script>

<svelte:window bind:innerWidth bind:innerHeight onkeydown={onKeydown} />

{#if msg && layout}
  <!-- svelte-ignore a11y_click_events_have_key_events -- keys are handled window-wide above -->
  <div class="dismiss" role="presentation" onclick={onNext}>
    <div
      class="window"
      role="dialog"
      aria-label={msg.title || 'Message'}
      style:left="{area.x}px"
      style:top="{area.y}px"
      style:width="{area.w}px"
      style:height="{area.h}px"
    >
      <div class="panel" style:background-image="url('{ENGINE_IMAGES}/dialogs/translucent65-background.png')">
        <div class="panel-border" style:background-image="url('{ENGINE_IMAGES}/dialogs/translucent65-border-top.png')"></div>
        <div class="content" style:margin-left="{layout.contentX}px" style:width="{layout.contentWidth}px">
          {#if msg.title}
            <div class="title">{msg.title}</div>
          {/if}
          <div class="text">{msg.message}</div>
        </div>
      </div>

      {#if leftRef && layout.left}
        <img
          class="portrait"
          class:mirror={leftMirror}
          src={portraitUrl(leftRef, layout.left.w)}
          alt=""
          onload={(e) => learnSize(leftRef, e)}
          style:left="{layout.left.x}px"
          style:top="{layout.left.y}px"
          style:width="{layout.left.w}px"
          style:height="{layout.left.h}px"
        />
      {:else if leftRef}
        <img class="portrait probe" src={portraitUrl(leftRef, 500)} alt="" onload={(e) => learnSize(leftRef, e)} />
      {/if}
      {#if rightRef && layout.right}
        <img
          class="portrait"
          class:mirror={rightMirror}
          src={portraitUrl(rightRef, layout.right.w)}
          alt=""
          onload={(e) => learnSize(rightRef, e)}
          style:left="{layout.right.x}px"
          style:top="{layout.right.y}px"
          style:width="{layout.right.w}px"
          style:height="{layout.right.h}px"
        />
      {:else if rightRef}
        <img class="portrait probe" src={portraitUrl(rightRef, 500)} alt="" onload={(e) => learnSize(rightRef, e)} />
      {/if}
    </div>
  </div>
{/if}

<style>
  .dismiss {
    position: fixed;
    inset: 0;
    z-index: 100;
    cursor: pointer;
  }

  .window {
    position: fixed;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    font-family: Lato, 'Segoe UI', system-ui, sans-serif;
  }

  .panel {
    position: relative;
    min-height: 75px;
    padding: 10px 0 13px;
    background-size: 100% 100%;
  }
  .panel-border {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 5px;
    background-size: 100% 100%;
  }

  .content {
    position: relative;
    box-sizing: border-box;
    padding: 5px;
  }

  /* GUI_FONT_SIZE_TITLE (22) in GUI__FONT_COLOR_ENABLED__TITLE; message text GUI_FONT_SIZE_DEFAULT (17). */
  .title {
    padding: 5px;
    font-size: 22px;
    font-weight: 700;
    color: rgb(186, 172, 125);
  }

  .text {
    padding: 5px;
    max-height: 40vh;
    overflow-y: auto;
    white-space: pre-wrap;
    font-size: 17px;
    line-height: 1.45;
    color: rgb(215, 215, 215);
  }

  .portrait {
    position: absolute;
    pointer-events: none;
    image-rendering: auto;
  }
  .portrait.mirror {
    transform: scaleX(-1);
  }
  .portrait.probe {
    visibility: hidden;
    left: 0;
    top: 0;
  }
</style>
