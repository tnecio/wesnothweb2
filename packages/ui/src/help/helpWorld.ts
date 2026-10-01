/**
 * What the help's generators read (Phase 24): the counterparts of upstream's `unit_types`, `terrain_type_data`,
 * the game config's `[era]`s and `string_table`, built from `HelpData` (see `helpData.ts`).
 *
 * Deliberate difference: every unit type and terrain counts as encountered. Upstream lists only what the
 * player has met, unless the "show all units in help" preference or debug mode is on; the user chose to
 * show everything (2026-09-30).
 */
import type { TerrainCode } from '@wesnothweb2/engine';
import {
  mergeUnitTypeConfig,
  parseTerrainCode,
  parseTerrainList,
  TerrainTypeData,
  UnitType,
  WmlConfig,
  NONE_TERRAIN,
  TerrainCode as TerrainCodeCtor,
  NO_LAYER,
  VOID_TERRAIN,
  type MoveType,
  type RegistryEntry,
  type TimeOfDayEntry,
} from '@wesnothweb2/engine';
import type { HelpData, HelpGameContext } from './helpData.js';

/** Upstream `unit_type::ability_metadata`, reduced to what the help shows. */
export interface AbilityMetadata {
  readonly id: string;
  readonly helpTopicId: string;
  readonly name: string;
  readonly femaleName: string;
  readonly description: string;
}

/** Upstream `unit_ability_t::tooltip_info`. */
export interface SpecialTooltip {
  readonly name: string;
  readonly description: string;
  readonly helpTopicId: string;
}

/** `unit_ability_t::get_help_topic_id`. */
export function helpTopicIdOf(cfg: WmlConfig): string {
  return cfg.getString('unique_id', cfg.getString('id'));
}

function abilityMetadata(cfg: WmlConfig): AbilityMetadata {
  return {
    id: cfg.getString('id'),
    helpTopicId: helpTopicIdOf(cfg),
    name: cfg.getString('name'),
    femaleName: cfg.getString('female_name'),
    description: cfg.getString('description'),
  };
}

/** One unit type as the help sees it: its (merged) config and the engine's `UnitType` for the computed parts. */
export class HelpUnitType {
  private built: UnitType | undefined;
  private readonly variationTypes = new Map<string, HelpUnitType>();
  private femaleType: HelpUnitType | null | undefined;

  constructor(
    private readonly world: HelpWorld,
    /** The flattened config (for a variation or gender, the sub-type's merged config). */
    readonly cfg: WmlConfig,
    /** The variation this is (`''` for a base type), as `unit_type::variation_id()`. */
    readonly variationId = '',
    /** The base type, for a variation or a gender sub-type. */
    readonly parent: HelpUnitType | null = null,
  ) {}

  get id(): string {
    return this.cfg.getString('id');
  }
  /** `type_name()`: the translated name. */
  get typeName(): string {
    return this.cfg.getString('name', this.id);
  }
  get raceId(): string {
    return this.cfg.getString('race');
  }
  /** `hide_help()`. (`[hide_help]` tags are not read: no mainline content has them outside the editor.) */
  get hideHelp(): boolean {
    return this.cfg.getBoolean('hide_help', false);
  }
  get variationName(): string {
    return this.cfg.getString('variation_name');
  }
  get image(): string {
    return this.cfg.getString('image');
  }
  get flagRgb(): string {
    return this.cfg.getString('flag_rgb', 'magenta');
  }
  get smallProfile(): string {
    return this.cfg.getString('small_profile');
  }
  get bigProfile(): string {
    return this.cfg.getString('profile');
  }
  get level(): number {
    return this.cfg.getNumber('level', 0);
  }
  get advancesTo(): string[] {
    const s = this.cfg.getString('advances_to', '');
    return s === '' || s === 'null' ? [] : s.split(',').map((v) => v.trim()).filter((v) => v !== '' && v !== 'null');
  }
  /** `unit_type::advances_from()`: every type that advances to this one. */
  get advancesFrom(): string[] {
    return this.world.advancesFrom(this.id);
  }
  /** `unit_description()`. */
  get description(): string {
    return this.cfg.getString('description');
  }
  /** `[variation]` ids, in order. */
  get variations(): string[] {
    return this.cfg.children('variation').map((v) => v.getString('variation_id'));
  }
  /** `get_variation(id)`. */
  variation(id: string): HelpUnitType {
    let v = this.variationTypes.get(id);
    if (!v) {
      const varCfg = this.cfg.children('variation').find((c) => c.getString('variation_id') === id);
      if (!varCfg) return this;
      const base = this.cfg.clone();
      base.removeChildren('variation');
      const merged = varCfg.getBoolean('inherit', false) ? mergeUnitTypeConfig(base, varCfg) : varCfg.clone();
      merged.removeChildren('male');
      merged.removeChildren('female');
      merged.setAttribute('id', this.id);
      merged.setAttribute('variation_id', id);
      if (!merged.hasAttribute('race')) merged.setAttribute('race', this.raceId);
      v = new HelpUnitType(this.world, merged, id, this);
      this.variationTypes.set(id, v);
    }
    return v;
  }
  /** `show_variations_in_help()`: some variation is not hidden. */
  get showVariationsInHelp(): boolean {
    return this.variations.some((id) => !this.variation(id).hideHelp);
  }
  /** `genders()`. */
  get genders(): string[] {
    return this.unitType.genders.length > 0 ? [...this.unitType.genders] : ['male'];
  }
  hasGenderVariation(gender: 'male' | 'female'): boolean {
    return this.genders.includes(gender);
  }
  /** `get_gender_unit_type(FEMALE)`: the `[female]` merged over this type, or this type when it has none. */
  get female(): HelpUnitType {
    if (this.femaleType === undefined) {
      const f = this.cfg.child('female');
      if (!f || !this.hasGenderVariation('female')) this.femaleType = null;
      else {
        const base = this.cfg.clone();
        base.removeChildren('male');
        base.removeChildren('female');
        this.femaleType = new HelpUnitType(this.world, mergeUnitTypeConfig(base, f), this.variationId, this);
      }
    }
    return this.femaleType ?? this;
  }
  /** `get_gender_unit_type(MALE)`. */
  get male(): HelpUnitType {
    const m = this.cfg.child('male');
    if (!m || !this.hasGenderVariation('male')) return this;
    const base = this.cfg.clone();
    base.removeChildren('male');
    base.removeChildren('female');
    return new HelpUnitType(this.world, mergeUnitTypeConfig(base, m), this.variationId, this);
  }

