/**
 * Phase 27c S1: the image path functions against the C++ engine's own output. `fixtures/image-oracle/` holds
 * what `wl-image-oracle --type unscaled` (upstream's `image::get_surface`, see `packages/oracle-tools`) gives
 * for each reference in `refs.txt`; this resolves the same references with `resolveRaster` (the compositor's
 * pixel code) from the same PNGs and compares every pixel.
 *
 * Regenerate after changing `refs.txt`:
 *   wesnoth/build-oracle/wl-image-oracle --data wesnoth/data --out packages/renderer/fixtures/image-oracle \
 *     --type unscaled < packages/renderer/fixtures/image-oracle/refs.txt
 *
 * The oracle loads no `[color_palette]`/`[color_range]` data, so recolouring is covered with `~PAL`'s
 * hex-list form; the named forms (`~TC`, `~RC`) have the image goldens.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'
import { resolveRaster } from '../src/images/modifications'
import type { Raster } from '../src/images/surfaceOps'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '../fixtures/image-oracle')
const images = join(here, '../../../wesnoth/data/core/images')

function readPng(file: string): Raster {
  const png = PNG.sync.read(readFileSync(file))
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) }
}

const load = async (path: string): Promise<Raster | null> => {
  try {
    return readPng(join(images, path))
  } catch {
    return null
  }
}

const ctx = { tcMapping: () => null, rcMapping: () => null, palette: () => undefined }

const rows = readFileSync(join(fixtures, 'manifest.tsv'), 'utf8')
  .trim()
  .split('\n')
  .slice(1)
  .map((line) => {
    const [, status, , , file, ref] = line.split('\t')
    return { status: status!, file: file!, ref: ref! }
  })

/** How far apart two rasters are: pixels that differ at all, and the largest channel difference. */
function compare(a: Raster, b: Raster): { differing: number; maxDiff: number } {
  let differing = 0
  let maxDiff = 0
  for (let i = 0; i < a.data.length; i += 4) {
    let d = 0
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a.data[i + c]! - b.data[i + c]!))
    if (d > 0) differing++
    maxDiff = Math.max(maxDiff, d)
  }
  return { differing, maxDiff }
}

describe('image path functions against wl-image-oracle', () => {
  for (const row of rows) {
    it(row.ref, async () => {
      expect(row.status).toBe('OK')
      const expected = readPng(join(fixtures, row.file))
      const actual = await resolveRaster(row.ref, load, ctx)
      expect(actual).not.toBeNull()
      expect([actual!.width, actual!.height]).toEqual([expected.width, expected.height])
      expect(compare(actual!, expected)).toEqual({ differing: 0, maxDiff: 0 })
    })
  }
})
