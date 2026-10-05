<script lang="ts">
  /**
   * Phase 25: the statistics dialog (`gui2::dialogs::statistics_dialog`, `statistics_dialog.cfg`, the
   * `statistics` hotkey S and the game menu). For the viewing side: a scenario menu ("All Scenarios", then
   * each scenario played, the current one selected); recruits, recalls, advancements, losses and kills with
   * their counts and gold, the selected row's unit types beside them; damage inflicted and taken against
   * what was expected; hits inflicted and taken against expected, with the a-priori probability of so few
   * (or so many), coloured by how well the side fared. "This Turn" columns show for the current scenario.
   * The figures are `statisticsView.ts`'s.
   */
  import { untrack } from 'svelte';
  import Modal from './Modal.svelte';
  import IpfImage from './images/IpfImage.svelte';
  import { unitImageRef } from './images/unitImageRef.js';
  import { sumCostStrIntMap, sumStrIntMap, type Statistics, type StatsT, type StrIntMap } from '@wesnothweb2/engine';
  import { redToGreen } from '@wesnothweb2/renderer';
  import { damageString, tally, type HitsCell } from './statisticsView.js';
  import { fmt, t } from './i18n/locale.js';

  let {
    statistics,
    saveId,
    side,
    sideName,
    typeInfo,
    onClose,
  }: {
    statistics: Statistics;
    saveId: string;
    side: number;
    sideName: string;
    typeInfo: (typeId: string) => { name: string; image: string | null; cost: number } | undefined;
    onClose: () => void;
  } = $props();

  // Read once, as upstream's constructor does: the dialog shows the statistics as they were when it opened.
  const campaign = untrack(() => statistics.calculateStats(saveId));
  const scenarios = untrack(() => statistics.levelStats(saveId));
  /** 0 is "All Scenarios"; the last entry is the current scenario, selected first. */
  let selection = $state(scenarios.length);
  let current = $derived<StatsT>(selection === 0 ? campaign : scenarios[selection - 1]!.stats);
  let showThisTurn = $derived(selection === scenarios.length);

  type Row = { label: string; map: StrIntMap; hasCost: boolean };
  let rows = $derived<Row[]>([
    { label: t('stats^Recruits'), map: current.recruits, hasCost: true },
    { label: t('Recalls'), map: current.recalls, hasCost: true },
    { label: t('Advancements'), map: current.advancedTo, hasCost: false },
    { label: t('Losses'), map: current.deaths, hasCost: true },
    { label: t('Kills'), map: current.killed, hasCost: true },
  ]);
  let selectedRow = $state(0);

  const costOf = (id: string): number | undefined => typeInfo(id)?.cost;

  let units = $derived(
    [...(rows[selectedRow]?.map ?? new Map<string, number>()).entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([id, count]) => {
        const info = typeInfo(id);
        // `on_primary_list_select`: a type the game does not know is left out.
        return info ? [{ id, count, info }] : [];
      }),
  );

  type Line = { label: string; overall: string; turn: string };
  let damage = $derived<Line[]>([
    { label: t('Inflicted'), overall: damageString(current.damageInflicted, current.expectedDamageInflicted), turn: damageString(current.turnDamageInflicted, current.turnExpectedDamageInflicted) },
    { label: t('Taken'), overall: damageString(current.damageTaken, current.expectedDamageTaken), turn: damageString(current.turnDamageTaken, current.turnExpectedDamageTaken) },
  ]);

  type HitsLine = { label: string; overall: HitsCell; turn: HitsCell };
  let hits = $derived<HitsLine[]>([
    { label: t('Inflicted'), overall: tally(current.byCthInflicted, true), turn: tally(current.turnByCthInflicted, true) },
    { label: t('Taken'), overall: tally(current.byCthTaken, false), turn: tally(current.turnByCthTaken, false) },
  ]);

  const ratioTip = t(
    'stats dialog^Difference of actual outcome to expected outcome, as a percentage.\nThe first number in parentheses is the expected number of hitpoints inflicted/taken.\nThe sum (or difference) of the two numbers in parentheses is the actual number of hitpoints inflicted/taken.',
  );
  const hitsTip = t(
    'stats dialog^Difference of actual outcome to expected outcome, as a percentage.\nThe first number in parentheses is the expected number of hits inflicted/taken.\nThe sum (or difference) of the two numbers in parentheses is the actual number of hits inflicted/taken.',
  );
  const percentTip = t(
    'stats dialog^The <i>a priori</i> probability of inflicting/taking at most this many hits, in percent.\n\nIntuitively, this is a measure of how randomness affected this side.\nValues between 0 and 50 suggest the number of hits was less than expected.\nValues between 50 and 100 suggest the number of hits was more than expected.\n\nGreen values indicate this side fared better than expected.\nRed values indicate this side fared worse than expected.',
  ).replace(/<\/?i>/g, '');

  /** `add_hits_row`'s tooltip: the static explanation, then the actual rate at each chance to hit. */
  function hitsTooltip(cell: HitsCell): string {
    const lines = cell.byCth.length === 0 ? [t('(no attacks have taken place yet)')] : cell.byCth.map((r) => `${r.cth}%: ${r.rate}% (N=${r.strikes})`);
    return `${hitsTip}\n\n${t('Actual hit rates, by chance to hit:')}\n${lines.join('\n')}`;
  }

  /** The title, with the side's name when it has one (`pre_show`). */
  let title = $derived(sideName ? `${t('Statistics')} (${sideName})` : t('Statistics'));

  const css = (rgb: number): string => `#${rgb.toString(16).padStart(6, '0')}`;
  const EM_DASH = '—';
