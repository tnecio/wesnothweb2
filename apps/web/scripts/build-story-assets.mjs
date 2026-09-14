#!/usr/bin/env node
/**
 * Phase 16 N2: builds the story screen's assets from already-built scenario
 * snapshots (`apps/web/public/scenarios/*.json`, see build-scenario-snapshot.mjs).
 *
 *   node apps/web/scripts/build-story-assets.mjs [scenarioId ...]
 *
 * For every real-campaign scenario:
 * - `public/story/<id>.json`: the scenario's `[story]` WML (possibly none)
 *   plus an image table for its story art and every portrait a `[message]`
 *   can show (Phase 16 N6), keyed by the path as written in WML (portraits:
 *   without `~` functions): rooted source path, pixel size, bytes, and
 *   smaller derived variants.
 * - `public/derived-images/<rooted path>.w<width>.webp`: re-encoded, lower
 *   resolution copies (WebP q80) of every story image wider than the
 *   smallest variant width. Never upscaled; rebuilt only when the source is
 *   newer than the output.
 *
 * Images are rooted like the C++ image search path: the campaign's own
 * `[binary_path]` (`data/campaigns/<Campaign>/images`) first, then
 * `data/core/images`. Every branch of `[if]`/`[switch]` is walked, since
 * which one shows is only known at runtime. Paths containing `$` (runtime
 * variables) are skipped with a warning; `~` image-path functions are
 * stripped for lookup and the base image is what gets rooted.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');
const publicDir = path.join(repoRoot, 'apps/web/public');
const scenariosDir = path.join(publicDir, 'scenarios');
const storyOutDir = path.join(publicDir, 'story');
const derivedDir = path.join(publicDir, 'derived-images');

/** Variant widths in pixels; the viewer picks the smallest one covering viewport width x devicePixelRatio. */
const VARIANT_WIDTHS = [960, 1920];
const WEBP_QUALITY = 80;
/** Images this narrow (journey dots, icons) are served as-is. */
const MIN_VARIANT_SOURCE_WIDTH = 400;
/** A full-width re-encode is kept only if it is at most this fraction of the original's bytes. */
const FULL_WIDTH_MAX_RATIO = 0.75;

const onlyIds = new Set(process.argv.slice(2));

/** Finds `data/campaigns/<Campaign>/scenarios/**.cfg` declaring this scenario: by file name first, then by `id=`. */
function findCampaignDir(scenarioId) {
  const campaignsRoot = path.join(dataRoot, 'campaigns');
  const cfgFiles = [];
  for (const campaign of fs.readdirSync(campaignsRoot)) {
    const scenariosRoot = path.join(campaignsRoot, campaign, 'scenarios');
    if (!fs.existsSync(scenariosRoot)) continue;
    for (const entry of fs.readdirSync(scenariosRoot, { recursive: true })) {
      if (String(entry).endsWith('.cfg')) cfgFiles.push({ campaign, file: path.join(scenariosRoot, String(entry)) });
    }
  }
  const lower = `${scenarioId.toLowerCase()}.cfg`;
  const byName = cfgFiles.find((c) => path.basename(c.file).toLowerCase() === lower);
  if (byName) return path.join(campaignsRoot, byName.campaign);
  const idPattern = new RegExp(`^\\s*id\\s*=\\s*"?${scenarioId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?\\s*$`, 'm');
  const byId = cfgFiles.find((c) => idPattern.test(fs.readFileSync(c.file, 'utf8')));
  return byId ? path.join(campaignsRoot, byId.campaign) : null;
}

/**
 * The campaign's name and `[about]` credits from its `_main.cfg` `[campaign]`
 * block, for the outro (`gui2::dialogs::outro`, `about::get_campaign_credits`).
 * A light text scan rather than a full preprocessor run: mainline credits are
 * plain `title = _ "..."` / `[entry] name = "..."` literals. Sections without
 * entries are dropped, as upstream does. Null when the block is absent.
 */
