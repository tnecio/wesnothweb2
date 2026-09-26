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
   * Phase 17: one line at a time, with the event that raised it
   * genuinely suspended behind it -- so `[option]`/`[text_input]` can
   * feed an answer back into the running WML. The option list and the
   * text field follow Phase 15's keyboard conventions (arrows move,
   * Enter confirms); Escape on a plain line skips the rest of the
   * event's dialogue, as upstream's own `skip_messages` does.
   */
  import type { MessageInteraction, InteractionResult } from '@wesnothweb2/engine';
  import { imageUrl } from '@wesnothweb2/renderer';
  import { pickStoryImage, type StoryAssets } from './story/storyImages.js';
  import { layoutMessage, scaledSizeFromPath, type Size } from './story/messageLayout.js';
  import { tx } from './i18n/locale.js';

  let {
    interaction,
    onAnswer,
    assets = null,
    getMapRect,
  }: {
    interaction: MessageInteraction;
    /** Hands the player's answer back to the suspended event. */
    onAnswer: (result: InteractionResult) => void;
    assets?: StoryAssets | null;
    /** The board's on-screen rectangle; the dialog covers it. Falls back to the full window. */
    getMapRect?: () => DOMRect | null;
  } = $props();

  const ENGINE_IMAGES = '/game-images-engine';
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;

  let innerWidth = $state(typeof window === 'undefined' ? 1280 : window.innerWidth);
  let innerHeight = $state(typeof window === 'undefined' ? 720 : window.innerHeight);
  /** Natural sizes of portraits missing from the asset table, learned when they load. */
  let learnedSizes = $state<Record<string, Size>>({});

  const msg = $derived(interaction.message);
  const options = $derived(interaction.options);
  const textInput = $derived(interaction.textInput);
  const hasInput = $derived(options.length > 0 || textInput !== undefined);

  /** Which option row is highlighted; starts on `default=yes` if one asked for it. */
  let optionIndex = $state(0);
  let typed = $state('');
  let inputEl: HTMLInputElement | undefined = $state();

  $effect(() => {
    const preferred = interaction.options.findIndex((o) => o.isDefault);
    optionIndex = preferred >= 0 ? preferred : 0;
    typed = interaction.textInput?.text ?? '';
    if (interaction.textInput) inputEl?.focus();
  });

  function confirm(): void {
    onAnswer({
      value: options.length > 0 ? optionIndex + 1 : undefined,
      text: textInput ? typed : undefined,
    });
  }

  const area = $derived.by(() => {
    void interaction;
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

  function onKeydown(e: KeyboardEvent): void {
    if (options.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      optionIndex = (optionIndex + step + options.length) % options.length;
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      confirm();
      return;
    }
    // Space scrolls a text field, so it only dismisses a plain line.
    if (e.key === ' ' && !hasInput) {
      e.preventDefault();
      confirm();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      // A message that asks something cannot be escaped -- upstream
      // disables Escape for exactly that case; a plain line skips the
      // rest of its event's dialogue.
      if (!hasInput) onAnswer({ skip: true });
    }
  }
</script>

<svelte:window bind:innerWidth bind:innerHeight onkeydown={onKeydown} />

{#if msg && layout}
  <!-- svelte-ignore a11y_click_events_have_key_events -- keys are handled window-wide above -->
  <div class="dismiss" role="presentation" onclick={() => !hasInput && confirm()}>
    <div
      class="window"
      role="dialog"
      aria-label={msg.title || tx('Message')}
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

          {#if textInput}
            <div class="text-input">
              {#if textInput.label}<label for="wml-text-input">{textInput.label}</label>{/if}
              <input
                id="wml-text-input"
                type="text"
                bind:this={inputEl}
                bind:value={typed}
                maxlength={textInput.maxLength}
                onclick={(e) => e.stopPropagation()}
              />
            </div>
          {/if}

          {#if options.length > 0}
            <ul class="options" role="listbox" aria-label={tx('Choices')} tabindex="-1">
              {#each options as option, i (i)}
                <li>
                  <button
                    type="button"
                    class="option"
                    class:selected={i === optionIndex}
                    role="option"
                    aria-selected={i === optionIndex}
                    onclick={(e) => {
                      e.stopPropagation();
                      optionIndex = i;
                      confirm();
                    }}
                  >
                    {#if option.image}<img class="option-icon" src={imageUrl(option.image)} alt="" />{/if}
                    <span class="option-label">{option.label}</span>
                    {#if option.description}<span class="option-description">{option.description}</span>{/if}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
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
  .text-input {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.6rem;
  }
  .text-input input {
    flex: 1 1 auto;
    font: inherit;
    background: rgba(8, 12, 20, 0.85);
    border: 1px solid #6b5a2e;
    border-radius: 3px;
    color: #f1e6c8;
    padding: 0.25rem 0.4rem;
  }
  .options {
    list-style: none;
    margin: 0.6rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    text-align: left;
    font: inherit;
    color: #e8dcc0;
    background: rgba(8, 12, 20, 0.5);
    border: 1px solid transparent;
    border-radius: 3px;
    padding: 0.25rem 0.5rem;
    cursor: pointer;
  }
  .option:hover {
    background: rgba(40, 56, 82, 0.8);
  }
  .option.selected {
    background: #35411f;
    border-color: #8a6a2e;
  }
  .option-icon {
    width: 24px;
    height: 24px;
    object-fit: contain;
  }
  .option-description {
    opacity: 0.8;
    font-size: 0.9em;
  }
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