  /** The engine's unit type: movetype, attacks with resolved specials, abilities, trait pool. */
  get unitType(): UnitType {
    this.built ??= this.world.buildUnitType(this.cfg);
    return this.built;
  }
  get hitpoints(): number {
    return this.unitType.hitpoints;
  }
  get movement(): number {
    return this.unitType.movement;
  }
  get vision(): number {
    return this.unitType.vision;
  }
  get jamming(): number {
    return this.unitType.jamming;
  }
  get cost(): number {
    return this.unitType.cost;
  }
  get alignment(): string {
    return this.unitType.alignment;
  }
  get maxAttacks(): number {
    return this.unitType.maxAttacksPerTurn;
  }
  get experienceNeeded(): number {
    return this.unitType.experienceNeeded();
  }
  get moveType(): MoveType {
    return this.unitType.moveType;
  }
  get numTraits(): number {
    return this.unitType.numTraits;
  }
  get possibleTraits(): readonly WmlConfig[] {
    return this.unitType.possibleTraits;
  }
  /** `can_advance()`. */
  get canAdvance(): boolean {
    return this.advancesTo.length > 0;
  }
  /** `modification_advancements()`: the `[advancement]` (AMLA) children. */
  get modificationAdvancements(): WmlConfig[] {
    return this.cfg.children('advancement');
  }
  /** `abilities_metadata()`. */
  get abilitiesMetadata(): AbilityMetadata[] {
    return this.unitType.abilities.map((e: RegistryEntry) => abilityMetadata(e.config));
  }
  /** `adv_abilities_metadata()`: abilities the AMLAs add (`[effect] apply_to=new_ability`). */
  get advAbilitiesMetadata(): AbilityMetadata[] {
    const out: AbilityMetadata[] = [];
    for (const adv of this.modificationAdvancements) {
      for (const effect of adv.children('effect')) {
        if (effect.getString('apply_to') !== 'new_ability') continue;
        const abilities = effect.child('abilities');
        if (!abilities) continue;
        for (const { config } of abilities.allChildren()) out.push(abilityMetadata(this.world.resolveAbility(config)));
      }
    }
    return out;
  }
  /** `special_notes()`: the type's own, then its abilities', its weapons' specials' and damage types', its movetype's. */
  get specialNotes(): string[] {
    const notes: string[] = [];
    const add = (note: string): void => {
      if (note.trim() === '' || notes.includes(note)) return;
      notes.push(note);
    };
    for (const n of this.cfg.children('special_note')) add(n.getString('note'));
    for (const e of this.unitType.abilities) if (e.config.hasAttribute('special_note')) add(e.config.getString('special_note'));
    for (const attack of this.unitType.attacks) {
      for (const s of attack.specials) if (s.hasAttribute('special_note')) add(s.getString('special_note'));
      add(this.world.string(`special_note_damage_type_${attack.type}`));
    }
    const mt = this.world.movetypeConfig(this.cfg.getString('movement_type'));
    for (const n of mt?.children('special_note') ?? []) add(n.getString('note'));
    return notes;
  }
}