</script>

{#snippet percentile(cell: HitsCell)}
  {#if cell.percentile === null}
    <span>{EM_DASH}</span>
  {:else}
    <span style:color={css(redToGreen((cell.score ?? 0) * 100, true))}>{cell.percentile > 0.9995 ? '100' : (100 * cell.percentile).toFixed(1)}</span>
  {/if}
{/snippet}

<Modal width="52rem" labelledBy={t('Statistics')} {onClose}>
  {#snippet children()}
    <div class="head">
      <div class="title">{title}</div>
      <select bind:value={selection} data-testid="stats-scenario" aria-label={t('Statistics')}>
        <option value={0}>{t('All Scenarios')}</option>
        {#each scenarios as s, i (i)}
          <option value={i + 1}>{s.name}</option>
        {/each}
      </select>
    </div>
    <div class="layout">
      <div class="main">
        <table class="stat-list" data-testid="stats-main">
          <tbody>
            {#each rows as row, i (row.label)}
              <tr class:selected={i === selectedRow} onclick={() => (selectedRow = i)} data-testid={`stats-row-${i}`}>
                <td class="type">{row.label}</td>
                <td class="num">{sumStrIntMap(row.map)}</td>
                <td class="cost">
                  {#if row.hasCost}<IpfImage class="gold" src="themes/gold.png" />{sumCostStrIntMap(row.map, costOf)}{:else}{EM_DASH}{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>

        <table class="figures" data-testid="stats-damage">
          <thead>
            <tr>
              <th>{t('Damage')}</th>
              <th title={ratioTip}>{t('Overall')}</th>
              <th>{showThisTurn ? t('This Turn') : ''}</th>
            </tr>
          </thead>
          <tbody>
            {#each damage as line (line.label)}
              <tr>
                <td>{line.label}</td>
                <td title={ratioTip}>{line.overall}</td>
                <td title={showThisTurn ? ratioTip : undefined}>{showThisTurn ? line.turn : ''}</td>
              </tr>
            {/each}
          </tbody>
        </table>

        <table class="figures" data-testid="stats-hits">
          <thead>
            <tr>
              <th>{t('Hits')}</th>
              <th colspan="2">{t('Overall')}</th>
              <th colspan="2">{showThisTurn ? t('This Turn') : ''}</th>
            </tr>
          </thead>
          <tbody>
            {#each hits as line (line.label)}
              <tr>
                <td>{line.label}</td>
                <td title={hitsTooltip(line.overall)}>{line.overall.hitrate}</td>
                <td class="pct" title={percentTip}>{@render percentile(line.overall)}</td>
                {#if showThisTurn}
                  <td title={hitsTooltip(line.turn)}>{line.turn.hitrate}</td>
                  <td class="pct" title={percentTip}>{@render percentile(line.turn)}</td>
                {:else}
                  <td></td>
                  <td></td>
                {/if}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <ul class="units" data-testid="stats-units">
        {#each units as u (u.id)}
          <li>
            {#if u.info.image}<IpfImage class="unit-image" src={unitImageRef(u.info.image, side)} />{/if}
            <span>{fmt(t('$count|× $name'), { count: u.count, name: u.info.name })}</span>
          </li>
        {/each}
      </ul>
    </div>
    <div class="footer">
      <button class="primary" data-autofocus onclick={onClose}>{t('Close')}</button>
    </div>
  {/snippet}
</Modal>

<style>
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.6rem;
  }
  .title {
    font-size: 1.15rem;
    font-weight: 700;
    color: #e4c860;
  }
  select {
    font: inherit;
    background: #0e1420;
    color: inherit;
    border: 1px solid #4a4432;
    border-radius: 3px;
    padding: 0.2rem 0.4rem;
  }
  .layout {
    display: flex;
    gap: 1rem;
  }
  .main {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
    min-width: 0;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
  }
  th {
    text-align: left;
    font-weight: 700;
    color: #e4c860;
    padding: 0.2rem 0.4rem;
    border-bottom: 1px solid #4a4432;
  }
  td {
    padding: 0.2rem 0.4rem;
    border-bottom: 1px solid #241f1a;
    white-space: nowrap;
  }
  .stat-list tr {
    cursor: pointer;
  }
  .stat-list tr:hover {
    background: #1a2233;
  }
  .stat-list tr.selected {
    background: #35411f;
  }
  .num,
  .cost,
  .pct {
    text-align: right;
  }
  * :global(.gold) {
    width: 14px;
    height: 14px;
    vertical-align: middle;
    margin-right: 0.25rem;
  }
  .units {
    flex: 0 0 14rem;
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 24rem;
    overflow-y: auto;
  }
  .units li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.9rem;
  }
  * :global(.unit-image) {
    width: 36px;
    height: 36px;
    object-fit: contain;
  }
  .footer {
    display: flex;
    justify-content: flex-end;
    margin-top: 0.6rem;
  }
  .footer button {
    font: inherit;
    padding: 0.4rem 1.1rem;
    border-radius: 4px;
    border: 1px solid #4a8ab8;
    background: #2a5a86;
    color: #d7e8f5;
    cursor: pointer;
  }

  @container (max-width: 41rem) {
    .layout {
      flex-direction: column;
    }
    .units {
      flex: 0 0 auto;
    }
  }
</style>
