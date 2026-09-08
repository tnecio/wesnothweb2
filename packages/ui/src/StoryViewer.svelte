<script lang="ts">
  /**
   * Full-screen click-through sequence for a scenario's `[story][part]`
   * blocks (real narrative text + optional background art) -- shown before
   * interactive play starts. See `GameBoardSnapshot.story`'s doc comment
   * (packages/engine/src/snapshot/gameBoardSnapshot.ts) for where this data
   * comes from; `GameShell.svelte` owns advancing/dismissing this.
   *
   * Addresses the playability feedback "no support for 'story' ... tags".
   */
  import type { StoryPart } from '@wesnothweb2/engine';

  let {
    parts,
    index,
    onNext,
  }: {
    parts: readonly StoryPart[];
    /** Which part is currently shown -- owned by the caller (`GameShell`) so it can decide what happens once the sequence ends. */
    index: number;
    onNext: () => void;
  } = $props();

  const part = $derived(parts[index]);
  const isLast = $derived(index >= parts.length - 1);
</script>

{#if part}
  <div
    class="story-overlay"
    style:background-image={part.image ? `url('/game-images/${part.image}')` : 'none'}
    onclick={onNext}
    onkeydown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') onNext();
    }}
    role="button"
    tabindex="0"
  >
    <div class="scrim"></div>
    <div class="story-content">
      <p class="story-text">{part.text}</p>
      <div class="story-footer">
        <span class="progress">{index + 1} / {parts.length}</span>
        <button class="advance" onclick={(e) => { e.stopPropagation(); onNext(); }}>
          {isLast ? 'Continue' : 'Next'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .story-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    background-color: #000;
    background-size: cover;
    background-position: center;
    cursor: pointer;
    font-family: sans-serif;
  }
  .scrim {
    position: absolute;
    inset: 0;
    background: linear-gradient(to top, rgba(0, 0, 0, 0.88) 0%, rgba(0, 0, 0, 0.35) 45%, rgba(0, 0, 0, 0.05) 100%);
  }
  .story-content {
    position: relative;
    max-width: 44rem;
    width: 90%;
    margin-bottom: 4rem;
    padding: 1rem 1.5rem;
    color: #f1e6c8;
  }
  .story-text {
    white-space: pre-wrap;
    font-size: 1.05rem;
    line-height: 1.5;
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.9);
  }
  .story-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 0.75rem;
  }
  .progress {
    opacity: 0.7;
    font-size: 0.8rem;
  }
  .advance {
    font: inherit;
    padding: 0.4rem 1.1rem;
    border-radius: 4px;
    border: 1px solid #8a6a2e;
    background: #6a4a1e;
    color: #f1e6c8;
    cursor: pointer;
  }
</style>
