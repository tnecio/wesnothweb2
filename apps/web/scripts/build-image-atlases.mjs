/**
 * Phase 28a P5/P6: builds image bundles -- each scenario's terrain and each
 * unit type's sprites.
 *
 *   npm run build:atlases --workspace=apps/web        (runs before `dev` and `build`)
 *   tsx apps/web/scripts/build-image-atlases.mjs [--force] [scenarioId ... | units]
 *
 * Terrain (P5): for every snapshot in `public/scenarios/`, runs the real
 * terrain layout (`packages/renderer/src/terrain/terrainLayout.ts`) against the
 * served `[terrain_graphics]` rules to get the refs of the initial board.
 *
 * Units (P6): for every unit type in any snapshot's `unitTypeConfigs` (the
 * fully flattened type, variations and genders included), every
 * `image=`/`image_diagonal=` and `image_mod=` anywhere in it -- base sprite
 * and all animation frames -- except `[advancement]` icons. Portraits and
 * halos are not drawn by the board and are left out. A type id present in
 * several snapshots gets the union of their images, so one bundle serves
 * every scenario.
 *
 * Every ref is expanded into the source files the compositor fetches (the
 * ref's own file, images named by `~MASK`/`~BLIT` arguments, recursively, and
 * the hex alpha mask for `~HEXED`); those PNGs are decoded with pngjs and
 * packed losslessly into bundle images of at most 4096x4096 (RGBA PNG, no
 * gamma/colour-profile chunks). Output, gitignored:
 *
 *   public/atlases/_common/terrain.json                               terrain shared by >= 5 scenarios (Phase 28)
 *   public/atlases/<campaignDir>/<scenarioId>/terrain.json            manifest (the scenario's other terrain)
 *   public/atlases/<campaignDir>/<scenarioId>/terrain-<n>.<hash>.png   content-hashed bundles
 *   public/atlases/units/<stem>.json                     manifest (stem: `unitBundleStem(typeId)`)
 *   public/atlases/units/<stem>-<n>.<hash>.png
 *   public/atlases/units/index.json                      type id -> stem, for tools
 *
 * Terrain bundles are nested under `<campaignDir>` (`CampaignInfo.assetDir`, matching
 * `public/scenarios/<campaignDir>/<id>.json`) because a bare scenario id is only unique within its own
 * campaign -- Dead Water and Under the Burning Suns both ship a `13_Epilogue`. A flat `<scenarioId>/`
 * namespace let one campaign's terrain bundle silently stand in for the other's at runtime (a real bug,
 * found 2026-09-27: the board could render one campaign's map with the wrong terrain images).
 *
 * A manifest maps each rooted image path (`rootedImagePath`, the same key the
 * runtime computes) to [bundle index, x, y, width, height]. Bundles are only a
 * cache: anything missing -- non-PNG sources, images changed at runtime by
 * WML/Lua -- is fetched on its own at runtime.
 *
 * Incremental: a scenario is skipped when its manifest is newer than its
 * snapshot, the rules file and this script; unit types are re-scanned when any
 * snapshot changed, and a type's bundle is only re-encoded when its image list
 * changed. `--force` rebuilds everything (e.g. after the art itself changed).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { layoutTerrain } from '../../../packages/renderer/src/terrain/terrainLayout.ts';
import { mergeBuildingRules, ownTerrainGraphicsRules, reviveBuildingRules } from '../../../packages/renderer/src/terrain/terrainGraphicsRules.ts';
import { parseIpf, splitRef } from '../../../packages/renderer/src/images/ipf.ts';
import { HEX_MASK, rootedImagePath, setCampaignImages, setEngineImages, unitBundleStem } from '../../../packages/renderer/src/images/compositor.ts';
import { parseStepSequence } from '../../../packages/renderer/src/animation/frame.ts';
import { MINIMAP_FOG_IMAGE, MINIMAP_HIGHLIGHT_IMAGE, VOID_TERRAIN } from '../../../packages/renderer/src/minimap.ts';
import { readScenarioSnapshot } from '../../../packages/engine/src/snapshot/snapshotFiles.node.ts';

const scriptFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptFile), '../../..');
const publicDir = path.join(repoRoot, 'apps/web/public');
const scenariosDir = path.join(publicDir, 'scenarios');
const rulesFile = path.join(publicDir, 'terrain-graphics-rules.json');
const outRoot = path.join(publicDir, 'atlases');
const unitsDir = path.join(outRoot, 'units');
const dataRoot = path.join(repoRoot, 'wesnoth/data');
const engineImagesRoot = path.join(repoRoot, 'wesnoth/images');
// The engine-only images resolve to `engine/...`, as in the browser (`GameShell`'s `setEngineImages`).
setEngineImages(JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/ui/src/engineImages.json'), 'utf8')));

/** Largest bundle image edge; sources bigger than this stay per-file. */
const MAX_ATLAS_SIZE = 4096;

