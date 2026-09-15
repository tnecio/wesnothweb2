/**
 * Phase 28a P5: builds each scenario's terrain image bundle.
 *
 *   npm run build:atlases --workspace=apps/web        (runs before `dev` and `build`)
 *   tsx apps/web/scripts/build-image-atlases.mjs [--force] [scenarioId ...]
 *
 * For every snapshot in `public/scenarios/`: runs the real terrain layout
 * (`packages/renderer/src/terrain/terrainLayout.ts`) against the served
 * `[terrain_graphics]` rules, expands every image ref into the source files
 * the compositor fetches (the ref's own file, images named by `~MASK`/`~BLIT`
 * arguments, recursively, and the hex alpha mask for `~HEXED`), decodes those
 * PNGs with pngjs and packs them losslessly into bundle images of at most
 * 4096x4096 (RGBA PNG, no gamma/colour-profile chunks). Output, gitignored:
 *
 *   public/atlases/<scenarioId>/terrain.json          manifest
 *   public/atlases/<scenarioId>/terrain-<n>.<hash>.png content-hashed bundles
 *
 * The manifest maps each rooted image path (`rootedImagePath`, the same key
 * the runtime computes) to [bundle index, x, y, width, height]. Bundles are
 * only a cache: anything missing -- non-PNG sources, images changed at
 * runtime by WML/Lua, unit sprites -- is fetched on its own at runtime.
 *
 * Incremental: a scenario is skipped when its manifest is newer than its
 * snapshot, the rules file and this script (use --force to rebuild).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { layoutTerrain } from '../../../packages/renderer/src/terrain/terrainLayout.ts';
import { reviveBuildingRules } from '../../../packages/renderer/src/terrain/terrainGraphicsRules.ts';
import { parseIpf, splitRef } from '../../../packages/renderer/src/images/ipf.ts';
import { HEX_MASK, rootedImagePath } from '../../../packages/renderer/src/images/compositor.ts';

const scriptFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptFile), '../../..');
const publicDir = path.join(repoRoot, 'apps/web/public');
const scenariosDir = path.join(publicDir, 'scenarios');
const rulesFile = path.join(publicDir, 'terrain-graphics-rules.json');
const outRoot = path.join(publicDir, 'atlases');
const dataRoot = path.join(repoRoot, 'wesnoth/data');
const engineImagesRoot = path.join(repoRoot, 'wesnoth/images');

/** Largest bundle image edge; sources bigger than this stay per-file. */
const MAX_ATLAS_SIZE = 4096;

const args = process.argv.slice(2);
const force = args.includes('--force');
const onlyIds = new Set(args.filter((a) => !a.startsWith('--')));

/** Where a rooted image path lives on disk. */
function diskPath(rooted) {
  return rooted.startsWith('engine/') ? path.join(engineImagesRoot, rooted.slice('engine/'.length)) : path.join(dataRoot, rooted);
}

/** Every source file a ref makes the compositor fetch (mirrors `Compositor.render`/`applyOp`). */
function collectSources(ref, out) {
  const { path: imagePath, mods } = splitRef(ref);
  out.add(rootedImagePath(imagePath));
  for (const op of parseIpf(mods)) {
    if ((op.name === 'MASK' || op.name === 'BLIT') && op.args[0]) collectSources(op.args[0], out);
    if (op.name === 'HEXED') out.add(rootedImagePath(HEX_MASK));
  }
}

/** Decoded PNGs shared across scenarios: rooted path -> { width, height, data } | null. */
const decoded = new Map();
function decode(rooted) {
  if (decoded.has(rooted)) return decoded.get(rooted);
  let image = null;
  const file = diskPath(rooted);
  if (rooted.toLowerCase().endsWith('.png') && fs.existsSync(file)) {
    try {
      const png = PNG.sync.read(fs.readFileSync(file));
      image = { width: png.width, height: png.height, data: png.data };
    } catch (err) {
      console.warn(`  cannot decode ${rooted}: ${err.message}`);
    }
  }
  decoded.set(rooted, image);
  return image;
}

