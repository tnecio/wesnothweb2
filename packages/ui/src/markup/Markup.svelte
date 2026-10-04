<script lang="ts">
  /**
   * Pango-subset markup (`<i>`, `<b>`, `<small>`, `<span color=...>`) as real elements. See `pango.ts`: the text
   * is parsed to a tree and rendered node by node, never through `{@html}`.
   */
  import { parsePango, type PangoNode } from './pango.js';

  /** `onLink`: a `<ref>` link is clicked (a rich label with a link handler); without it links are only coloured, as upstream's. */
  let { text, help = false, onLink }: { text: string; help?: boolean; onLink?: (dst: string) => void } = $props();

  const nodes = $derived(parsePango(text, help));

  function css(style: Readonly<Record<string, string>>): string {
    return Object.entries(style)
      .map(([k, v]) => `${k}: ${v}`)
      .join('; ');
  }
</script>

{#snippet render(list: readonly PangoNode[])}
  {#each list as node}
    {#if 'text' in node}{node.text}{:else if onLink && node.tag === 'ref' && node.dst !== undefined}<a
        class="ref"
        href={'#' + node.dst}
        style={css(node.style)}
        onclick={(e) => {
          e.preventDefault();
          onLink(node.dst!);
        }}>{@render render(node.children)}</a
      >{:else}<span style={css(node.style)}>{@render render(node.children)}</span>{/if}
  {/each}
{/snippet}

{@render render(nodes)}

<style>
  .ref {
    text-decoration: underline;
    cursor: pointer;
  }
</style>