const args = process.argv.slice(2);
const force = args.includes('--force');
const onlyIds = new Set(args.filter((a) => !a.startsWith('--')));
const wanted = (id) => onlyIds.size === 0 || onlyIds.has(id);

/** Where a rooted image path lives on disk. */
function diskPath(rooted) {
  return rooted.startsWith('engine/') ? path.join(engineImagesRoot, rooted.slice('engine/'.length)) : path.join(dataRoot, rooted);
}

/** Source files named by an IPF modifier chain's arguments. */
function collectModSources(mods, out) {
  for (const op of parseIpf(mods)) {
    if ((op.name === 'MASK' || op.name === 'BLIT') && op.args[0]) collectSources(op.args[0], out);
    if (op.name === 'HEXED') out.add(rootedImagePath(HEX_MASK));
  }
}

/** Every source file a ref makes the compositor fetch (mirrors `Compositor.render`/`applyOp`). */
function collectSources(ref, out) {
  const { path: imagePath, mods } = splitRef(ref);
  if (imagePath) out.add(rootedImagePath(imagePath));
  collectModSources(mods, out);
}

/** Unit type config attributes holding refs the board draws. */
const UNIT_IMAGE_KEYS = new Set(['image', 'image_diagonal']);

/** Every source file of a (flattened, JSON) unit type config's sprites and animation frames. */
function collectUnitSources(cfg, tag, out) {
  if (tag === 'advancement') return;
  for (const [key, value] of Object.entries(cfg.attrs)) {
    if (typeof value !== 'string' || !value || value.includes('$')) continue;
    if (UNIT_IMAGE_KEYS.has(key)) {
      // Frame syntax: "units/x-[1~4].png:100,units/y.png" -> one ref per step.
      for (const step of parseStepSequence(value)) if (step.value) collectSources(step.value, out);
    } else if (key === 'image_mod') {
      collectModSources(value, out);
    }
  }
  for (const child of cfg.children) collectUnitSources(child.config, child.tag, out);
}

