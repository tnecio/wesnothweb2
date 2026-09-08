<script lang="ts">
  /**
   * Full-screen click-through sequence for the `[message]` dialogue recorded
   * while running the scenario's real `prestart`/`start` events (see
   * `GameSession.runStartupEvents`/`RecordedMessage`,
   * packages/engine/src/events/context.ts). Shown after the story sequence
   * (or immediately if the scenario has none) and before interactive play
   * begins -- by that point the board already has every event-spawned unit
   * (citizens, Cylanna, Gwabbo, the enemy undead for Dead_Water scenario 1),
   * this is just replaying the dialogue that explained their arrival.
   *
   * Addresses the playability feedback "no support for ... 'message' tags".
   */
  import type { RecordedMessage } from '@wesnothweb2/engine';

  let {
    messages,
    index,
    onNext,
  }: {
    messages: readonly RecordedMessage[];
    index: number;
    onNext: () => void;
  } = $props();

  const msg = $derived(messages[index]);
  const isLast = $derived(index >= messages.length - 1);

  function speakerLabel(speaker: string): string {
    if (!speaker) return 'Narrator';
    if (speaker === 'narrator') return 'Narrator';
    return speaker;
  }
</script>

{#if msg}
  <div
    class="message-overlay"
    onclick={onNext}
    onkeydown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') onNext();
    }}
    role="button"
    tabindex="0"
  >
    <div class="dialogue-box">
      {#if msg.image}
        <img class="portrait" src={`/game-images/${msg.image}`} alt="" />
      {/if}
      <div class="dialogue-text">
        <div class="speaker">{msg.caption || speakerLabel(msg.speaker)}</div>
        <p class="message">{msg.message}</p>
        <div class="dialogue-footer">
          <span class="progress">{index + 1} / {messages.length}</span>
          <button class="advance" onclick={(e) => { e.stopPropagation(); onNext(); }}>
            {isLast ? 'Begin' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .message-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    background: rgba(0, 0, 0, 0.55);
    cursor: pointer;
    font-family: sans-serif;
  }
  .dialogue-box {
    display: flex;
    gap: 1rem;
    max-width: 44rem;
    width: 90%;
    margin-bottom: 3rem;
    padding: 1rem 1.25rem;
    background: #23201a;
    border: 1px solid #4a4432;
    border-radius: 6px;
    color: #ddd;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.6);
  }
  .portrait {
    width: 5rem;
    height: 5rem;
    object-fit: cover;
    border-radius: 4px;
    border: 1px solid #4a4432;
    flex: 0 0 auto;
    background: #111;
  }
  .dialogue-text {
    flex: 1 1 auto;
    min-width: 0;
  }
  .speaker {
    font-weight: 700;
    color: #f1e6c8;
    margin-bottom: 0.3rem;
  }
  .message {
    margin: 0;
    white-space: pre-wrap;
    line-height: 1.4;
  }
  .dialogue-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 0.75rem;
  }
  .progress {
    opacity: 0.6;
    font-size: 0.8rem;
  }
  .advance {
    font: inherit;
    padding: 0.35rem 0.9rem;
    border-radius: 4px;
    border: 1px solid #8a6a2e;
    background: #6a4a1e;
    color: #f1e6c8;
    cursor: pointer;
  }
</style>
