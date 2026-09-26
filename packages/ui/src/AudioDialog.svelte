<script lang="ts">
  /**
   * Audio settings: the four categories upstream's preferences have (music,
   * sound effects, UI sounds, turn bell), each with an on/off switch and a
   * volume, plus a mute switch and "stop music in background". Changes apply
   * at once, so the volumes can be heard while dragging; the full
   * preferences screen comes with Phase 24.
   */
  import Modal from './Modal.svelte';
  import type { AudioSettings } from './audio/settings.js';

  let {
    settings,
    onChange,
    onClose,
  }: {
    settings: Readonly<AudioSettings>;
    onChange: (patch: Partial<AudioSettings>) => void;
    onClose: () => void;
  } = $props();

  const rows = [
    { label: 'Music', on: 'musicOn', volume: 'musicVolume' },
    { label: 'Sound effects', on: 'soundOn', volume: 'soundVolume' },
    { label: 'User interface', on: 'uiOn', volume: 'uiVolume' },
    { label: 'Turn bell', on: 'bellOn', volume: 'bellVolume' },
  ] as const;
</script>

<Modal title="Audio" onClose={onClose} width="26rem">
  {#snippet children()}
    <label class="mute">
      <input type="checkbox" checked={settings.muted} onchange={(e) => onChange({ muted: e.currentTarget.checked })} data-testid="audio-mute" />
      <span>Mute everything</span>
    </label>
    <ul>
      {#each rows as row (row.on)}
        <li>
          <label class="on">
            <input type="checkbox" checked={settings[row.on]} onchange={(e) => onChange({ [row.on]: e.currentTarget.checked })} />
            <span>{row.label}</span>
          </label>
          <input
            class="volume"
            type="range"
            min="0"
            max="100"
            step="1"
            value={settings[row.volume]}
            aria-label={`${row.label} volume`}
            oninput={(e) => onChange({ [row.volume]: Number(e.currentTarget.value) })}
          />
          <span class="percent">{settings[row.volume]}%</span>
        </li>
      {/each}
    </ul>
    <label class="mute">
      <input type="checkbox" checked={settings.stopInBackground} onchange={(e) => onChange({ stopInBackground: e.currentTarget.checked })} />
      <span>Pause the music while the window is hidden</span>
    </label>
    <div class="footer">
      <div class="spacer"></div>
      <!-- svelte-ignore a11y_autofocus -- the only action -->
      <button class="primary" data-autofocus autofocus onclick={onClose}>Close</button>
    </div>
  {/snippet}
</Modal>

<style>
  ul {
    list-style: none;
    margin: 0.7rem 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }
  li {
    display: grid;
    grid-template-columns: 9rem 1fr 3rem;
    align-items: center;
    gap: 0.6rem;
  }
  .on,
  .mute {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }
  .volume {
    width: 100%;
  }
  .percent {
    text-align: right;
    font-variant-numeric: tabular-nums;
    opacity: 0.8;
  }
  .footer {
    display: flex;
    margin-top: 0.9rem;
  }
  .spacer {
    flex: 1 1 auto;
  }
  button {
    font: inherit;
    padding: 0.4rem 1.1rem;
    border-radius: 4px;
    border: 1px solid #2f5a7a;
    background: #1a3350;
    color: #d7e8f5;
    cursor: pointer;
  }
  button.primary {
    background: #2a5a86;
    border-color: #4a8ab8;
  }
</style>