/** Decoded PNGs shared across bundles: rooted path -> { width, height, data } | null. */
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
function pack(images, maxSize = MAX_ATLAS_SIZE) {
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
    if (current.shelfX + width > maxSize) {
      current.shelfY += current.shelfHeight;
      current.shelfX = 0;
      current.shelfHeight = 0;
    }
    if (current.shelfY + height > maxSize) {
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
  return encodePalettePng(atlas.width, atlas.height, png.data) ?? PNG.sync.write(png, { colorType: 6, inputColorType: 6, bitDepth: 8 });
}

/**
 * Phase 28 S4: the image as an 8-bit palette PNG when it has at most 256 distinct RGBA values, else null.
 * Unit sprites are palette PNGs upstream (a unit's whole bundle has ~50 colours), and repacking them as
 * RGBA tripled their size. The palette keeps every RGBA value exactly, including the colour of fully
 * transparent pixels, and the result is decoded again and compared before it is used.
 */
function encodePalettePng(width, height, rgba) {
  const index = new Map();
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width + 1); // byte 0 of each row: filter type 0 (None), the usual choice for palettes
    for (let x = 0; x < width; x++) {
      const key = rgba.readUInt32BE((y * width + x) * 4);
      let i = index.get(key);
      if (i === undefined) {
        if (index.size === 256) return null;
        i = index.size;
        index.set(key, i);
      }
      rows[rowStart + 1 + x] = i;
    }
  }
  const colours = [...index.keys()];
  const plte = Buffer.alloc(colours.length * 3);
  const trns = Buffer.alloc(colours.length);
  colours.forEach((c, i) => {
    plte[i * 3] = c >>> 24;
    plte[i * 3 + 1] = (c >>> 16) & 255;
    plte[i * 3 + 2] = (c >>> 8) & 255;
    trns[i] = c & 255;
  });
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // colour type: palette
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('tRNS', trns),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const back = PNG.sync.read(png);
  if (back.width !== width || back.height !== height || !back.data.equals(rgba)) throw new Error('palette PNG does not decode to its source pixels');
  return png;
}

/**
 * Packs `sources` (rooted paths) into `<dir>/<prefix>-<n>.<hash>.png` bundles and writes
 * `<dir>/<prefix>.json`. Returns the bundle file names plus a summary line.
 */
function writeBundle(dir, prefix, sources, maxSize = MAX_ATLAS_SIZE) {
  const images = [];
  let skipped = 0;
  for (const rooted of [...sources].sort()) {
    const image = decode(rooted);
    if (!image || image.width > maxSize || image.height > maxSize) {
      skipped++;
      continue;
    }
    images.push({ rooted, image });
  }
  const atlases = pack(images, maxSize);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { atlases: [], images: {} };
  let bytes = 0;
  atlases.forEach((atlas, index) => {
    const buffer = encodeAtlas(atlas);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
    const name = `${prefix}-${index}.${hash}.png`;
    fs.writeFileSync(path.join(dir, name), buffer);
    bytes += buffer.length;
    manifest.atlases.push({ file: name, width: atlas.width, height: atlas.height });
    for (const p of atlas.placements) manifest.images[p.rooted] = [index, p.x, p.y, p.image.width, p.image.height];
  });
  fs.writeFileSync(path.join(dir, `${prefix}.json`), JSON.stringify(manifest));
  return {
    files: manifest.atlases.map((a) => a.file),
    summary: `${images.length} images in ${atlases.length} bundle(s), ${Math.round(bytes / 1024)} KB${skipped ? `, ${skipped} left per-file` : ''}`,
  };
}

function upToDate(manifestFile, inputs) {
  if (force || !fs.existsSync(manifestFile)) return false;
  const built = fs.statSync(manifestFile).mtimeMs;
  return inputs.every((f) => fs.existsSync(f) && fs.statSync(f).mtimeMs <= built);
}

/** Every `<campaignDir>/<id>.json` snapshot (not a difficulty overlay), recursively -- see module doc comment. */
function findSnapshots() {
  const found = [];
  for (const campaignDirName of fs.readdirSync(scenariosDir).sort()) {
    const dir = path.join(scenariosDir, campaignDirName);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      if (f.endsWith('.json') && !f.includes('@') && !f.startsWith('_')) found.push({ campaignDirName, id: f.slice(0, -5), file: path.join(dir, f) });
    }
  }
  return found;
}
const snapshotFiles = findSnapshots();

/** Phase 28: the shared unit/terrain databases the scenario files name (`_core.json`, `<campaignDir>/_campaign.json`). */
function databaseFiles() {
  const out = [];
  for (const name of fs.readdirSync(scenariosDir)) {
    const p = path.join(scenariosDir, name);
    if (name.startsWith('_')) out.push(p);
    else if (fs.statSync(p).isDirectory()) for (const f of fs.readdirSync(p)) if (f.startsWith('_')) out.push(path.join(p, f));
  }
  return out;
}
const summary = [];

