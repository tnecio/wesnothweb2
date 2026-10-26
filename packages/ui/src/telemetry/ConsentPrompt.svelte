<script lang="ts">
  /**
   * Phase 32: the one-time question on the title screen -- send anonymous gameplay statistics? (user decision:
   * opt-in). Shown only while unanswered, and only by a build that has a statistics server; it never blocks
   * the menu. "Details" lists exactly what is sent. The answer can be changed in Preferences.
   */
  import { tx } from '../i18n/locale.js';
  import { setStatsConsent, statsConsent } from './consent.svelte.js';
  import { statsUrl } from './stats.js';

  const available = statsUrl() !== null;
  let details = $state(false);
</script>

{#if available && statsConsent.value === 'unasked'}
  <aside class="consent" aria-label={tx('Gameplay statistics')} data-testid="stats-consent">
    <p>
      {tx('Help find bugs? With your permission the game sends anonymous statistics about which scenarios are started, won, lost or left unfinished, saves loaded and crashes. No cookies or personal data.')}
    </p>
    {#if details}
      <p class="details" data-testid="stats-consent-details">
        {tx('Each event says which campaign, scenario, difficulty and turn it happened at (a scenario starting or ending also says the combat mode), the game version, your language, whether you play on a phone or a computer, and your browser family. A random ID per campaign playthrough tells retries apart without identifying you. Your IP address, User Agent, or any cookies are not stored. The data is kept for 13 months. You can change your answer at any time in Preferences.')}
      </p>
    {/if}
    <div class="buttons">
      <button class="link" onclick={() => (details = !details)} aria-expanded={details}>{details ? tx('Fewer details') : tx('Details')}</button>
      <span class="spacer"></span>
      <button onclick={() => setStatsConsent('no')} data-testid="stats-consent-no">{tx('No, thanks')}</button>
      <button class="primary" onclick={() => setStatsConsent('yes')} data-testid="stats-consent-yes">{tx('Yes, send statistics')}</button>
    </div>
  </aside>
{/if}

<style>
  /* Top right, over the title art only: the menu and the info panel stay free while it waits for an answer. */
  .consent {
    position: absolute;
    top: 3.6rem;
    right: 1rem;
    z-index: 5;
    width: min(27rem, calc(100% - 2rem));
    box-sizing: border-box;
    padding: 0.8rem 1rem;
    background: rgb(10, 13, 21);
    border: 1px solid #8a6a2e;
    border-radius: 6px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.6);
    color: #e6dcae;
    font-size: 0.9rem;
  }
  p {
    margin: 0 0 0.6rem;
    line-height: 1.4;
  }
  .details {
    opacity: 0.85;
    font-size: 0.85rem;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .spacer {
    flex: 1 1 auto;
  }
  button {
    font: inherit;
    padding: 0.35rem 0.9rem;
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
  button.link {
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    text-decoration: underline;
  }
  @media (pointer: coarse) {
    button:not(.link) {
      min-height: 44px;
    }
  }
  /* A phone: the menu is at the top, so the question waits at the bottom, over the info text, above the footer. */
  @media (max-width: 720px) {
    .consent {
      top: auto;
      bottom: 4.5rem;
      left: 1rem;
      right: 1rem;
      width: auto;
    }
  }
</style>
