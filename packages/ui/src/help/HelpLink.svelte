<script lang="ts">
  /**
   * A word in the side panel that opens its help page when clicked (Phase 24), as upstream's sidebar
   * tooltips do ("click for help", `tooltips.cpp`): a trait, an ability, a weapon special, the alignment,
   * the race, the terrain, the unit type.
   */
  import type { Snippet } from 'svelte';
  import { tx } from '../i18n/locale.js';
  import { helpBrowser, type HelpRequest } from './helpBrowser.svelte.js';

  let { request, title, children }: { request: HelpRequest; title?: string; children: Snippet } = $props();

  function open(): void {
    if ('topic' in request) helpBrowser.open(request.topic);
    else if ('unitType' in request) helpBrowser.openUnitType(request.unitType, request.variation);
    else helpBrowser.openTerrain(request.terrain);
  }
</script>

<button class="help-link" type="button" title={title ? `${title}\n\n${tx('Click for help')}` : tx('Click for help')} onclick={open}
  >{@render children()}</button
>

<style>
  .help-link {
    all: unset;
    cursor: help;
    text-decoration: underline dotted rgba(255, 225, 0, 0.55);
    text-underline-offset: 2px;
  }
  .help-link:hover {
    color: #ffe100;
  }
  .help-link:focus-visible {
    outline: 1px solid #e4c860;
    outline-offset: 1px;
  }
</style>