/** A terrain type as the help sees it: upstream `terrain_type`'s help-facing fields. */
export class HelpTerrain {
  readonly id: string;
  readonly name: string;
  /** `editor_name()`: `editor_name=`, else `description()` (`description=`, else `name`). */
  readonly editorName: string;
  readonly iconImage: string;
  /** `editor_image()`: `terrain/<editor_image or symbol_image>.png`, none when hidden in the editor. */
  readonly editorImage: string;
  readonly helpTopicText: string;
  readonly hideHelp: boolean;
  readonly hideIfImpassable: boolean;
  /** `is_combined()`: a base and an overlay a map puts together, with no `[terrain_type]` of its own. */
  readonly isCombined: boolean;
  /** `default_base=`, for an overlay. */
  readonly defaultBase: TerrainCode | null;

  constructor(
    readonly code: TerrainCode,
    private readonly data: TerrainTypeData,
    cfg: WmlConfig | null,
    combined?: { base: HelpTerrain; overlay: HelpTerrain },
  ) {
    if (combined) {
      // The `terrain_type(base, overlay)` constructor.
      const { base, overlay } = combined;
      this.id = `${base.id}^${overlay.id}`;
      this.name = overlay.name;
      this.editorName = `${base.editorName} / ${overlay.editorName}`;
      this.iconImage = '';
      this.editorImage = base.editorImage && overlay.editorImage ? `${base.editorImage}~BLIT(${overlay.editorImage})` : '';
      this.helpTopicText = '';
      this.hideHelp = true;
      this.hideIfImpassable = base.hideIfImpassable || overlay.hideIfImpassable;
      this.isCombined = true;
      this.defaultBase = null;
    } else {
      const c = cfg ?? new WmlConfig();
      this.id = c.getString('id');
      this.name = c.getString('name');
      this.editorName = c.getString('editor_name') || c.getString('description') || this.name;
      this.iconImage = c.getString('icon_image');
      this.editorImage = c.getBoolean('hidden', false) ? '' : `terrain/${c.getString('editor_image') || c.getString('symbol_image')}.png`;
      this.helpTopicText = c.getString('help_topic_text');
      this.hideHelp = c.getBoolean('hide_help', false);
      this.hideIfImpassable = c.getBoolean('hide_if_impassable', false);
      this.isCombined = false;
      const d = c.getString('default_base');
      this.defaultBase = d ? parseTerrainCode(d) : null;
    }
  }
  /** `is_overlay()`: the code has no base layer. */
  get isOverlay(): boolean {
    return this.code.base === NO_LAYER;
  }
  /** `is_nonnull()`. */
  get isNonnull(): boolean {
    return !this.code.equals(NONE_TERRAIN) && !this.code.equals(VOID_TERRAIN);
  }
  private get info() {
    return this.data.findOrCreate(this.code) ?? this.data.getTerrainInfo(this.code);
  }
  get isIndivisible(): boolean {
    return this.info.isIndivisible();
  }
  get isVillage(): boolean {
    return this.info.isVillage();
  }
  get isCastle(): boolean {
    return this.info.isCastle();
  }
  get isKeep(): boolean {
    return this.info.isKeep();
  }
  get givesHealing(): number {
    return this.info.givesHealing();
  }
  get unionType(): readonly TerrainCode[] {
    return this.info.unionType;
  }
  get mvtType(): readonly TerrainCode[] {
    return this.info.mvtType;
  }
  get defType(): readonly TerrainCode[] {
    return this.info.defType;
  }
}

export class HelpWorld {
  readonly help: WmlConfig;
  private readonly strings: WmlConfig;
  private readonly types = new Map<string, HelpUnitType>();
  private readonly movetypes = new Map<string, WmlConfig>();
  private readonly weaponSpecials = new Map<string, RegistryEntry>();
  private readonly abilities = new Map<string, RegistryEntry>();
  private readonly raceCfgs = new Map<string, WmlConfig>();
  readonly globalTraits: readonly WmlConfig[];
  readonly terrainData: TerrainTypeData;
  /** Every `[terrain_type]`, in config order (`terrain_type_data::list()`). */
  readonly terrains: readonly HelpTerrain[];
  private readonly terrainsByCode = new Map<string, HelpTerrain>();
  readonly eras: readonly WmlConfig[];
  private advancesFromMap: Map<string, string[]> | undefined;