// ── Terrain: one shared bundle plus a small one per scenario ─────────────────
// Phase 28 S4 (docs/ASSETS.md §4.2, §6): per-scenario bundles repeated the same common tiles in every
// scenario (44 bundles held 13k image slots but only 1.7k distinct images). So there are three tiers, each
// downloaded once and cached:
//  - `_common/terrain.json`: images at least half of the real campaigns use (at least 2 campaigns) --
//    the tiles almost every board has. Phase 28c: this used to be "used by 5 or more scenarios", which
//    grew with every campaign added (The South Guard alone took it from 9.9 to 12 MB, all of it loaded by
//    every scenario of every campaign);
//  - `<campaign>/_campaign/terrain.json` (Phase 28c): the rest that 2 or more of that campaign's scenarios use;
//  - `<campaign>/<scenario>/terrain.json`: what is left.
// Which images are common depends on every scenario, so terrain is rebuilt for all of them together (a
// scenario id filter does not narrow it).
const realCampaignDirs = new Set(
  JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/web/public/campaigns.json'), 'utf8')).campaigns.filter((c) => !c.debug).map((c) => c.assetDir),
);
const COMMON_CAMPAIGNS = Math.max(2, Math.ceil(realCampaignDirs.size / 2));
const CAMPAIGN_MIN_SCENARIOS = 2;

/**
 * The minimap's tiles for `snapshot`'s map: each terrain code's `symbol_image` (the base's and the overlay's
 * for a combined code with no type of its own), plus the fog and reach highlight tiles -- as
 * `packages/ui/src/minimapStyle.ts` and `packages/renderer/src/minimap.ts` pick them.
 */
