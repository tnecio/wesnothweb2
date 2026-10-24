/**
 * Builds a game Lua kernel in upstream's order (`lua_kernel_base` constructor, then `game_lua_kernel`'s, then
 * `load_core`): the base API, `lua/package.lua`, ilua strict mode, the game API, and `data/lua/core`.
 */
import type { Rng } from '@wesnothweb2/engine/src/rng/Rng.js';
import { LuaKernel, type KernelLog, type VirtualDataDir } from './kernel.js';
import { BASE_GAME_CONFIG, installBase, installPackage, installStrictMode, loadCore, type GameConfigValues } from './base.js';
import { installMathx, installStringx } from './stringx.js';
import type { GameKernelHost } from './game/host.js';
import { LuaUnits } from './game/units.js';
import { installWorld, type WorldOptions } from './game/world.js';
import { installPaths } from './game/paths.js';
import { installMisc } from './game/misc.js';

export { LuaKernel, type KernelLog, type VirtualDataDir } from './kernel.js';
export type { GameKernelHost } from './game/host.js';
export { LuaUnits } from './game/units.js';

export interface GameKernelOptions extends WorldOptions {
  readonly files: VirtualDataDir;
  readonly log: KernelLog;
  /** `randomness::generator`: the game's current RNG (synced inside an action). */
  readonly rng: () => Rng;
  readonly gameConfig?: () => GameConfigValues;
  /** Runs between the game API and `load_core` (`LuaRuntime` installs its WML-action proxy here). */
  readonly beforeCore?: (k: LuaKernel, units: LuaUnits) => void;
  /**
   * A unit test (`[test] is_unit_test=yes`, `game_classification::is_test`): the `unit_test` table exists before
   * `load_core`, so `lua/core/unit_test.lua` fills in its helpers (`unit_test.assert`, `succeed`...).
   */
  readonly unitTest?: boolean;
}

export interface GameKernel {
  readonly kernel: LuaKernel;
  readonly units: LuaUnits;
}

export function createGameKernel(host: GameKernelHost, options: GameKernelOptions): GameKernel {
  const k = new LuaKernel(options.files, options.log);
  installStringx(k);
  installMathx(k, options.rng);
  installBase(k, options.gameConfig ?? (() => BASE_GAME_CONFIG));
  installPackage(k);
  installStrictMode(k);
  const units = new LuaUnits(k, host);
  units.install();
  installWorld(k, host, units, options);
  installPaths(k, host, units);
  installMisc(k, host, units);
  options.beforeCore?.(k, units);
  // `fire_wml_menu_item`, the one native function upstream puts in it, is not ported.
  if (options.unitTest) k.run('rawset(_G, "unit_test", {})', '=unit_test');
  loadCore(k);
  return { kernel: k, units };
}
