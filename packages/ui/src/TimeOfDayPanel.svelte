<script lang="ts">
  /**
   * The sidebar's time of day, under the minimap (`data/themes/default.cfg`'s `[time_of_day] id=image-tod` and
   * `id=tod-stats`; `reports.cpp`'s `time_of_day_at` and `tod_stats_at`): the time of day's picture at the hex
   * under the pointer (else the selected hex, else the global one), and its place in the schedule there
   * ("2/6"). Their tooltips are upstream's: the bonus for each alignment, and the schedule with the current
   * time in bold.
   *
   * Upstream also blits `game_config::images::tod_bright`/`tod_dark` over the picture where illumination changes
   * the bonus, but 1.19's data has neither image, so nothing is drawn for it there or here.
   */
  import IpfImage from './images/IpfImage.svelte';
  import type { TimeOfDayReport } from './gameSession.js';
  import { tw } from './i18n/locale.js';

  let { report }: { report: TimeOfDayReport } = $props();

  /** `utils::signed_percent`. */
  const signedPercent = (n: number): string => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}%`;

  const liminal = $derived(report.maxLiminalBonus - Math.abs(report.tod.lawfulBonus));
  const todTooltip = $derived(
    [
      `${tw('Time of day:')} ${report.tod.name}`,
      `${tw('Lawful units:')} ${signedPercent(report.tod.lawfulBonus)}`,
      `${tw('Neutral units:')} ${signedPercent(0)}`,
      `${tw('Chaotic units:')} ${signedPercent(-report.tod.lawfulBonus)}`,
      `${tw('Liminal units:')} ${signedPercent(liminal)}`,
    ].join('\n'),
  );
  /** A tooltip is plain text: the current time is marked with a pointer instead of upstream's big bold. */
  const scheduleTooltip = $derived([`${tw('Time of day schedule:')}`, ...report.times.map((t, i) => (i === report.current ? `▶ ${t.name}` : `   ${t.name}`))].join('\n'));
</script>

<div class="tod-panel" data-testid="tod-panel">
  <span class="tod-image" title={todTooltip}>
    {#if report.tod.image}<IpfImage src={report.tod.image} alt={report.tod.name} width={125} height={39} />{/if}
  </span>
  <span class="tod-stats" title={scheduleTooltip}>{report.current + 1}/{report.times.length}</span>
</div>

<style>
  .tod-panel {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .tod-image {
    display: inline-flex;
    width: 125px;
    height: 39px;
    flex: none;
  }
  .tod-stats {
    font-size: 0.85rem;
    color: #f1e6c8;
    font-variant-numeric: tabular-nums;
  }
</style>
