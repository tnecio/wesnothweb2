/**
 * Some upstream WebP portraits (Heir to the Throne's young and chainmail Konrad, seven of The Deceiver's Gambit's)
 * carry transparency in their lossless image data (`VP8L`, its `alpha_is_used` bit) while their extended header
 * (`VP8X`) says there is none. libwebp -- what upstream decodes with -- reads the image data and shows them right;
 * Firefox believes the header and shows the transparent pixels' colours (real, reported bug: Konrad's portrait on
 * a white and black block). The upstream files stay as they are (`check-upstream-unmodified.mjs`); the copy that
 * is served gets the header's alpha flag set, which changes nothing a decoder that reads the image data sees.
 *
 * Used by `upload-game-data.mjs` (production media) and the Vite dev server (`vite.config.ts`).
 */

/** The VP8X header's alpha flag (`L`, bit 4 of the flags byte). */
const VP8X_ALPHA = 0x10;

/** Whether `bytes` is a WebP whose header hides the transparency its image data has. */
export function webpHidesAlpha(bytes) {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP' || ascii(bytes, 12, 4) !== 'VP8X') return false;
  if (bytes[20] & VP8X_ALPHA) return false;
  for (let i = 12; i + 8 <= bytes.length; ) {
    const tag = ascii(bytes, i, 4);
    const size = bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24);
    if (tag === 'ALPH') return true;
    // VP8L: a 0x2f signature, then 14 bits width-1, 14 bits height-1, and the alpha_is_used bit.
    if (tag === 'VP8L' && i + 13 <= bytes.length && bytes[i + 8] === 0x2f) {
      const bits = bytes[i + 9] | (bytes[i + 10] << 8) | (bytes[i + 11] << 16) | (bytes[i + 12] << 24);
      return ((bits >>> 28) & 1) === 1;
    }
    if (size < 0) return false;
    i += 8 + size + (size & 1);
  }
  return false;
}

/** `bytes`, or a copy with the header's alpha flag set when it hides the transparency (see the module comment). */
export function fixWebpAlphaFlag(bytes) {
  if (!webpHidesAlpha(bytes)) return bytes;
  const fixed = Buffer.from(bytes);
  fixed[20] |= VP8X_ALPHA;
  return fixed;
}

function ascii(bytes, start, length) {
  let s = '';
  for (let i = start; i < start + length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
