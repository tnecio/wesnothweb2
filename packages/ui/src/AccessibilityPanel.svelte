<script lang="ts">
  /**
   * Accessibility preferences (Phase 20): the font scale (upstream's 80-150 % `font_scaling`) and the three
   * orb colours (`unmoved`/`partial`/`moved_orb_color`). Changes apply at once so the effect can be seen
   * while it is chosen. Shown in the Preferences dialog's Display tab.
   */
  import { ORB_COLOR_CHOICES } from './accessibilityColors.js';
  import { accessibility, FONT_SCALE_MAX, FONT_SCALE_MIN, FONT_SCALE_STEP, type OrbStatus } from './accessibility.js';
  import { fmt, tx } from './i18n/locale.js';

  const orbRows: ReadonlyArray<{ status: OrbStatus; label: () => string }> = [
    { status: 'unmoved', label: () => tx('Orb: can still move and attack') },
    { status: 'partial', label: () => tx('Orb: partly used') },
    { status: 'moved', label: () => tx('Orb: nothing left to do') },
  ];

  let settings = $derived(accessibility.current);
</script>

<label class="row scale">
  <span class="label">{tx('Font size')}</span>
  <input
    type="range"
    min={FONT_SCALE_MIN}
    max={FONT_SCALE_MAX}
    step={FONT_SCALE_STEP}
    value={settings.fontScale}
    data-testid="font-scale"
    aria-valuetext={fmt(tx('$percent|%'), { percent: settings.fontScale })}
    oninput={(e) => accessibility.update({ fontScale: Number(e.currentTarget.value) })}
  />
  <output>{fmt(tx('$percent|%'), { percent: settings.fontScale })}</output>
</label>

<p class="hint">{tx('Units show an orb that says whether they can still act. Pick colours you can tell apart.')}</p>
{#each orbRows as row (row.status)}
  <label class="row">
    <span class="label">{row.label()}</span>
    <span class="swatch" style:background={ORB_COLOR_CHOICES.find((c) => c.id === settings.orbColors[row.status])?.css ?? 'transparent'} aria-hidden="true"></span>
    <select
      value={settings.orbColors[row.status]}
      data-testid={`orb-${row.status}`}
      onchange={(e) => accessibility.update({ orbColors: { [row.status]: e.currentTarget.value } })}
    >
      {#each ORB_COLOR_CHOICES as choice (choice.id)}
        <option value={choice.id} selected={choice.id === settings.orbColors[row.status]}>{choice.name()}</option>
      {/each}
    </select>
  </label>
{/each}


<style>
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 12rem);
    align-items: center;
    gap: 0.6rem;
    margin: 0.5rem 0;
  }
  .row .label {
    grid-column: 1;
  }
  .row.scale {
    grid-template-columns: minmax(0, 1fr) minmax(0, 12rem) 3.5rem;
  }
  input[type='range'] {
    grid-column: 2;
    width: 100%;
  }
  output {
    grid-column: 3;
    font-variant-numeric: tabular-nums;
    text-align: end;
  }
  .swatch {
    width: 1.1rem;
    height: 1.1rem;
    border-radius: 50%;
    border: 1px solid #888;
  }
  select {
    font: inherit;
    padding: 0.2rem 0.3rem;
    background: #14203a;
    color: #d7e8f5;
    border: 1px solid #2f5a7a;
    border-radius: 4px;
  }
  .hint {
    margin: 0.9rem 0 0.2rem;
    opacity: 0.8;
    font-size: 0.9em;
  }
</style>
