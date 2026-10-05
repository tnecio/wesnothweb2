#!/usr/bin/env node
/**
 * Phases 20 + 21: fills `public/campaigns.json` from each real campaign's own `[campaign]` block
 * (through the real preprocessor and parser), and builds `public/credits.json`.
 *
 * Per real campaign (one with a `wesnothId`) it records, as upstream's campaign dialogs read them:
 *   - `name` / `description` as translatable strings (`{"t": [[domain, msgid], ...]}`);
 *   - `rank`, `year` (or `startYear`/`endYear`) for ordering and the Timeline sort;
 *   - `icon`, `image`, `background` (image paths, with their image path functions intact);
 *   - `descriptionAlignment`;
 *   - `difficulties`: `[{define, label, description, image, default?, autoMarkup?}]` from `[difficulty]`.
 * Synthetic debug campaigns keep their plain English text and are marked `debug: true`.
 *
 * Every campaign (real or debug) also gets `assetDir`: the directory `build-scenario-snapshot.mjs` and
 * `build-story-assets.mjs` file its scenario/story JSON under (`scenarios/<assetDir>/<scenarioId>.json`),
 * so the runtime can fetch the right file. For a real campaign this is `wesnothId` (its own directory name
 * under `wesnoth/data/campaigns/`); a bare `[scenario] id=` is only unique *within* one campaign (Dead
 * Water and Under the Burning Suns both ship a `13_Epilogue`), so scenario JSON is nested per campaign
 * rather than sitting flat under `scenarios/` -- a flat namespace let one campaign's build silently
 * overwrite another's (found 2026-09-27). For a debug campaign, `assetDir` is found by scanning
 * `synthetic-campaigns/*` for the folder whose own scenarios include `firstScenario`, rather than assumed
 * from its id (`synthetic_combat` -> `combat` holds today but is not a guarantee).
 *
 * `credits.json` is what upstream's `about::set_about` builds: the two core credit groups
 * (`core/about.cfg`, `core/about_i18n.cfg`) and each shipped campaign's `[about]` sections,
 * with their translatable titles. Sections without entries are dropped, as upstream does.
 *
 * Phase 25: `packages/ui/src/achievements.json` is `data/achievements.cfg`'s groups (all but the tutorial's and
 * multiplayer's, which the port does not ship)
 * (bundled: events need them as soon as a game starts).
 *
 * `tips.json` is the title screen's tip-of-the-day source (`data/tips.cfg`, translatable text and
 * source line per tip). This data version has no `encountered_units=` filters, so none is carried.
 *
 * Run after editing campaigns.json or updating the wesnoth data:
 *   node --import tsx apps/web/scripts/build-campaigns.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile, preloadDefinesFromDir } from '../../../packages/engine/src/wml/index.ts';
import { scenarioIdOf } from './lib/scenarioId.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');
const file = path.join(repoRoot, 'apps/web/public/campaigns.json');
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));

const flag = (defines, name) => defines.set(name, { name, params: [], optionalParams: new Map(), body: '', dir: dataRoot, location: '<build-campaigns>' });

/** The core macros, with the given flags set first (several are declared behind `#ifdef <difficulty>`). */
function newDefines(...flags) {
  const defines = new Map();
  for (const f of flags) flag(defines, f);
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  // The theme macros too (`{themes/}` in `data/_main.cfg`): Heir to the Throne's `_main.cfg` uses
  // `CUTSCENE_THEME_BACKGROUND`.
  preloadDefinesFromDir(path.join(dataRoot, 'themes'), defines, { dataRoot });
  return defines;
}

/** A value as it goes into the manifest: a translatable string's JSON form, or the plain value. */
function textOf(cfg, key) {
  const t = cfg.getTString(key);
  if (!t) return undefined;
  return t.translatable ? t.toJSON() : t.baseStr();
}

/** A scenario file's own id -- the same rule `rebuild-snapshots.mjs` indexes scenarios by. */
function firstId(cfgFile) {
  return scenarioIdOf(fs.readFileSync(cfgFile, 'utf8'));
}

/**
 * The `synthetic-campaigns/<name>/` directory whose own scenarios include `scenarioId` -- found by content,
 * not assumed from the campaign's id, so a debug campaign named unlike its folder still resolves correctly.
 */