function minimapImages(snapshot) {
  const symbolByCode = new Map();
  for (const cfg of snapshot.terrainTypeConfigs ?? []) {
    const code = cfg.attrs?.string;
    const symbol = cfg.attrs?.symbol_image;
    if (typeof code === 'string' && typeof symbol === 'string' && symbol !== '') symbolByCode.set(code, symbol);
  }
  const out = new Set([MINIMAP_FOG_IMAGE, MINIMAP_HIGHLIGHT_IMAGE].map((p) => `core/images/${p}`));
  const add = (symbol) => symbol && out.add(`core/images/terrain/${symbol}.png`);
  for (const code of new Set([...snapshot.terrain.map((h) => h.code), VOID_TERRAIN])) {
    if (symbolByCode.has(code)) add(symbolByCode.get(code));
    else if (code.includes('^')) {
      add(symbolByCode.get(code.slice(0, code.indexOf('^'))));
      add(symbolByCode.get(code.slice(code.indexOf('^'))));
    }
  }
  return [...out].filter((rooted) => fs.existsSync(path.join(dataRoot, rooted)));
}
const COMMON_ATLAS_SIZE = 2048;
const commonDir = path.join(outRoot, '_common');
if (!fs.existsSync(rulesFile)) {
  console.warn(`build-image-atlases: ${path.relative(repoRoot, rulesFile)} is missing; no terrain bundles built (the game falls back to per-file images).`);
} else if (
  !upToDate(path.join(commonDir, 'terrain.json'), [...snapshotFiles.map((s) => s.file), ...databaseFiles(), rulesFile, scriptFile]) ||
  snapshotFiles.some(({ campaignDirName, id }) => !fs.existsSync(path.join(outRoot, campaignDirName, id, 'terrain.json')))
) {
  const rules = reviveBuildingRules(JSON.parse(fs.readFileSync(rulesFile, 'utf8')));
  const started = Date.now();
  // The campaign's own images come first in the search, as in the browser (`GameShell`'s `setCampaignImages`).
  const campaignImageLists = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/ui/src/campaignImages.json'), 'utf8'));
  const perScenario = snapshotFiles.map(({ campaignDirName, id, file }) => {
    const files = campaignImageLists[campaignDirName];
    setCampaignImages(files ? `campaigns/${campaignDirName}/images` : null, files ?? []);
    const snapshot = readScenarioSnapshot(file);
    // C1: with the campaign's and scenario's own rules, as the board lays it out.
    const own = reviveBuildingRules(ownTerrainGraphicsRules(snapshot));
    const layout = layoutTerrain(mergeBuildingRules(rules, own), snapshot.terrain, snapshot.map.width, snapshot.map.height);
    const sources = new Set();
    for (const ref of layout.refs) collectSources(ref, sources);
    for (const rooted of minimapImages(snapshot)) sources.add(rooted);
    return { campaignDirName, id, sources };
  });
  // Which real campaigns use each image, and how many scenarios of each campaign.
  const campaignsUsing = new Map();
  const scenarioUses = new Map(); // `${campaign}\0${rooted}` -> scenarios
  for (const { campaignDirName, sources } of perScenario) {
    for (const rooted of sources) {
      if (realCampaignDirs.has(campaignDirName)) {
        if (!campaignsUsing.has(rooted)) campaignsUsing.set(rooted, new Set());
        campaignsUsing.get(rooted).add(campaignDirName);
      }
      const key = `${campaignDirName}\0${rooted}`;
      scenarioUses.set(key, (scenarioUses.get(key) ?? 0) + 1);
    }
  }
  const common = new Set([...campaignsUsing].filter(([, set]) => set.size >= COMMON_CAMPAIGNS).map(([rooted]) => rooted));
  const campaignShared = new Map();
  for (const { campaignDirName, sources } of perScenario) {
    if (!campaignShared.has(campaignDirName)) campaignShared.set(campaignDirName, new Set());
    for (const rooted of sources) {
      if (!common.has(rooted) && scenarioUses.get(`${campaignDirName}\0${rooted}`) >= CAMPAIGN_MIN_SCENARIOS) campaignShared.get(campaignDirName).add(rooted);
    }
  }

  const writeTerrain = (outDir, sources, maxSize) => {
    const { files, summary: line } = writeBundle(outDir, 'terrain', sources, maxSize);
    // Drop bundles from earlier builds.
    const keep = new Set(['terrain.json', ...files]);
    for (const old of fs.readdirSync(outDir)) if (!keep.has(old)) fs.rmSync(path.join(outDir, old));
    return line;
  };
  // The shared bundle is split into images of at most 2048 px (~2.5 MB each): one 10 MB file is dropped by
  // small (mobile, in-memory) HTTP caches, and several download in parallel.
  summary.push(`terrain, shared by >= ${COMMON_CAMPAIGNS} campaigns: ${writeTerrain(commonDir, common, COMMON_ATLAS_SIZE)}`);
  for (const [campaignDirName, shared] of campaignShared) {
    const dir = path.join(outRoot, campaignDirName, '_campaign');
    fs.mkdirSync(dir, { recursive: true });
    summary.push(`${campaignDirName}, shared by its scenarios: ${writeTerrain(dir, shared, COMMON_ATLAS_SIZE)}`);
  }
  for (const { campaignDirName, id, sources } of perScenario) {
    const shared = campaignShared.get(campaignDirName);
    const own = new Set([...sources].filter((rooted) => !common.has(rooted) && !shared.has(rooted)));
    summary.push(`${campaignDirName}/${id}: ${writeTerrain(path.join(outRoot, campaignDirName, id), own)}`);
  }
  summary.push(`terrain: ${perScenario.length} scenarios in ${Date.now() - started} ms`);
}

