<script lang="ts">
  /**
   * The help browser (Phase 24): upstream's GUI2 `help_browser` dialog (`data/gui/themes/default/dialogs/
   * help_browser.cfg`, `src/gui/dialogs/help_browser.cpp`). The topic tree is on the left, and a top bar holds
   * the page title, "Show Topics" (which hides the tree), back/next and the search box over the tree. The page
   * is below, and Close is at the bottom. Reference screenshots of the real game's help are in
   * `docs/reference/help/`.
   *
   * On a phone the tree does not fit beside the page: it is an overlay that "Show Topics" opens, and choosing
   * a topic closes it.
   */
  import { ENGINE_IMAGES } from '../gameData.js';
  import type { GameBoardSnapshot } from '@wesnothweb2/engine';
  import { SvelteSet } from 'svelte/reactivity';
  import Modal from '../Modal.svelte';
  import { compactLayout } from '../compactLayout.js';
  import { locale, t, tw, tx } from '../i18n/locale.js';
  import { hiddenSymbol, TERRAIN_PREFIX, topicText, type Topic } from './helpCommon.js';
  import { fetchCoreHelpData, withSnapshot, type HelpGameContext } from './helpData.js';
  import { parseTerrainCode } from '@wesnothweb2/engine';
  import { helpBrowser, type HelpRequest } from './helpBrowser.svelte.js';
  import { unitTypeHelpId } from './generators/units.js';
  import { ancestorsOf, buildHelpTree, HelpHistory, nodeIdOfTopic, topicIdOfNode, visibleNodes, type HelpTreeNode } from './helpNavigation.js';
  import { findTopic, generateContents, type HelpContents } from './helpTree.js';
  import { HelpWorld } from './helpWorld.js';
  import HelpNodes from './HelpNodes.svelte';
  import { MarkupParseError, parseMarkup, type MarkupNode } from './markup.js';

  let {
    snapshot = null,
    game = {},
  }: {
    /** The scenario being played, whose campaign's units and races the help adds to the core ones. */
    snapshot?: GameBoardSnapshot | null;
    game?: HelpGameContext;
  } = $props();

  // Raw: large, replaced whole, and a page's text is generated into its topic on first view.
  let contents = $state.raw<HelpContents | null>(null);
  let world: HelpWorld | null = null;
  let engineImages = $state.raw<ReadonlySet<string>>(new Set());
  let loadError = $state<string | null>(null);

  // Built when the help opens, and again when the language changes (the pages are generated translated).
  $effect(() => {
    const lang = locale.current;
    let cancelled = false;
    fetchCoreHelpData()
      .then((core) => {
        if (cancelled) return;
        void lang;
        world = new HelpWorld(withSnapshot(core, snapshot), game);
        contents = generateContents(world);
        engineImages = new Set(core.engineImages);
      })
      .catch((err: unknown) => {
        console.error('[help] could not load the help:', err);
        if (!cancelled) loadError = String(err);
      });
    return () => {
      cancelled = true;
    };
  });

  let filter = $state('');
  const tree = $derived(contents ? buildHelpTree(contents.toplevel, filter) : { nodes: [] as HelpTreeNode[], unfold: new Set<string>() });
  /** The unfolded sections, by node id. */
  const unfolded = new SvelteSet<string>();
  $effect(() => {
    for (const id of tree.unfold) unfolded.add(id);
  });

  let current = $state.raw<Topic | null>(null);
  let selectedNode = $state<string | null>(null);
  const history = new HelpHistory();
  let historyVersion = $state(0);
  const canBack = $derived.by(() => {
    void historyVersion;
    return history.canBack;
  });
  const canForward = $derived.by(() => {
    void historyVersion;
    return history.canForward;
  });

  /** Compact screens: whether the tree overlay is open. Desktop: whether the tree is shown ("Show Topics"). */
  let treeShown = $state(!compactLayout.current);
  let pageEl: HTMLDivElement | undefined = $state();

  /** `help_browser::show_topic`: shows a topic by its id (or a tree node's `+`/`-` id). */
  function showTopic(id: string, addToHistory = true): void {
    if (!contents) return;
    const topicId = topicIdOfNode(id);
    const topic = findTopic(contents.toplevel, topicId);
    if (!topic) {
      console.error(`[help] Help browser tried to show topic with id '${topicId}' but that topic could not be found.`);
      return;
    }
    if (current !== topic) {
      current = topic;
      pageEl?.scrollTo?.(0, 0);
    }
    const nodeId = nodeIdOfTopic(topic.id);
    const path = ancestorsOf(tree.nodes, nodeId);
    if (path) {
      for (const p of path) unfolded.add(p);
      selectedNode = nodeId;
    }
    if (addToHistory) {
      history.push(topic.id);
      historyVersion++;
    }
  }

  /** The topic a request names: `get_unit_type_help_id` for a unit, `hidden_symbol + terrain_<id>` for a terrain. */
  function requestedTopic(request: HelpRequest): string | null {
    if ('topic' in request) return request.topic;
    if (!world) return null;
    if ('unitType' in request) {
      const type = world.unitType(request.unitType);
      return type ? unitTypeHelpId(world, request.variation ? type.variation(request.variation) : type) : null;
    }
    const terrain = world.terrain(parseTerrainCode(request.terrain));
    return terrain ? hiddenSymbol(terrain.hideHelp) + TERRAIN_PREFIX + terrain.id : null;
  }

  // Each request (`helpBrowser.open...`) goes to its page, once the contents are built.
  let shownSerial = -1;
  $effect(() => {
    const serial = helpBrowser.serial;
    const request = helpBrowser.request;
    if (!contents || request === null || serial === shownSerial) return;
    shownSerial = serial;
    let topic = requestedTopic(request);
    if (topic === null) return;
    // A basic terrain's page is its section's own (`..terrain_flat`), which upstream's lookup misses.
    if (!findTopic(contents.toplevel, topic) && findTopic(contents.toplevel, '..' + topic)) topic = '..' + topic;
    showTopic(topic.startsWith('..') ? '+' + topic.slice(2) : '-' + topic);
  });

  function navigate(back: boolean): void {
    const id = back ? history.back() : history.forward();
    historyVersion++;
    if (id !== undefined) showTopic(id, false);
  }

  function selectNode(node: HelpTreeNode): void {
    if (node.section) unfolded.add(node.id);
    showTopic(node.id);
    if (compactLayout.current) treeShown = false;
  }

  function toggleFold(node: HelpTreeNode): void {
    if (unfolded.has(node.id)) unfolded.delete(node.id);
    else unfolded.add(node.id);
  }

  const page = $derived.by((): { nodes: MarkupNode[]; error: string | null } => {
    if (!current) return { nodes: [], error: null };
    try {
      return { nodes: parseMarkup(topicText(current)).children, error: null };
    } catch (e) {
      if (e instanceof MarkupParseError) return { nodes: [], error: `Error parsing markup in help page with ID: ${current.id}\n${e.message}` };
      throw e;
    }
  });

  function onTreeKey(e: KeyboardEvent): void {
    const nodes = visibleNodes(tree.nodes, unfolded);
    const i = nodes.findIndex((n) => n.id === selectedNode);
    const node = nodes[i];
    const focus = (n: HelpTreeNode | undefined) => {
      if (!n) return;
      showTopic(n.id);
      queueMicrotask(() => document.getElementById(treeItemId(n.id))?.focus());
    };
    if (e.key === 'ArrowDown') focus(nodes[i + 1] ?? nodes[0]);
    else if (e.key === 'ArrowUp') focus(i > 0 ? nodes[i - 1] : nodes[nodes.length - 1]);
    else if (e.key === 'ArrowRight' && node?.section) unfolded.add(node.id);
    else if (e.key === 'ArrowLeft' && node) {
      if (node.section && unfolded.has(node.id)) unfolded.delete(node.id);
      else {
        const path = ancestorsOf(tree.nodes, node.id);
        const parent = path?.[path.length - 1];
        if (parent) focus(nodes.find((n) => n.id === parent));
      }
    } else if (e.key === 'Home') focus(nodes[0]);
    else if (e.key === 'End') focus(nodes[nodes.length - 1]);
    else return;
    e.preventDefault();
  }

  function treeItemId(nodeId: string): string {
    return 'help-node-' + encodeURIComponent(nodeId).replace(/%/g, '_');
  }

  /** The mouse's own back and forward buttons walk the history, as upstream's `BACK_BUTTON_CLICK`/`FORWARD_BUTTON_CLICK`. */
  function onMouseUp(e: MouseEvent): void {
    if (e.button === 3) navigate(true);
    else if (e.button === 4) navigate(false);
    else return;
    e.preventDefault();
  }

  const icon = (name: string) => `${ENGINE_IMAGES}/${name}`;
