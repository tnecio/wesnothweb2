/**
 * The scenario's `[tunnel]`s (`pathfind::manager`, teleport.cpp) -- kept
 * dependency-free so `GameBoard` can own one. Evaluating tunnels for a
 * unit is `teleport.ts`'s job.
 */
import type { WmlConfig } from '../wml/config.js';

const REVERSED_SUFFIX = '-__REVERSED__';

/** `teleport_group`: one direction of a tunnel. */
export interface TeleportGroup {
  readonly cfg: WmlConfig;
  /** A bidirectional tunnel's way back: `[source]` and `[target]` swap roles. */
  readonly reversed: boolean;
  readonly id: string;
}

/** `pathfind::manager`: the scenario's `[tunnel]`s. */
export class TunnelManager {
  private groups: TeleportGroup[] = [];
  private nextId = 0;

  /** The `[tunnel]` tag (action_wml.cpp): adds the tunnel, and its reverse unless `bidirectional=no`. Ignores a tunnel missing (or doubling) `[source]`/`[target]`/`[filter]`, as upstream logs and skips it. */
  addFromWml(cfg: WmlConfig): void {
    for (const tag of ['source', 'target', 'filter']) if (cfg.children(tag).length !== 1) return;
    const explicitId = cfg.getString('id', '');
    const id = explicitId || String(++this.nextId);
    this.groups.push({ cfg, reversed: false, id });
    if (cfg.getBoolean('bidirectional', true)) {
      this.groups.push({ cfg, reversed: true, id: explicitId ? id + REVERSED_SUFFIX : String(++this.nextId) });
    }
  }

  /** `[tunnel] remove=yes id=`: drops both directions of each named tunnel. */
  remove(id: string): void {
    this.groups = this.groups.filter((g) => g.id !== id && g.id !== id + REVERSED_SUFFIX);
  }

  all(): readonly TeleportGroup[] {
    return this.groups;
  }

  /** For saves: each tunnel with `saved`/`reversed`/`id` set, as `manager::to_config` writes them. */
  toConfigs(): WmlConfig[] {
    return this.groups.map((g) => {
      const cfg = g.cfg.clone();
      cfg.setAttribute('saved', true);
      cfg.setAttribute('reversed', g.reversed);
      cfg.setAttribute('id', g.id);
      return cfg;
    });
  }

  /** Restores `toConfigs` output (`manager(const config&)`). */
  loadConfigs(cfgs: readonly WmlConfig[], nextId: number): void {
    this.groups = cfgs.map((cfg) => ({ cfg, reversed: cfg.getBoolean('reversed', false), id: cfg.getString('id', '') }));
    this.nextId = nextId;
  }

  get nextTeleportGroupId(): number {
    return this.nextId;
  }
}

