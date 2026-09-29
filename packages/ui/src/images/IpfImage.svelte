<script lang="ts">
  /** An image reference with path functions (see `ipfImage.ts`), shown once built. Decorative unless `alt` is given. */
  import { ipfImageUrl } from './ipfImage.js';

  let {
    src,
    alt = '',
    width = undefined,
    height = undefined,
    class: className = undefined,
  }: { src: string | undefined; alt?: string; width?: number; height?: number; class?: string } = $props();

  let url = $state<string | null>(null);
  $effect(() => {
    let cancelled = false;
    url = null;
    if (src) {
      void ipfImageUrl(src).then((u) => {
        if (!cancelled) url = u;
      });
    }
    return () => {
      cancelled = true;
    };
  });
</script>

{#if url}
  <img class={className} src={url} {alt} {width} {height} draggable="false" />
{:else}
  <span class="placeholder {className ?? ''}" style:width={width ? `${width}px` : undefined} style:height={height ? `${height}px` : undefined} aria-hidden="true"></span>
{/if}

<style>
  .placeholder {
    display: inline-block;
  }
</style>
