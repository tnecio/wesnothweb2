/**
 * A unit image as the dialogs and the side panel show it: team-coloured like the unit on the board
 * (upstream recolours with `~RC(<flag_rgb>><side colour>)`; flag_rgb is magenta for every shipped type),
 * and drawn through `IpfImage` so the path functions many unit images carry (`~BLIT(...)` layers) work.
 *
 * The running game registers how to find a side's colour; without one the image is left uncoloured.
 */
let sideColorId: ((side: number | undefined) => string) | null = null;

/** Registers (or clears) the side -> colour range id lookup; `undefined` asks for the side whose turn it is. */
export function setSideColorResolver(resolver: ((side: number | undefined) => string) | null): void {
  sideColorId = resolver;
}

/** `image` recoloured for `side` (default: the side whose turn it is). */
export function unitImageRef(image: string, side?: number): string {
  const id = sideColorId?.(side);
  return id ? `${image}~RC(magenta>${id})` : image;
}
