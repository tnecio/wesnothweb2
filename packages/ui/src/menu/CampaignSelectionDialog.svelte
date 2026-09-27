<script lang="ts">
  /**
   * "Play a Campaign" (`gui2::dialogs::campaign_selection`, `campaign_dialog.cfg`).
   *
   * Left: a filter box, Name / Timeline sort toggles, the completion filter, and the campaign list (icon, name
   * and victory laurel; debug campaigns after the real ones, under their own heading). Right: the selected
   * campaign's image and description over its background picture, and its difficulty choices. The Combat RNG
   * and Modifications menus of upstream's dialog are not ported (RNG modes are Phase 30).
   *
   * The keyboard works as upstream's does: the filter box has the focus, typing filters, Up/Down move through
   * the list, Enter plays. Presentational: it reports the choice; `MainMenu.svelte` navigates.
   */
  import { imageUrl } from '@wesnothweb2/renderer';
  import Modal from '../Modal.svelte';
  import IpfImage from '../images/IpfImage.svelte';
  import Markup from '../markup/Markup.svelte';
  import { locale, t, ts, tx } from '../i18n/locale.js';
  import { languageTag } from '../i18n/locale.js';
  import { defaultDifficulty } from '../save/campaign.js';
  import type { Campaign } from '../campaigns.js';
  import { matchesSearch, nextSort, searchWords, sortCampaigns, type SortState } from './campaignList.js';
  import {
    COMPLETION_FILTERS,
    LAUREL_IMAGES,
    campaignLaurel,
    difficultyLaurel,
    isCompletedAt,
    passesCompletionFilter,
    summarizeCompletion,
    type CompletedCampaigns,
    type CompletionFilter,
    type Laurel,
  } from './completion.js';

  let {
    campaigns,
    completed,
    onPlay,
    onCancel,
  }: {
    campaigns: readonly Campaign[];
    completed: CompletedCampaigns;
    /** `difficulty` is the chosen `[difficulty] define=`, undefined for a campaign that has none. */
    onPlay: (campaign: Campaign, difficulty: string | undefined) => void;
    onCancel: () => void;
  } = $props();

  let filterText = $state('');
  let sort = $state<SortState>({ key: 'rank', ascending: true });
  let shown = $state<ReadonlySet<CompletionFilter>>(new Set(COMPLETION_FILTERS));
  let selectedId = $state<string | null>(null);
  /** The difficulty picked for each campaign this session; a campaign not in here is at its default. */
  let picked = $state<Record<string, string>>({});

  const COMPLETION_LABELS: Record<CompletionFilter, () => string> = {
    'not-completed': () => t('Not Completed'),
    bronze: () => t('Completed: Bronze'),
    silver: () => t('Completed: Silver'),
    gold: () => t('Completed: Gold'),
    'all-completed': () => t('Completed: All'),
  };
  const COMPLETION_TOOLTIPS: Record<CompletionFilter, () => string> = {
    'not-completed': () => t('Show campaigns not completed by player'),
    bronze: () => t('Show campaigns completed at easiest difficulty'),
    silver: () => t('Show campaigns completed at intermediate difficulties'),
    gold: () => t('Show campaigns completed at hardest difficulty'),
    'all-completed': () => t('Show completed campaigns'),
  };
  const LAUREL_LABELS: Record<Laurel, () => string> = {
    easy: () => t('Completed: Bronze'),
    normal: () => t('Completed: Silver'),
    hardest: () => t('Completed: Gold'),
  };

  /** Everything the filter box searches, in either language: names, descriptions and the abbreviation. */
  function searchable(c: Campaign): string[] {
    return [ts(c.nameT), c.name, ts(c.descriptionT), c.description ?? '', c.abbrev ?? ''];
  }

  const visible = $derived.by(() => {
    const words = searchWords(filterText);
    const sorted = sortCampaigns(campaigns, sort, (c) => ts(c.nameT), languageTag(locale.current));
    const keep = (c: Campaign): boolean => matchesSearch(words, searchable(c)) && passesCompletionFilter(summarizeCompletion(c, completed), shown);
    const list = sorted.filter(keep);
    return { real: list.filter((c) => !c.debug), debug: list.filter((c) => c.debug) };
  });
  const flat = $derived([...visible.real, ...visible.debug]);
  const selected = $derived(flat.find((c) => c.id === selectedId) ?? null);
  const difficulties = $derived(selected?.difficulties ?? []);
  const chosen = $derived(selected ? (picked[selected.id] ?? defaultDifficulty(selected)) : undefined);

  function move(delta: number): void {
    if (flat.length === 0) return;
    const at = flat.findIndex((c) => c.id === selectedId);
    const next = at < 0 ? (delta > 0 ? 0 : flat.length - 1) : Math.min(flat.length - 1, Math.max(0, at + delta));
    selectedId = flat[next]!.id;
  }

  function play(): void {
    if (selected) onPlay(selected, chosen);
  }

  function onListKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'Home' && e.target !== filterInput) selectedId = flat[0]?.id ?? null;
    else if (e.key === 'End' && e.target !== filterInput) selectedId = flat[flat.length - 1]?.id ?? null;
    else if (e.key === 'Enter' && selected) play();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function toggleCompletion(key: CompletionFilter): void {
    const next = new Set(shown);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    shown = next;
  }

  /** A difficulty's picture: its own image, with the laurel behind it when that level was won (`campaign_selection.cpp`). */
  function difficultyImage(campaignId: string, i: number, count: number, define: string, image: string | undefined): string {
    const base = image ?? 'misc/blank-hex.png';
    return isCompletedAt(completed, campaignId, define) ? `${LAUREL_IMAGES[difficultyLaurel(i, count)]}~BLIT(${base})` : base;
  }

  const alignment = $derived((selected?.descriptionAlignment as 'left' | 'center' | 'right' | undefined) ?? 'left');
  let filterInput = $state<HTMLInputElement | undefined>();
  const activeId = $derived(selected ? `campaign-option-${selected.id}` : undefined);