function extractCampaignCredits(campaignDir) {
  const mainCfg = path.join(campaignDir, '_main.cfg');
  if (!fs.existsSync(mainCfg)) return null;
  const block = /\[campaign\]([\s\S]*?)\[\/campaign\]/.exec(fs.readFileSync(mainCfg, 'utf8'))?.[1];
  if (!block) return null;
  const quoted = (body, key) => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(?:_\\s*)?"((?:[^"]|"")*)"`, 'm').exec(body);
    return m ? m[1].replace(/""/g, '"') : '';
  };
  const aboutBlocks = [...block.matchAll(/\[about\]([\s\S]*?)\[\/about\]/g)].map((m) => m[1]);
  const credits = [];
  for (const about of aboutBlocks) {
    const names = [...about.matchAll(/\[entry\]([\s\S]*?)\[\/entry\]/g)].map((e) => quoted(e[1], 'name')).filter((n) => n !== '');
    if (names.length > 0) credits.push({ title: quoted(about, 'title'), names });
  }
  const name = quoted(block.replace(/\[about\][\s\S]*?\[\/about\]/g, ''), 'name');
  return { name, credits };
}

/** Strips image path functions (`~RIGHT()`, `~SCALE_SHARP(...)`, ...) to the file path. */
function basePath(ref) {
  return ref.split('~')[0];
}

/**
 * Every portrait a `[message]` in this scenario can show: each unit type's
 * `profile=` (including gender variants), `profile=` overrides anywhere in
 * the scenario (`[unit]`, `[side]`), and `[message] image=`/`second_image=`.
 * Keyed by base path; `unit_image` (use the sprite) and `none` are skipped.
 */
function collectPortraitImages(snapshot) {
  const found = new Set();
  const add = (value) => {
    if (typeof value !== 'string') return;
    const base = basePath(value);
    if (base === '' || base === 'unit_image' || base === 'none' || base.includes('$')) return;
    found.add(base);
  };
  for (const typeCfg of Object.values(snapshot.unitTypeConfigs ?? {})) {
    add(typeCfg.attrs?.profile);
    for (const child of typeCfg.children ?? []) {
      if (child.tag === 'male' || child.tag === 'female' || child.tag === 'variation') add(child.config.attrs?.profile);
    }
  }
  const visit = (tag, cfg) => {
    const attrs = cfg.attrs ?? {};
    add(attrs.profile);
    if (tag === 'message') {
      add(attrs.image);
      add(attrs.second_image);
    }
    for (const child of cfg.children ?? []) visit(child.tag, child.config);
  };
  visit('scenario', snapshot.scenarioConfigJson);
  return [...found];
}

/** Every image path referenced anywhere under the `[story]` configs (all branches). */
function collectStoryImages(storyJsons) {
  const found = new Set();
  const visit = (tag, cfg) => {
    const attrs = cfg.attrs ?? {};
    if (tag === 'part' && typeof attrs.background === 'string') found.add(attrs.background);
    if (tag === 'background_layer' && typeof attrs.image === 'string') found.add(attrs.image);
    if (tag === 'image' && typeof attrs.file === 'string') found.add(attrs.file);
    for (const child of cfg.children ?? []) visit(child.tag, child.config);
  };
  for (const s of storyJsons) visit('story', s);
  found.delete('');
  return [...found];
}

function rootImage(raw, campaignDir) {
  const base = raw.split('~')[0];
  const candidates = [];
  if (campaignDir) candidates.push(path.join(path.relative(dataRoot, campaignDir), 'images', base));
  candidates.push(path.join('core/images', base));
  for (const rel of candidates) {
    if (fs.existsSync(path.join(dataRoot, rel))) return rel.split(path.sep).join('/');
  }
  return null;
}

function imageSize(file) {
  const [w, h] = execFileSync('identify', ['-format', '%w %h', `${file}[0]`], { encoding: 'utf8' }).trim().split(' ').map(Number);
  return { w, h };
}

