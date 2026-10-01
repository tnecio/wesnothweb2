<script lang="ts" module>
  /** One overlay label on screen (`[print]`, `wesnoth.interface.add_overlay_text`). */
  export interface OverlayLabelView {
    readonly id: number;
    /** Pango markup (`floating_label`'s `use_markup_`). */
    readonly text: string;
    readonly size: number;
    /** CSS colours. */
    readonly color: string;
    readonly background: string | null;
    readonly halign: 'left' | 'center' | 'right';
    readonly valign: 'top' | 'center' | 'bottom';
    readonly x: number;
    readonly y: number;
    readonly maxWidth?: { readonly px: number } | { readonly ratio: number };
    /** Fading out over this many ms (the label's lifetime is over); null while shown in full. */
    readonly fadingMs: number | null;
  }
</script>

<script lang="ts">
  /**
   * C1: the labels WML and Lua put over the map area (`game_lua_kernel::intf_set_floating_label`), placed as
   * upstream places them: from the map area's left, centre or right edge and top, middle or bottom, offset
   * by `location=`; as wide as the map area allows (or `max_width=`); outlined when they have no background.
   */
  import Markup from './markup/Markup.svelte';

  let {
    labels,
    getMapRect,
    layoutTick = 0,
  }: { labels: readonly OverlayLabelView[]; getMapRect: () => DOMRect | null; layoutTick?: number } = $props();

  const area = $derived.by(() => {
    void layoutTick;
    void labels;
    return getMapRect();
  });

  function placement(label: OverlayLabelView, rect: DOMRect): string {
    const width = label.maxWidth
      ? 'px' in label.maxWidth
        ? Math.min(label.maxWidth.px, rect.width - label.x)
        : Math.round(rect.width * label.maxWidth.ratio)
      : rect.width - label.x;
    const left =
      label.halign === 'left' ? rect.left + label.x : label.halign === 'right' ? rect.right - label.x : rect.left + rect.width / 2 + label.x;
    // The size * 1.5 at the bottom keeps the text from being cut off, as upstream's.
    const top =
      label.valign === 'top' ? rect.top + label.y : label.valign === 'bottom' ? rect.bottom - label.y - label.size * 1.5 : rect.top + rect.height / 2 + label.y;
    const shift = label.halign === 'center' ? '-50%' : label.halign === 'right' ? '-100%' : '0';
    return [
      `left:${left}px`,
      `top:${top}px`,
      `max-width:${Math.max(0, width)}px`,
      `transform:translateX(${shift})`,
      `font-size:${label.size}px`,
      `color:${label.color}`,
      `text-align:${label.halign}`,
      label.background ? `background:${label.background}` : '',
      label.fadingMs !== null ? `opacity:0;transition:opacity ${label.fadingMs}ms linear` : '',
    ]
      .filter(Boolean)
      .join(';');
  }
</script>

{#if area}
  {#each labels as label (label.id)}
    <div class="overlay-label" class:outlined={!label.background} style={placement(label, area)} data-testid="overlay-label">
      <Markup text={label.text} />
    </div>
  {/each}
{/if}

<style>
  .overlay-label {
    position: fixed;
    z-index: 40;
    pointer-events: none;
    white-space: pre-wrap;
    line-height: 1.2;
  }
  .outlined {
    text-shadow:
      -1px -1px 0 #000,
      1px -1px 0 #000,
      -1px 1px 0 #000,
      1px 1px 0 #000;
  }
</style>