</script>

<Modal title={t('Play a Campaign')} onClose={onCancel} width="66rem">
  {#snippet children()}
    <div class="dialog" data-testid="campaign-dialog">
      <div class="search">
        <input
          type="search"
          bind:this={filterInput}
          bind:value={filterText}
          placeholder={t('Search')}
          aria-label={t('Search')}
          aria-controls="campaign-list"
          aria-activedescendant={activeId}
          data-autofocus
          data-testid="campaign-filter"
          onkeydown={onListKey}
        />
      </div>

      <div class="panes">
        <div class="left">
          <div class="tools">
            <button class="sort" aria-pressed={sort.key === 'name'} title={t('Sort by full campaign name in alphabetical order')} onclick={() => (sort = nextSort(sort, 'name'))} data-testid="sort-name">
              {t('Name')}{sort.key === 'name' ? (sort.ascending ? ' ▲' : ' ▼') : ''}
            </button>
            <button class="sort" aria-pressed={sort.key === 'timeline'} title={t('Sort in approximate chronological order of story events')} onclick={() => (sort = nextSort(sort, 'timeline'))} data-testid="sort-timeline">
              {t('Timeline')}{sort.key === 'timeline' ? (sort.ascending ? ' ▲' : ' ▼') : ''}
            </button>
            <details class="completion" data-testid="completion-filter">
              <summary title={t('Filter by campaign completion status')}>{t('Filter:')}</summary>
              <div class="completion-menu">
                {#each COMPLETION_FILTERS as key (key)}
                  <label title={COMPLETION_TOOLTIPS[key]()}>
                    <input type="checkbox" checked={shown.has(key)} onchange={() => toggleCompletion(key)} data-testid={`completion-${key}`} />
                    {COMPLETION_LABELS[key]()}
                  </label>
                {/each}
              </div>
            </details>
          </div>

          <ul id="campaign-list" class="list" role="listbox" aria-label={t('Campaigns')} tabindex="0" aria-activedescendant={activeId} onkeydown={onListKey} data-testid="campaign-list">
            {#snippet row(c: Campaign)}
              {@const laurel = campaignLaurel(c, completed)}
              <li
                id={`campaign-option-${c.id}`}
                role="option"
                aria-selected={c.id === selectedId}
                class="option"
                class:selected={c.id === selectedId}
                class:debug={c.debug}
                data-testid={`campaign-${c.id}`}
                onclick={() => (selectedId = c.id)}
                ondblclick={() => {
                  selectedId = c.id;
                  play();
                }}
              >
                <span class="icon">{#if c.icon}<IpfImage src={c.icon} width={36} height={36} />{/if}</span>
                <span class="name" dir="auto">{ts(c.nameT)}</span>
                {#if laurel}
                  <img class="laurel" src={imageUrl(LAUREL_IMAGES[laurel])} alt={LAUREL_LABELS[laurel]()} title={LAUREL_LABELS[laurel]()} />
                {/if}
              </li>
            {/snippet}
            {#each visible.real as c (c.id)}{@render row(c)}{/each}
            {#if visible.debug.length > 0}
              <li class="heading" role="presentation">{tx('Debug campaigns')}</li>
              {#each visible.debug as c (c.id)}{@render row(c)}{/each}
            {/if}
            {#if flat.length === 0}
              <li class="empty" role="presentation">{tx('No campaign matches.')}</li>
            {/if}
          </ul>
        </div>

        <div class="right" style:background-image={selected?.background ? `url(${imageUrl(selected.background.replace(/^data\//, ''))})` : undefined} data-testid="campaign-details">
          <div class="details">
            {#if selected}
              {#if selected.image}
                <div class="picture"><IpfImage src={selected.image} /></div>
              {/if}
              <div class="description" dir="auto" style:text-align={alignment} data-testid="campaign-description"><Markup text={ts(selected.descriptionT)} /></div>
            {:else}
              <p class="landing">{tx('Select a campaign to see its description.')}</p>
            {/if}
          </div>
        </div>
      </div>

      <div class="options">
        <span class="label" id="difficulty-label">{t('Difficulty:')}</span>
        <div class="difficulty" role="radiogroup" aria-labelledby="difficulty-label" aria-disabled={difficulties.length === 0} data-testid="difficulty-menu">
          {#each difficulties as d, i (d.define)}
            <label class="level" class:on={chosen === d.define}>
              <input
                type="radio"
                name="difficulty"
                value={d.define}
                checked={chosen === d.define}
                onchange={() => selected && (picked = { ...picked, [selected.id]: d.define })}
                data-testid={`difficulty-${d.define}`}
              />
              <span class="level-icon"><IpfImage src={difficultyImage(selected!.id, i, difficulties.length, d.define, d.image)} width={36} height={36} /></span>
              <span class="level-text" dir="auto">
                <span class="level-label">{ts(d.label)}</span>
                {#if ts(d.description) !== ''}
                  <span class="level-description">{d.autoMarkup === false ? ts(d.description) : `(${ts(d.description)})`}</span>
                {/if}
              </span>
              {#if isCompletedAt(completed, selected!.id, d.define)}
                <img class="laurel" src={imageUrl(LAUREL_IMAGES[difficultyLaurel(i, difficulties.length)])} alt={LAUREL_LABELS[difficultyLaurel(i, difficulties.length)]()} />
              {/if}
            </label>
          {/each}
        </div>
      </div>

      <div class="footer">
        <span class="spacer"></span>
        <button class="primary" disabled={!selected} onclick={play} data-testid="campaign-play">{t('game^Play')}</button>
        <button onclick={onCancel} data-testid="campaign-cancel">{t('Cancel')}</button>
      </div>
    </div>
  {/snippet}
</Modal>

<style>
  .dialog {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    min-height: 0;
  }
  .search input {
    width: 100%;
    box-sizing: border-box;
    font: inherit;
    padding: 0.35rem 0.6rem;
    border-radius: 4px;
    border: 1px solid #4a3d1e;
    background: #0a0d15;
    color: inherit;
  }
  .panes {
    display: grid;
    grid-template-columns: minmax(15rem, 22rem) 1fr;
    gap: 0.75rem;
    min-height: 0;
    height: min(30rem, 55vh);
  }
  .left {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    min-height: 0;
  }
  .tools {
    display: flex;
    gap: 0.35rem;
    align-items: stretch;
    flex-wrap: wrap;
  }
  button,
  summary {
    font: inherit;
    color: inherit;
    cursor: pointer;
    padding: 0.25rem 0.7rem;
    border-radius: 4px;
    border: 1px solid #4a3d1e;
    background: #1a1712;
  }
  button:hover:not(:disabled),
  summary:hover {
    border-color: #8a6a2e;
  }
  button[aria-pressed='true'] {
    background: #2c2820;
    border-color: #8a6a2e;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button.primary {
    background: #6a4a1e;
    border-color: #8a6a2e;
    color: #f1e6c8;
    padding: 0.4rem 1.6rem;
  }
  .completion {
    position: relative;
  }
  summary {
    list-style: none;
  }
  .completion-menu {
    position: absolute;
    z-index: 5;
    top: 100%;
    left: 0;
    margin-top: 2px;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 14rem;
    padding: 0.5rem 0.7rem;
    background: #0a0d15;
    border: 1px solid #8a6a2e;
    border-radius: 4px;
  }
  .completion-menu label {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    cursor: pointer;
  }
  .list {
    flex: 1;
    min-height: 0;
    overflow: auto;
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid #4a3d1e;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.35);
  }
  .list:focus-visible {
    outline: 2px solid #ffd54a;
  }
  .option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
    cursor: pointer;
    border-bottom: 1px solid rgba(74, 61, 30, 0.4);
  }
  .option:hover {
    background: rgba(138, 106, 46, 0.2);
  }
  .option.selected {
    background: rgba(138, 106, 46, 0.45);
  }
  .option.debug .name {
    opacity: 0.7;
    font-style: italic;
  }
  .icon {
    flex: none;
    width: 36px;
    height: 36px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
    hyphens: auto;
  }
  .laurel {
    flex: none;
    width: 1.6rem;
    height: 1.6rem;
    object-fit: contain;
  }
  .heading {
    padding: 0.4rem 0.6rem 0.2rem;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #a89252;
    background: rgba(0, 0, 0, 0.3);
  }
  .empty {
    padding: 0.8rem;
    opacity: 0.7;
  }
  .right {
    min-height: 0;
    overflow: auto;
    border: 1px solid #4a3d1e;
    border-radius: 4px;
    background: #0a0d15 center / cover no-repeat;
  }
  .details {
    min-height: 100%;
    box-sizing: border-box;
    padding: 0.8rem;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.8rem;
  }
  .picture :global(img) {
    max-width: 100%;
    max-height: 18rem;
    border-radius: 4px;
  }
  .description {
    align-self: stretch;
    white-space: pre-line;
    line-height: 1.4;
    overflow-wrap: anywhere;
    hyphens: auto;
  }
  .landing {
    opacity: 0.8;
    margin: auto;
  }
  .options {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .label {
    padding-top: 0.35rem;
  }
  .difficulty {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    flex: 1;
  }
  .difficulty[aria-disabled='true'] {
    opacity: 0.5;
  }
  .level {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.2rem 0.6rem 0.2rem 0.4rem;
    border: 1px solid #4a3d1e;
    border-radius: 4px;
    background: #1a1712;
    cursor: pointer;
  }
  .level.on {
    border-color: #ffd54a;
    background: #2c2820;
  }
  .level:focus-within {
    outline: 2px solid #ffd54a;
  }
  .level input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .level-icon {
    flex: none;
    width: 36px;
    height: 36px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .level-text {
    display: flex;
    flex-direction: column;
  }
  .level-description {
    font-size: 0.8rem;
    color: #a9a48f;
  }
  .footer {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .spacer {
    flex: 1;
  }

  /* The dialog re-flows to its own width: on a narrow screen (or a large font) the list sits above the details. */
  @container (max-width: 44rem) {
    .panes {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(9rem, 1fr) minmax(9rem, 1fr);
      height: min(34rem, 65vh);
    }
    .picture :global(img) {
      max-height: 7rem;
    }
  }
</style>