function buildVariants(rooted, size) {
  const source = path.join(dataRoot, rooted);
  const sourceStat = fs.statSync(source);
  if (size.w <= MIN_VARIANT_SOURCE_WIDTH) return [];
  const variants = [];
  // Narrower copies, plus a full-width re-encode: many originals are quality-100 WebP
  // (Dead Water's 1280 px map: 1.49 MB -> ~250 KB at q80), and story backgrounds are
  // often drawn wider than their source, so the full-width copy is the one served.
  const widths = [...VARIANT_WIDTHS.filter((w) => w < size.w), size.w];
  for (const width of widths) {
    const rel = `${rooted.replace(/\.[^.]+$/, '')}.w${width}.webp`;
    const out = path.join(derivedDir, rel);
    if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < sourceStat.mtimeMs) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const resize = width === size.w ? [] : ['-resize', `${width}x`];
      execFileSync('convert', [`${source}[0]`, ...resize, '-quality', String(WEBP_QUALITY), out]);
    }
    const bytes = fs.statSync(out).size;
    if (width === size.w && bytes > sourceStat.size * FULL_WIDTH_MAX_RATIO) {
      // Not worth serving over the original.
      fs.rmSync(out);
      continue;
    }
    const outSize = imageSize(out);
    variants.push({ src: rel, w: outSize.w, h: outSize.h, bytes });
  }
  return variants;
}

fs.mkdirSync(storyOutDir, { recursive: true });
/** rooted path -> image table entry, shared by every scenario in this run. */
const imageInfoCache = new Map();
let totalOriginal = 0;
let totalSmallest = 0;
const summary = [];

for (const file of fs.readdirSync(scenariosDir).sort()) {
  if (!file.endsWith('.json')) continue;
  const id = file.slice(0, -'.json'.length);
  if (onlyIds.size > 0 && !onlyIds.has(id)) continue;
  const snapshot = JSON.parse(fs.readFileSync(path.join(scenariosDir, file), 'utf8'));
  const scenarioCfg = snapshot.scenarioConfigJson;
  const storyJsons = (scenarioCfg.children ?? []).filter((c) => c.tag === 'story').map((c) => c.config);
  const outFile = path.join(storyOutDir, `${id}.json`);
  const campaignDir = findCampaignDir(id);
  if (!campaignDir) {
    // Synthetic scenarios have no campaign art to root.
    if (fs.existsSync(outFile)) fs.rmSync(outFile);
    continue;
  }

  const images = {};
  for (const raw of [...collectStoryImages(storyJsons), ...collectPortraitImages(snapshot)]) {
    if (images[raw]) continue;
    if (raw.includes('$')) {
      console.warn(`${id}: skipping runtime-variable image path "${raw}"`);
      continue;
    }
    const rooted = rootImage(raw, campaignDir);
    if (!rooted) {
      console.warn(`${id}: image not found in campaign or core: "${raw}"`);
      continue;
    }
    // Many scenarios share the same core portraits: size and encode each file once per run.
    let info = imageInfoCache.get(rooted);
    if (!info) {
      const size = imageSize(path.join(dataRoot, rooted));
      const bytes = fs.statSync(path.join(dataRoot, rooted)).size;
      info = { src: rooted, w: size.w, h: size.h, bytes, variants: buildVariants(rooted, size) };
      imageInfoCache.set(rooted, info);
    }
    const { variants } = info;
    const bytes = info.bytes;
    images[raw] = info;
    totalOriginal += bytes;
    totalSmallest += variants.length > 0 ? variants[0].bytes : bytes;
  }

  const campaign = extractCampaignCredits(campaignDir);
  const out = { scenarioId: id, scenarioName: snapshot.scenario?.name ?? '', story: storyJsons, images, ...(campaign ? { campaign } : {}) };
  fs.writeFileSync(outFile, JSON.stringify(out));
  summary.push(`${id}: ${storyJsons.length} [story], ${Object.keys(images).length} images, ${Math.round(fs.statSync(outFile).size / 1024)} KB`);
}

console.log(summary.join('\n'));
console.log(`\nimage bytes: originals ${Math.round(totalOriginal / 1024)} KB, smallest variants ${Math.round(totalSmallest / 1024)} KB (per-scenario sums, shared images counted once per scenario)`);