function findSyntheticAssetDir(scenarioId) {
  const root = path.join(repoRoot, 'synthetic-campaigns');
  for (const name of fs.readdirSync(root)) {
    const scenariosDir = path.join(root, name, 'scenarios');
    if (!fs.existsSync(scenariosDir)) continue;
    for (const f of fs.readdirSync(scenariosDir)) {
      if (f.endsWith('.cfg') && firstId(path.join(scenariosDir, f)) === scenarioId) return name;
    }
  }
  return null;
}

// The title-screen pictures the credits fall back to (`[images] game_title_background` in game_config.cfg);
// upstream picks one at random.
const gameConfig = fs.readFileSync(path.join(dataRoot, 'game_config.cfg'), 'utf8');
const backgrounds = (/game_title_background\s*=\s*"([^"]*)"/.exec(gameConfig)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const credits = { backgrounds, groups: [] };

/** One `about::credits_group`: sections with their entries' names, in file order. */
function creditsGroup(cfg, { id, header } = {}) {
  const sections = [];
  const images = [];
  for (const about of cfg.children('about')) {
    const entries = about.children('entry');
    if (entries.length === 0) continue;
    sections.push({ title: textOf(about, 'title') ?? '', names: entries.map((e) => e.get('name') ?? '') });
    for (const img of (about.get('images') ?? '').split(',').map((s) => s.trim()).filter(Boolean)) images.push(img);
  }
  return { ...(id ? { id } : {}), ...(header ? { header } : {}), ...(cfg.getBoolean('sort', false) ? { sort: true } : {}), images, sections };
}

// The core groups (`core/_main.cfg` wraps each file in its own [credits_group]).
for (const name of ['about.cfg', 'about_i18n.cfg']) {
  const cfg = parseWmlFile(path.join(dataRoot, 'core', name), { dataRoot, defines: newDefines('NORMAL') });
  credits.groups.push(creditsGroup(cfg));
}

for (const campaign of manifest.campaigns) {
  if (!campaign.wesnothId || !campaign.define) {
    campaign.debug = true;
    const dir = findSyntheticAssetDir(campaign.firstScenario);
    if (!dir) throw new Error(`${campaign.id}: no synthetic-campaigns/*/scenarios/*.cfg declares firstScenario "${campaign.firstScenario}"`);
    campaign.assetDir = dir;
    continue;
  }
  delete campaign.debug;
  campaign.assetDir = campaign.wesnothId;
  const main = parseWmlFile(path.join(dataRoot, 'campaigns', campaign.wesnothId, '_main.cfg'), {
    dataRoot,
    // The [campaign] block does not depend on the difficulty; any one define lets the core macros load.
    defines: newDefines(campaign.define, 'NORMAL'),
  });
  // A directory may hold more than one campaign (The Deceiver's Gambit and its part II): the one starting here.
  const blocks = main.children('campaign');
  const block = blocks.find((b) => b.getString('first_scenario', '') === campaign.firstScenario) ?? blocks[0];
  if (!block) throw new Error(`no [campaign] in ${campaign.wesnothId}`);
  for (const key of ['name', 'description']) {
    const t = block.getTString(key);
    if (!t || !t.translatable) throw new Error(`${campaign.wesnothId}: ${key} is not translatable`);
    campaign[key] = t.toJSON();
  }
  for (const key of ['icon', 'image', 'background']) {
    const v = block.get(key);
    if (v) campaign[key] = v;
    else delete campaign[key];
  }
  if (block.hasAttribute('rank')) campaign.rank = block.getNumber('rank', 1000);
  for (const [attr, key] of [['year', 'year'], ['start_year', 'startYear'], ['end_year', 'endYear']]) {
    const v = block.get(attr);
    if (v) campaign[key] = v;
    else delete campaign[key];
  }
  const align = block.get('description_alignment');
  if (align) campaign.descriptionAlignment = align;
  else delete campaign.descriptionAlignment;

  const difficulties = block.children('difficulty').map((d) => ({
    define: d.get('define'),
    label: textOf(d, 'label') ?? '',
    description: textOf(d, 'description') ?? '',
    image: d.get('image') || undefined,
    ...(d.getBoolean('default', false) ? { default: true } : {}),
    ...(d.getBoolean('auto_markup', true) ? {} : { autoMarkup: false }),
  }));
  if (difficulties.length > 0) campaign.difficulties = difficulties;
  else delete campaign.difficulties;

  credits.groups.push(creditsGroup(block, { id: campaign.wesnothId, header: textOf(block, 'name') }));
}