  constructor(
    readonly data: HelpData,
    readonly game: HelpGameContext = {},
  ) {
    this.help = WmlConfig.fromJSON(data.help);
    this.strings = WmlConfig.fromJSON({ attrs: data.stringTable ?? {}, children: [] });
    for (const [name, json] of Object.entries(data.movementTypeConfigs)) this.movetypes.set(name, WmlConfig.fromJSON(json));
    for (const [id, e] of Object.entries(data.weaponSpecialConfigs)) this.weaponSpecials.set(id, { tag: e.tag, config: WmlConfig.fromJSON(e.config) });
    for (const [id, e] of Object.entries(data.abilityConfigs)) this.abilities.set(id, { tag: e.tag, config: WmlConfig.fromJSON(e.config) });
    for (const [id, json] of Object.entries(data.raceConfigs)) this.raceCfgs.set(id, WmlConfig.fromJSON(json));
    this.globalTraits = data.traitConfigs.map((j) => WmlConfig.fromJSON(j));
    const terrainCfgs = data.terrainTypeConfigs.map((j) => WmlConfig.fromJSON(j));
    this.terrainData = TerrainTypeData.fromConfigs(terrainCfgs);
    const terrains = terrainCfgs.map((cfg) => new HelpTerrain(parseTerrainCode(cfg.getString('string')), this.terrainData, cfg));
    for (const t of terrains) if (!this.terrainsByCode.has(t.code.key())) this.terrainsByCode.set(t.code.key(), t);
    // The mixed terrains the current map uses, which upstream creates as the map is loaded (`find_or_create`).
    for (const s of game.mapTerrainCodes ?? []) {
      const code = parseTerrainCode(s);
      if (this.terrainsByCode.has(code.key()) || code.base === NO_LAYER || code.overlay === NO_LAYER) continue;
      const base = this.terrainsByCode.get(parseTerrainCode(s.split('^')[0]!).key());
      const overlay = this.terrainsByCode.get(new TerrainCodeCtor(NO_LAYER, code.overlay).key());
      if (!base || !overlay) continue;
      const t = new HelpTerrain(code, this.terrainData, null, { base, overlay });
      terrains.push(t);
      this.terrainsByCode.set(code.key(), t);
    }
    this.terrains = terrains;
    this.eras = data.eraConfigs.map((j) => WmlConfig.fromJSON(j));
  }

  /** `string_table[key]`, translated; `''` when there is no such entry. */
  string(key: string): string {
    return this.strings.getString(key);
  }

  /** Every unit type id, in upstream's `unit_types.types()` order (a `std::map`, so sorted by id). */
  typeIds(): string[] {
    return Object.keys(this.data.unitTypeConfigs).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** `unit_types.find(id)`. */
  unitType(id: string): HelpUnitType | undefined {
    let t = this.types.get(id);
    if (!t) {
      const json = this.data.unitTypeConfigs[id];
      if (!json) return undefined;
      t = new HelpUnitType(this, WmlConfig.fromJSON(json));
      this.types.set(id, t);
    }
    return t;
  }

  buildUnitType(cfg: WmlConfig): UnitType {
    return UnitType.fromConfig(cfg, this.movetypes, this.terrainData, { weaponSpecials: this.weaponSpecials, abilities: this.abilities });
  }

  movetypeConfig(name: string): WmlConfig | undefined {
    return this.movetypes.get(name);
  }

  /** An ability config as written, or the registry's when it only names one (`abilities_list=`-style shorthand). */
  resolveAbility(cfg: WmlConfig): WmlConfig {
    if (cfg.getString('name')) return cfg;
    return this.abilities.get(cfg.getString('id'))?.config ?? cfg;
  }

  /** `unit_types.find_race(id)`. */
  race(id: string): WmlConfig | undefined {
    return this.raceCfgs.get(id);
  }
  raceIds(): string[] {
    return [...this.raceCfgs.keys()];
  }
  /** `unit_race::plural_name()`. */
  racePluralName(id: string): string {
    return this.race(id)?.getString('plural_name') ?? '';
  }

  advancesFrom(id: string): string[] {
    if (!this.advancesFromMap) {
      const map = new Map<string, string[]>();
      for (const from of this.typeIds()) {
        for (const to of this.unitType(from)!.advancesTo) {
          if (!map.has(to)) map.set(to, []);
          map.get(to)!.push(from);
        }
      }
      this.advancesFromMap = map;
    }
    return this.advancesFromMap.get(id) ?? [];
  }

  /** `tdata->get_terrain_info(code)` for a code that has a `[terrain_type]`. */
  terrain(code: TerrainCode): HelpTerrain | undefined {
    return this.terrainsByCode.get(code.key());
  }
  terrainList(s: string): TerrainCode[] {
    return parseTerrainList(s);
  }

  /** The current schedule, in a game. */
  get times(): readonly TimeOfDayEntry[] | undefined {
    return this.game.times;
  }
}
