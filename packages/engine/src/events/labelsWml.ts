/**
 * Phase 18: map labels (`map/label.cpp`'s `map_labels`/`terrain_label`,
 * `[label]` in `wml-tags.lua`). One label per hex per team name (`""` for
 * a global label); setting empty text removes it. A scenario's own
 * `[label]`s are read when it starts, and labels are saved with the game.
 */
import { WmlConfig } from '../wml/config.js';
import type { EventContext } from './context.js';
import { Location } from '../model/Location.js';
import { findLocations } from './filter.js';

export interface MapLabel {
  readonly loc: Location;
  readonly text: string;
  readonly tooltip: string;
  /** `""`: a global label, seen by everyone the team labels on its hex do not cover. */
  readonly teamName: string;
  /** `r,g,b`; white (`font::LABEL_COLOR`) unless given. */
  readonly color: string;
  readonly visibleInFog: boolean;
  readonly visibleInShroud: boolean;
  readonly immutable: boolean;
  readonly category: string;
  /** The side that made it, or -1 (`creator_ + 1` as saved: 0). */
  readonly creator: number;
}

export const LABEL_COLOR = '255,255,255';

export class LabelStore {
  private readonly byTeam = new Map<string, Map<string, MapLabel>>();

  get(loc: Location, teamName: string): MapLabel | undefined {
    return this.byTeam.get(teamName)?.get(loc.key());
  }

  all(): MapLabel[] {
    return [...this.byTeam.values()].flatMap((m) => [...m.values()]);
  }

  clear(): void {
    this.byTeam.clear();
  }

  /** `map_labels::clear`: this team's labels and the global ones -- only the mutable ones unless `force`. */
  clearTeam(teamName: string, force: boolean): void {
    for (const name of new Set([teamName, ''])) {
      const map = this.byTeam.get(name);
      if (!map) continue;
      for (const [key, label] of map) if (force || !label.immutable) map.delete(key);
    }
  }

  /** `map_labels::set_label`: replaces this team's label on the hex, or removes it when the text is empty. */
  set(label: MapLabel): void {
    const map = this.byTeam.get(label.teamName);
    if (label.text === '') {
      map?.delete(label.loc.key());
      return;
    }
    if (map) map.set(label.loc.key(), label);
    else this.byTeam.set(label.teamName, new Map([[label.loc.key(), label]]));
  }
}

/** `terrain_label::read`: a label from its config (variables already substituted). */
export function labelFromConfig(cfg: WmlConfig, ctx: EventContext, loc = Location.fromWml(cfg.getNumber('x'), cfg.getNumber('y'))): MapLabel {
  let creator = -1;
  const side = cfg.getString('side', '');
  if (side === 'current') creator = ctx.variables.getNumber('side_number', 0) || -1;
  else if (side !== '' && Number(side) > 0) creator = Number(side);
  return {
    loc,
    text: cfg.getString('text', ''),
    tooltip: cfg.getString('tooltip', ''),
    teamName: cfg.getString('team_name', ''),
    color: normalizeColor(cfg.getString('color', '')),
    visibleInFog: cfg.getBoolean('visible_in_fog', true),
    visibleInShroud: cfg.getBoolean('visible_in_shroud', false),
    immutable: cfg.getBoolean('immutable', true),
    category: cfg.getString('category', ''),
    creator,
  };
}

/** `color_t::from_rgb_string` (or the old `r,g,b,a`): as `r,g,b`, white when absent or unreadable. */
function normalizeColor(raw: string): string {
  const parts = raw.split(',').map((p) => Number(p.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return LABEL_COLOR;
  return parts.slice(0, 3).map((n) => Math.max(0, Math.min(255, Math.round(n)))).join(',');
}

/** `terrain_label::write`. */
export function labelToConfig(label: MapLabel): WmlConfig {
  const out = new WmlConfig();
  out.setAttribute('x', label.loc.wmlX);
  out.setAttribute('y', label.loc.wmlY);
  out.setAttribute('text', label.text);
  out.setAttribute('tooltip', label.tooltip);
  out.setAttribute('team_name', label.teamName);
  out.setAttribute('color', label.color);
  out.setAttribute('visible_in_fog', label.visibleInFog);
  out.setAttribute('visible_in_shroud', label.visibleInShroud);
  out.setAttribute('immutable', label.immutable);
  out.setAttribute('category', label.category);
  out.setAttribute('side', label.creator < 0 ? 0 : label.creator);
  return out;
}

/** `wml_actions.label`: the label on every hex the tag matches. */
export function actionLabel(cfg: WmlConfig, ctx: EventContext): void {
  const parsed = ctx.variables.expandConfigDeep(cfg);
  for (const loc of findLocations(ctx.board, parsed)) ctx.labels.set(labelFromConfig(parsed, ctx, loc));
}