const tipsCfg = parseWmlFile(path.join(dataRoot, 'tips.cfg'), { dataRoot, defines: newDefines('NORMAL') });
const tips = tipsCfg.children('tip').map((tip) => ({ text: textOf(tip, 'text') ?? '', source: textOf(tip, 'source') ?? '' }));
fs.writeFileSync(path.join(repoRoot, 'apps/web/public/tips.json'), JSON.stringify({ tips }));

// Phase 25: the achievements (`data/achievements.cfg`, as `achievements::reload` reads it), for the shipped
// campaigns. Icon paths are rooted here as the game's binary-path search would find them (`data/...` paths
// name their file directly), since the achievements dialog also opens from the title screen, outside any
// campaign.
// `content_for=` is the content's own name, not always its campaign id (HttT's is `heir_2_the_throne`); every
// group is kept but the tutorial's and multiplayer Survivals', content the port does not ship.
const UNSHIPPED_ACHIEVEMENT_CONTENT = new Set(['tutorial', 'wesnoth_MP_survivals']);
const shippedDirs = manifest.campaigns.filter((c) => c.wesnothId).map((c) => c.wesnothId);
/** An icon as a rooted image path: `data/...` names its file; else core's, else the first shipped campaign's that has it. */
function rootIcon(icon) {
  if (!icon) return icon;
  const [file, ...mods] = icon.split('~');
  const suffix = mods.length > 0 ? `~${mods.join('~')}` : '';
  if (file.startsWith('data/')) return file.slice('data/'.length) + suffix;
  if (fs.existsSync(path.join(dataRoot, 'core/images', file))) return `core/images/${file}${suffix}`;
  const dir = shippedDirs.find((d) => fs.existsSync(path.join(dataRoot, 'campaigns', d, 'images', file)));
  return dir ? `campaigns/${dir}/images/${file}${suffix}` : icon;
}
const achievementsCfg = parseWmlFile(path.join(dataRoot, 'achievements.cfg'), { dataRoot, defines: newDefines('NORMAL') });
const achievementGroups = achievementsCfg
  .children('achievement_group')
  .filter((g) => !UNSHIPPED_ACHIEVEMENT_CONTENT.has(g.getString('content_for')))
  .map((g) => {
    return {
      contentFor: g.getString('content_for'),
      displayName: textOf(g, 'display_name') ?? '',
      achievements: g.children('achievement').map((a) => {
        const optional = (key, value) => (value === undefined || value === '' ? {} : { [key]: value });
        return {
          id: a.getString('id'),
          name: textOf(a, 'name') ?? '',
          ...optional('nameCompleted', textOf(a, 'name_completed')),
          description: textOf(a, 'description') ?? '',
          ...optional('descriptionCompleted', textOf(a, 'description_completed')),
          icon: rootIcon(a.getString('icon')),
          ...optional('iconCompleted', rootIcon(a.getString('icon_completed', ''))),
          ...(a.getBoolean('hidden', false) ? { hidden: true } : {}),
          ...(a.getNumber('max_progress', 0) > 0 ? { maxProgress: a.getNumber('max_progress', 0) } : {}),
          ...optional('sound', a.getString('sound', '')),
          ...(a.hasChild('sub_achievement')
            ? {
                subAchievements: a.children('sub_achievement').map((sub) => ({
                  id: sub.getString('id'),
                  description: textOf(sub, 'description') ?? '',
                  icon: rootIcon(sub.getString('icon')),
                })),
              }
            : {}),
        };
      }),
    };
  })
  .filter((g) => g.achievements.length > 0);
fs.writeFileSync(path.join(repoRoot, 'packages/ui/src/achievements.json'), JSON.stringify({ groups: achievementGroups }) + '\n');

fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(repoRoot, 'apps/web/public/credits.json'), JSON.stringify(credits));
console.log(
  `updated campaigns.json (${manifest.campaigns.length} campaigns), credits.json (${credits.groups.length} groups), tips.json (${tips.length} tips) and achievements.json (${achievementGroups.length} groups)`,
);
