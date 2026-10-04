<script lang="ts">
  /**
   * Pango-subset markup (`<i>`, `<b>`, `<small>`, `<span color=...>`) as real elements. See `pango.ts`: the text
   * is parsed to a tree and rendered node by node, never through `{@html}`.
   */
  import { parsePango, type PangoNode } from './pango.js';

  let { text, help = false }: { text: string; help?: boolean } = $props();

  const nodes = $derived(parsePango(text, help));

  function css(style: Readonly<Record<string, string>>): string {
    return Object.entries(style)
      .map(([k, v]) => `${k}: ${v}`)
      .join('; ');
  }
</script>

{#snippet render(list: readonly PangoNode[])}
  {#each list as node}
    {#if 'text' in node}{node.text}{:else}<span style={css(node.style)}>{@render render(node.children)}</span>{/if}
  {/each}
{/snippet}

{@render render(nodes)}