/** Shelf packing, tallest first; returns bundles of placed images. */
function pack(images) {
  const sorted = [...images].sort((a, b) => b.image.height - a.image.height || b.image.width - a.image.width || a.rooted.localeCompare(b.rooted));
  const atlases = [];
  let current = null;
  const newAtlas = () => {
    current = { placements: [], width: 0, height: 0, shelfX: 0, shelfY: 0, shelfHeight: 0 };
    atlases.push(current);
  };
  for (const entry of sorted) {
    const { width, height } = entry.image;
    if (!current) newAtlas();
    if (current.shelfX + width > MAX_ATLAS_SIZE) {
      current.shelfY += current.shelfHeight;
      current.shelfX = 0;
      current.shelfHeight = 0;
    }
    if (current.shelfY + height > MAX_ATLAS_SIZE) {
      newAtlas();
    }
    current.placements.push({ ...entry, x: current.shelfX, y: current.shelfY });
    current.shelfX += width;
    current.shelfHeight = Math.max(current.shelfHeight, height);
    current.width = Math.max(current.width, current.shelfX);
    current.height = Math.max(current.height, current.shelfY + current.shelfHeight);
  }
  return atlases;
}

function encodeAtlas(atlas) {
  const png = new PNG({ width: atlas.width, height: atlas.height, colorType: 6, inputColorType: 6, bitDepth: 8 });
  png.data.fill(0);
  for (const { image, x, y } of atlas.placements) {
    for (let row = 0; row < image.height; row++) {
      const src = row * image.width * 4;
      image.data.copy(png.data, (y + row) * atlas.width * 4 + x * 4, src, src + image.width * 4);
    }
  }
  return PNG.sync.write(png, { colorType: 6, inputColorType: 6, bitDepth: 8 });
}

function upToDate(manifestFile, inputs) {
  if (force || !fs.existsSync(manifestFile)) return false;
  const built = fs.statSync(manifestFile).mtimeMs;
  return inputs.every((f) => fs.existsSync(f) && fs.statSync(f).mtimeMs <= built);
}

if (!fs.existsSync(rulesFile)) {
  console.warn(`build-image-atlases: ${path.relative(repoRoot, rulesFile)} is missing; no terrain bundles built (the game falls back to per-file images).`);
  process.exit(0);
}

let rules = null;
const summary = [];
for (const file of fs.readdirSync(scenariosDir).sort()) {
  if (!file.endsWith('.json')) continue;
  const id = file.slice(0, -'.json'.length);
  if (onlyIds.size > 0 && !onlyIds.has(id)) continue;
  const snapshotFile = path.join(scenariosDir, file);
  const outDir = path.join(outRoot, id);
  const manifestFile = path.join(outDir, 'terrain.json');
  if (upToDate(manifestFile, [snapshotFile, rulesFile, scriptFile])) continue;

  rules ??= reviveBuildingRules(JSON.parse(fs.readFileSync(rulesFile, 'utf8')));
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  const started = Date.now();
  const layout = layoutTerrain(rules, snapshot.terrain, snapshot.map.width, snapshot.map.height);
  const sources = new Set();
  for (const ref of layout.refs) collectSources(ref, sources);

  const images = [];
  let skipped = 0;
  for (const rooted of [...sources].sort()) {
    const image = decode(rooted);
    if (!image || image.width > MAX_ATLAS_SIZE || image.height > MAX_ATLAS_SIZE) {
      skipped++;
      continue;
    }
    images.push({ rooted, image });
  }

  const atlases = pack(images);
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = { atlases: [], images: {} };
  let bytes = 0;
  atlases.forEach((atlas, index) => {
    const buffer = encodeAtlas(atlas);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
    const name = `terrain-${index}.${hash}.png`;
    fs.writeFileSync(path.join(outDir, name), buffer);
    bytes += buffer.length;
    manifest.atlases.push({ file: name, width: atlas.width, height: atlas.height });
    for (const p of atlas.placements) manifest.images[p.rooted] = [index, p.x, p.y, p.image.width, p.image.height];
  });
  // Drop bundles from earlier builds.
  const keep = new Set(['terrain.json', ...manifest.atlases.map((a) => a.file)]);
  for (const old of fs.readdirSync(outDir)) if (!keep.has(old)) fs.rmSync(path.join(outDir, old));
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));

  summary.push(
    `${id}: ${images.length} images in ${atlases.length} bundle(s), ${Math.round(bytes / 1024)} KB${skipped ? `, ${skipped} left per-file` : ''} (${Date.now() - started} ms)`,
  );
}
console.log(summary.length ? summary.join('\n') : 'build-image-atlases: all terrain bundles up to date');