</script>

{#snippet treeLevel(nodes: HelpTreeNode[], depth: number)}
  {#each nodes as node (node.id)}
    {@const open = node.section && unfolded.has(node.id)}
    <li role="none">
      <div
        id={treeItemId(node.id)}
        class="node"
        class:selected={selectedNode === node.id}
        style:padding-inline-start={`${0.4 + depth * 1.25}rem`}
        role="treeitem"
        aria-selected={selectedNode === node.id}
        aria-expanded={node.section ? open : undefined}
        tabindex={selectedNode === node.id || (selectedNode === null && depth === 0 && node === tree.nodes[0]) ? 0 : -1}
        onclick={() => selectNode(node)}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectNode(node);
          }
        }}
      >
        {#if node.section}
          <button
            class="fold"
            tabindex="-1"
            aria-label={open ? tx('Collapse') : tx('Expand')}
            onclick={(e) => {
              e.stopPropagation();
              toggleFold(node);
            }}><img src={icon(open ? 'help/open_section.png' : 'help/closed_section.png')} alt="" draggable="false" /></button
          >
        {:else}
          <img class="page-icon" src={icon('help/topic.png')} alt="" draggable="false" />
        {/if}
        <span class="node-title" dir="auto">{node.title}</span>
      </div>
      {#if open && node.children.length > 0}
        <ul role="group">{@render treeLevel(node.children, depth + 1)}</ul>
      {/if}
    </li>
  {/each}
{/snippet}

<Modal labelledBy={t('Help')} width="1350px" onClose={() => helpBrowser.close()}>
  <div class="help" class:tree-hidden={!treeShown} class:compact={compactLayout.current} onmouseup={onMouseUp} role="presentation">
    {#if treeShown}
      <nav class="tree-panel" aria-label={tx('Help topics')}>
        <ul class="tree" role="tree" aria-label={tx('Help topics')} onkeydown={onTreeKey}>
          {@render treeLevel(tree.nodes, 0)}
        </ul>
      </nav>
    {/if}
    <div class="main">
      <div class="topbar">
        <h2 class="topic-title" dir="auto">{current?.title ?? ''}</h2>
        <button class="toggle" class:on={treeShown} aria-pressed={treeShown} onclick={() => (treeShown = !treeShown)}>{t('Show Topics')}</button>
        <button class="arrow" disabled={!canBack} aria-label={tw('Back')} onclick={() => navigate(true)}>
          <img src={icon('icons/arrows/long_arrow_ornate_left.png')} alt="" draggable="false" />
        </button>
        <button class="arrow" disabled={!canForward} aria-label={t('Next')} onclick={() => navigate(false)}>
          <img src={icon('icons/arrows/long_arrow_ornate_right.png')} alt="" draggable="false" />
        </button>
        <input
          class="filter"
          type="search"
          placeholder={t('Search')}
          title={t('Search help topic names')}
          aria-label={t('Search help topic names')}
          bind:value={filter}
          oninput={() => {
            if (compactLayout.current) treeShown = true;
          }}
        />
      </div>
      <div class="page" bind:this={pageEl} dir="auto">
        {#if loadError}
          <p class="error">{loadError}</p>
        {:else if !contents}
          <p class="loading">{t('Loading...')}</p>
        {:else if page.error}
          <p class="error">{page.error}</p>
        {:else}
          <HelpNodes nodes={page.nodes} onLink={(dst) => showTopic(dst.startsWith('..') ? '+' + dst.slice(2) : '-' + dst)} {engineImages} />
        {/if}
      </div>
      <div class="footer">
        <button onclick={() => helpBrowser.close()}>{t('Close')}</button>
      </div>
    </div>
  </div>
</Modal>

<style>
  .help {
    display: flex;
    gap: 15px; /* upstream: border_size = 15 between the tree and the page */
    height: min(800px, calc(90vh - 2rem));
    min-height: 0;
    position: relative;
  }
  .tree-panel {
    flex: 0 0 17rem;
    overflow: auto;
    background: rgba(0, 0, 0, 0.35);
    border: 1px solid #2a2f3f;
    border-radius: 3px;
  }
  .tree,
  .tree :global(ul) {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .node {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding-block: 0.3rem;
    padding-inline-end: 0.5rem;
    cursor: pointer;
    color: #e8e3d4;
    border: 1px solid transparent;
    border-radius: 2px;
    white-space: nowrap;
  }
  .node:hover {
    background: rgba(255, 255, 255, 0.05);
  }
  .node.selected {
    border-color: #b8943b;
    background: linear-gradient(90deg, rgba(40, 70, 110, 0.8), rgba(20, 30, 50, 0.4));
  }
  .node:focus-visible {
    outline: 2px solid #e4c860;
    outline-offset: -2px;
  }
  .node-title {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fold {
    all: unset;
    display: inline-flex;
    cursor: pointer;
  }
  .fold img,
  .page-icon {
    width: 24px;
    height: 24px;
    flex: 0 0 auto;
  }
  .main {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px;
    flex: 0 0 auto;
  }
  .topic-title {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
    font-family: var(--font-script);
    font-size: 1.6rem;
    font-weight: 400;
    color: #e8e3d4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  button {
    font: inherit;
    padding: 0.35rem 1rem;
    border-radius: 4px;
    border: 1px solid #8a6a2e;
    background: #1b2233;
    color: #e8e3d4;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .toggle.on {
    background: #2a3a58;
  }
  .arrow {
    padding: 0.1rem 0.4rem;
    background: transparent;
    border-color: transparent;
    line-height: 0;
  }
  .arrow img {
    height: 26px;
  }
  .filter {
    flex: 0 1 14rem;
    min-width: 6rem;
    font: inherit;
    padding: 0.35rem 0.5rem;
    background: #0b0e16;
    border: 1px solid #4a3d1e;
    border-radius: 3px;
    color: #e8e3d4;
  }
  .page {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: 5px 10px 5px 5px;
    white-space: pre-wrap;
    line-height: 1.35;
    color: #dcd6c6;
  }
  .page::after {
    content: '';
    display: block;
    clear: both;
  }
  .footer {
    display: flex;
    justify-content: flex-end;
    padding: 5px;
    flex: 0 0 auto;
  }
  .error {
    color: #ff5555;
    white-space: pre-wrap;
  }
  .loading {
    opacity: 0.7;
  }
  /* A phone: the tree is an overlay over the page, opened by "Show Topics". */
  .help.compact {
    height: 100%;
  }
  .help.compact .tree-panel {
    position: absolute;
    inset: 3.2rem 0 3rem 0;
    z-index: 2;
    background: #0b0e16;
    flex-basis: auto;
  }
  .help.compact .topbar {
    flex-wrap: wrap;
  }
  .help.compact .topic-title {
    flex-basis: 100%;
    font-size: 1.3rem;
  }
  .help.compact .filter {
    flex: 1 1 8rem;
  }
</style>
