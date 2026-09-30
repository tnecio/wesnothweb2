<script lang="ts">
  /**
   * One level of a help page's parsed markup (see `markup.ts`), laid out as GUI2's `rich_label` lays it out
   * (`rich_label::get_parsed_text`): text runs in a row are paragraphs; `<img float=yes>` floats, other images
   * sit in the line; `<clear/>` ends the floats; `<ref>` is a link; `<table>` rows take the theme's
   * `table_header`/`table_row1`/`table_row2` colours. Nothing is handed to `{@html}`.
   */
  import IpfImage from '../images/IpfImage.svelte';
  import HelpNodes from './HelpNodes.svelte';
  import { helpImageRef } from './helpImages.js';
  import type { MarkupNode } from './markup.js';

  let {
    nodes,
    onLink,
    engineImages,
  }: {
    nodes: readonly MarkupNode[];
    onLink: (dst: string) => void;
    engineImages: ReadonlySet<string>;
  } = $props();

  /** Each node, and whether a paragraph break comes before it: a text run right after another one (upstream adds "\n\n"). */
  const items = $derived.by(() => {
    let prevText = false;
    return nodes.map((node) => {
      const breakBefore = prevText && node.tag === 'text';
      prevText = node.tag === 'text';
      return { node, breakBefore };
    });
  });

  // In variables: a newline written into the template would be collapsed as whitespace.
  const PARAGRAPH_BREAK = '\n\n';
  const LINE_BREAK = '\n';

  const FORMAT: Record<string, string> = { b: 'b', bold: 'b', i: 'i', italic: 'i', u: 'u', underline: 'u' };

  /** A `<span>`/`<format>`'s Pango attributes as CSS. */
  function spanStyle(attrs: Record<string, string>): string {
    const css: string[] = [];
    if (attrs.color) css.push(`color: ${cssColor(attrs.color)}`);
    const size = attrs.font_size ?? attrs.size;
    if (size && /^\d+$/.test(size)) css.push(`font-size: ${Number(size) / 17}em`);
    if (attrs.face) css.push(`font-family: ${attrs.face}`);
    if (attrs.bold === 'yes' || attrs.bold === 'true' || attrs.weight === 'bold') css.push('font-weight: 700');
    if (attrs.italic === 'yes' || attrs.italic === 'true' || attrs.style === 'italic') css.push('font-style: italic');
    return css.join('; ');
  }

  /** Colours as Pango takes them: a name, `#rrggbb`, or a hex string without the `#`. */
  function cssColor(c: string): string {
    if (/^[0-9a-fA-F]{6}$/.test(c)) return `#${c}`;
    return /^#?[0-9a-zA-Z]+$/.test(c) ? c : 'inherit';
  }

  function imgClass(attrs: Record<string, string>): string {
    const floating = attrs.float === 'true' || attrs.float === 'yes';
    const align = attrs.align ?? 'left';
    if (!floating) return 'inline';
    if (align === 'right') return 'float-right';
    if (align === 'center' || align === 'middle') return 'center';
    return 'float-left';
  }
</script>

<!-- No whitespace between the two blocks in the loop: the page is laid out with `white-space: pre-wrap`. -->
{#each items as { node, breakBefore }, i (i)}
  {#if breakBefore}{PARAGRAPH_BREAK}{/if}{#if node.tag === 'text'}
    {node.attrs.text ?? ''}
  {:else if FORMAT[node.tag]}
    <svelte:element this={FORMAT[node.tag]!}>{node.attrs.text ?? ''}<HelpNodes nodes={node.children} {onLink} {engineImages} /></svelte:element>
  {:else if node.tag === 'span' || node.tag === 'format'}
    <span style={spanStyle(node.attrs)}>{node.attrs.text ?? ''}<HelpNodes nodes={node.children} {onLink} {engineImages} /></span>
  {:else if node.tag === 'header' || node.tag === 'h'}
    <span class="header">{node.attrs.text ?? ''}<HelpNodes nodes={node.children} {onLink} {engineImages} /></span>
  {:else if node.tag === 'ref'}
    <a
      class="link"
      href={'#' + (node.attrs.dst ?? '')}
      onclick={(e) => {
        e.preventDefault();
        onLink(node.attrs.dst ?? '');
      }}>{node.attrs.text ?? ''}<HelpNodes nodes={node.children} {onLink} {engineImages} /></a
    >
  {:else if node.tag === 'img'}
    <IpfImage class={'help-img ' + imgClass(node.attrs)} src={helpImageRef(node.attrs.src ?? '', engineImages)} />
  {:else if node.tag === 'clear'}
    <span class="clear"></span>
  {:else if node.tag === 'br' || node.tag === 'break'}
    {LINE_BREAK}
  {:else if node.tag === 'jump'}
    <span class="jump" style:width={node.attrs.amount ? `${Number(node.attrs.amount)}px` : undefined}></span>
  {:else if node.tag === 'character_entity'}
    <span class="entity">&amp;{node.attrs.name};</span>
  {:else if node.tag === 'table'}
    <table class="help-table">
      <tbody>
        {#each node.children.filter((r) => r.tag === 'row') as row, r (r)}
          <tr class={row.attrs.bgcolor ?? ''}>
            {#each row.children.filter((c) => c.tag === 'col') as col, c (c)}
              <td>{col.attrs.text ?? ''}<HelpNodes nodes={col.children} {onLink} {engineImages} /></td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    {node.attrs.text ?? ''}<HelpNodes nodes={node.children} {onLink} {engineImages} />
  {/if}
{/each}

<style>
  .header {
    font-weight: 800;
    color: #fff;
    font-size: 1.18em; /* upstream: SIZE_TITLE - 2 = 20 pt against the 17 pt text */
  }
  .link {
    color: #ffe100; /* rich_label's link_color */
    text-decoration: none;
    cursor: pointer;
  }
  .link:hover,
  .link:focus-visible {
    text-decoration: underline;
  }
  :global(.help-img.inline) {
    vertical-align: middle;
  }
  :global(.help-img.float-left) {
    float: left;
    margin: 0 0.6rem 0.4rem 0;
  }
  :global(.help-img.float-right) {
    float: right;
    margin: 0 0 0.4rem 0.6rem;
    max-width: 45%;
    height: auto;
  }
  :global(.help-img.center) {
    display: block;
    margin: 0 auto 0.4rem;
    max-width: 100%;
    height: auto;
  }
  .clear {
    display: block;
    clear: both;
  }
  .jump {
    display: inline-block;
  }
  .entity {
    font-family: var(--font-mono, monospace);
    color: red;
  }
  .help-table {
    border-collapse: collapse;
    white-space: normal;
    margin: 0.4rem 0;
  }
  .help-table td {
    padding: 0.3rem 0.8rem;
    vertical-align: middle;
    white-space: pre-wrap;
  }
  .table_header {
    background: rgb(51, 55, 79);
  }
  .table_row1 {
    background: rgb(26, 31, 51);
  }
  .table_row2 {
    background: rgb(35, 40, 66);
  }
</style>
