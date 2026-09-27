<script lang="ts">
  /**
   * The title screen (`gui2::dialogs::title_screen`, `data/gui/themes/default/dialogs/title_screen.cfg`).
   *
   * Layout as upstream's: the stretched `maps/background.webp` with `maps/titlescreen.webp` fitted and centred
   * over it, the logo 30 px from the top, the tip-of-the-day panel bottom-left and the button column
   * bottom-right (both translucent panels), and a bar along the bottom with the version and the Language
   * button. Help, Multiplayer, the map editor, Add-ons, Achievements and Community have no counterpart here.
   *
   * Presentational: it reports what was asked for; `MainMenu.svelte` owns the dialogs and the navigation.
   * Keys are upstream's (`hotkeys.cfg`): C campaigns, Ctrl+O load, Ctrl+P preferences, L language, Space
   * credits, Left/Right the tips. They do nothing while a dialog is open (`blocked`) or while typing.
   */
  import { fmt, t, ts, tw, tx } from '../i18n/locale.js';
  import Markup from '../markup/Markup.svelte';
  import { locale } from '../i18n/locale.js';
  import { matchesHotkey } from '../commands.js';
  import { stepTip, type Tip } from './tips.js';

  let {
    version,
    tips,
    showTips,
    blocked,
    onCampaigns,
    onLoad,
    onPreferences,
    onCredits,
    onLanguage,
  }: {
    /** Shown as "Version $version". */
    version: string;
    /** In the order to show them (already shuffled). */
    tips: readonly Tip[];
    showTips: boolean;
    /** A dialog is open on top: the screen's own keys are off. */
    blocked: boolean;
    onCampaigns: () => void;
    onLoad: () => void;
    onPreferences: () => void;
    onCredits: () => void;
    onLanguage: () => void;
  } = $props();

  let tipIndex = $state(0);
  const tip = $derived(tips.length > 0 ? tips[Math.min(tipIndex, tips.length - 1)] : undefined);

  function isTyping(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    const tag = el?.tagName?.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || !!el?.isContentEditable;
  }

  function onKeydown(e: KeyboardEvent): void {
    if (blocked || e.defaultPrevented || isTyping(e.target)) return;
    // Space on a focused button is that button's own activation.
    const onButton = (e.target as HTMLElement | null)?.closest?.('button, a[href]');
    const keys: [Parameters<typeof matchesHotkey>[1], () => void][] = [
      [{ key: 'c' }, onCampaigns],
      [{ key: 'o', ctrl: true }, onLoad],
      [{ key: 'p', ctrl: true }, onPreferences],
      [{ key: 'l' }, onLanguage],
      [{ key: ' ' }, onCredits],
      [{ key: 'ArrowRight' }, () => (tipIndex = stepTip(tipIndex, tips.length, false))],
      [{ key: 'ArrowLeft' }, () => (tipIndex = stepTip(tipIndex, tips.length, true))],
    ];
    for (const [key, action] of keys) {
      if (!matchesHotkey(e, key)) continue;
      if (onButton && (key.key === ' ' || key.key.startsWith('Arrow'))) return;
      e.preventDefault();
      action();
      return;
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="title" data-testid="title-screen">
  <img class="backdrop" src="/game-images/core/images/maps/background.webp" alt="" draggable="false" />
  <img class="picture" src="/game-images/core/images/maps/titlescreen.webp" alt="" draggable="false" />

  <h1 class="logo">
    <img class="logo-bg" src="/game-images-engine/misc/logo-bg.png" alt="" draggable="false" />
    <img class="logo-fg" src="/game-images-engine/misc/logo.png" alt={tw('The Battle for Wesnoth')} draggable="false" />
  </h1>

  <div class="stage">
    {#if showTips && tip}
      <section class="panel tips" aria-label={tx('Tip of the day')} data-testid="tip-panel">
        <p class="tip" dir="auto" data-testid="tip-text"><Markup text={ts(tip.text)} /></p>
        <p class="source" dir="auto"><Markup text={ts(tip.source)} /></p>
        <div class="tip-buttons">
          <span class="spacer"></span>
          <button class="small" title={t('Show previous tip of the day')} onclick={() => (tipIndex = stepTip(tipIndex, tips.length, true))} data-testid="tip-previous">{t('Previous')}</button>
          <button class="small" title={t('Show next tip of the day')} onclick={() => (tipIndex = stepTip(tipIndex, tips.length, false))} data-testid="tip-next">{t('Next')}</button>
        </div>
      </section>
    {:else}
      <span></span>
    {/if}

    <nav class="panel menu" aria-label={tx('Main menu')} data-testid="title-menu">
      <button class="large" title={t('Start a new single player campaign')} onclick={onCampaigns} data-testid="title-campaigns" data-autofocus>{t('Campaigns')}</button>
      <button class="large" title={t('Load a saved game')} onclick={onLoad} data-testid="title-load">{t('Load')}</button>
      <button class="large" title={t('Configure the game’s settings')} onclick={onPreferences} data-testid="title-preferences">{t('Preferences')}</button>
      <button class="large" title={t('Show Credits')} onclick={onCredits} data-testid="title-credits">{t('Credits')}</button>
    </nav>
  </div>

  <div class="bar">
    <span class="version" data-testid="title-version">{fmt(t('Version $version'), { version })}</span>
    <button class="language" title={t('Change the language')} onclick={onLanguage} data-testid="title-language">
      {locale.currentInfo?.name ?? t('Language')}
    </button>
  </div>
</div>

<style>
  .title {
    direction: ltr; /* Wesnoth does not mirror its GUI for right-to-left languages; text runs pick their own direction (dir="auto") */
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #000;
    color: #f4efe0;
    font-family: var(--font-ui);
  }
  /* `maps/background.webp` is stretched to the window; `titlescreen.webp` keeps its shape, fitted and centred. */
  .backdrop {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: fill;
    pointer-events: none;
  }
  .picture {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    pointer-events: none;
  }
  .logo {
    position: relative;
    margin: 30px auto 0;
    width: min(600px, 90vw);
    aspect-ratio: 3 / 1;
    flex: none;
  }
  .logo img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 2rem;
    padding: 0 calc(4vw + 0.5rem) 0.8rem;
  }
  .panel {
    background: rgba(0, 0, 0, 0.54);
    border: 3px solid rgb(16, 22, 35);
    box-shadow: inset 0 0 0 1px #a89252;
    backdrop-filter: blur(3px);
    padding: 0.7rem;
  }
  .tips {
    max-width: 650px;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .tip {
    margin: 0;
    font-size: 1.05rem;
    line-height: 1.4;
    white-space: pre-line;
  }
  .source {
    margin: 0;
    text-align: right;
    font-size: 0.9rem;
    color: #d8d0b8;
  }
  .tip-buttons {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }
  .spacer {
    flex: 1;
  }
  .menu {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    min-width: 13rem;
    flex: none;
  }
  button {
    font: inherit;
    color: #e6dcae;
    cursor: pointer;
    border: 0;
    background: transparent center / 100% 100% no-repeat;
  }
  button:focus-visible {
    outline: 2px solid #ffd54a;
    outline-offset: 1px;
  }
  /* upstream's `large` button art (168x44), its three states stretched to the button */
  button.large {
    min-height: 2.75rem;
    padding: 0.35rem 1.2rem;
    font-size: 1.2rem;
    background-image: url('/game-images-engine/buttons/large-button.png');
  }
  button.large:hover {
    background-image: url('/game-images-engine/buttons/large-button-active.png');
  }
  button.large:active {
    background-image: url('/game-images-engine/buttons/large-button-pressed.png');
  }
  button.small {
    min-height: 1.75rem;
    padding: 0.1rem 0.9rem;
    background-image: url('/game-images-engine/buttons/button_normal/button_H22.png');
  }
  button.small:hover {
    background-image: url('/game-images-engine/buttons/button_normal/button_H22-active.png');
  }
  button.small:active {
    background-image: url('/game-images-engine/buttons/button_normal/button_H22-pressed.png');
  }
  .bar {
    position: relative;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 0.7rem 0.6rem;
    font-size: 0.85rem;
  }
  .version {
    text-shadow: 0 0 3px #000;
  }
  .language {
    min-height: 1.75rem;
    padding: 0.1rem 1rem;
    background-image: url('/game-images-engine/buttons/button_normal/button_H22.png');
  }
  .language:hover {
    background-image: url('/game-images-engine/buttons/button_normal/button_H22-active.png');
  }

  /* Narrow windows: the panels stack (tips under the menu) so both stay readable and the buttons reachable. */
  @media (max-width: 720px) {
    .stage {
      flex-direction: column-reverse;
      align-items: stretch;
      justify-content: flex-start;
      gap: 0.6rem;
      padding: 0.8rem 1rem 0.5rem;
      overflow-y: auto;
    }
    .menu {
      min-width: 0;
    }
    .tips {
      max-width: none;
    }
    .logo {
      margin-top: 12px;
    }
  }
  /*
   * Phase 23, a phone upright: fitted to the middle of a tall screen, the (landscape) map would sit
   * behind the menu. At the top it is under the logo, as on a desktop, and in view above the panels.
   */
  @media (max-width: 720px) and (orientation: portrait) {
    .picture {
      object-position: center top;
    }
  }
</style>