// ── Small images every board draws: unit ellipses, leader crown, orbs, village flags ──────────────
// Phase 28 S4 (docs/ASSETS.md §4.6): about a dozen of these were fetched one by one per scenario. One
// fixed bundle, `_ui/ui.json`, holds every ellipse, crown, orb and flag animation frame -- and (Phase 28b)
// the route's footprints, its ZoC/capture/hidden markers and the attack direction indicator.
const uiDir = path.join(outRoot, '_ui');
if (!upToDate(path.join(uiDir, 'ui.json'), [scriptFile])) {
  const pick = (dir, rootedDir, test) =>
    fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.png') && test(f)).map((f) => `${rootedDir}/${f}`) : [];
  const sources = new Set([
    ...pick(path.join(engineImagesRoot, 'misc'), 'engine/misc', (f) => /^(ellipse|leader-crown|orb|attack-indicator-|zoc\.|capture\.|hidden\.)/.test(f)),
    ...pick(path.join(engineImagesRoot, 'footsteps'), 'engine/footsteps', () => true),
    ...pick(path.join(dataRoot, 'core/images/flags'), 'core/images/flags', () => true),
  ]);
  const { files, summary: line } = writeBundle(uiDir, 'ui', sources, COMMON_ATLAS_SIZE);
  const keep = new Set(['ui.json', ...files]);
  for (const old of fs.readdirSync(uiDir)) if (!keep.has(old)) fs.rmSync(path.join(uiDir, old));
  summary.push(`ui: ${line}`);
}

// ── Unit types, across all scenarios ───────────────────────────────────────
const unitIndexFile = path.join(unitsDir, 'index.json');
if (wanted('units') && !upToDate(unitIndexFile, [...snapshotFiles.map((s) => s.file), ...databaseFiles(), scriptFile])) {
  const started = Date.now();
  const typeSources = new Map();
  for (const { file: snapshotFile } of snapshotFiles) {
    const snapshot = readScenarioSnapshot(snapshotFile);
    for (const [typeId, cfg] of Object.entries(snapshot.unitTypeConfigs ?? {})) {
      let sources = typeSources.get(typeId);
      if (!sources) typeSources.set(typeId, (sources = new Set()));
      collectUnitSources(cfg, 'unit_type', sources);
    }
  }

  fs.mkdirSync(unitsDir, { recursive: true });
  const index = {};
  const stems = new Map();
  const keep = new Set(['index.json']);
  let rebuilt = 0;
  for (const typeId of [...typeSources.keys()].sort()) {
    const stem = unitBundleStem(typeId);
    if (stems.has(stem)) throw new Error(`unit bundle name clash: "${typeId}" and "${stems.get(stem)}"`);
    stems.set(stem, typeId);
    index[typeId] = stem;
    const manifestFile = path.join(unitsDir, `${stem}.json`);
    const sources = typeSources.get(typeId);

    // Keep an existing bundle whose image list is unchanged (and whose bundle files still exist).
    const existing = !force && fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
    const wantedPaths = [...sources].filter((rooted) => decode(rooted)).sort();
    const existingFiles = existing?.atlases.map((a) => a.file) ?? [];
    if (
      existing &&
      JSON.stringify(Object.keys(existing.images).sort()) === JSON.stringify(wantedPaths) &&
      existingFiles.every((f) => fs.existsSync(path.join(unitsDir, f)))
    ) {
      keep.add(`${stem}.json`);
      for (const f of existingFiles) keep.add(f);
      continue;
    }
    const { files } = writeBundle(unitsDir, stem, sources);
    keep.add(`${stem}.json`);
    for (const f of files) keep.add(f);
    rebuilt++;
  }
  for (const old of fs.readdirSync(unitsDir)) if (!keep.has(old)) fs.rmSync(path.join(unitsDir, old));
  fs.writeFileSync(unitIndexFile, JSON.stringify(index));
  summary.push(`units: ${typeSources.size} types, ${rebuilt} bundle(s) (re)built (${Date.now() - started} ms)`);
}

console.log(summary.length ? summary.join('\n') : 'build-image-atlases: all bundles up to date');
