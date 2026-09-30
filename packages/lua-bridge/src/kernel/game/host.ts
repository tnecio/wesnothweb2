/**
 * What the game kernel's modules need from the game: the event context (board, variables, schedule, unit
 * types, action registry, ...) and a way to suspend the running Lua coroutine while an engine flow runs (a
 * WML event fired from Lua, a dialog). `LuaRuntime` provides both.
 */
import type { EventContext } from '@wesnothweb2/engine/src/events/context.js';
import type { Flow } from '@wesnothweb2/engine/src/events/interaction.js';
import type { LuaState } from '../kernel.js';

export interface GameKernelHost {
  ctx(): EventContext;
  /** `return host.yieldFlow(T, flow)` from a C function: runs `flow`, then resumes Lua with its result. */
  yieldFlow(T: LuaState, flow: Flow<unknown>): number;
  /** `wesnoth.current.side`: the side whose turn it is (or whose AI is playing). */
  currentSide(): number;
}
