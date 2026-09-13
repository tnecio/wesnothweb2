/** Mirrors `ai::target`/`ai_target::type` (`src/ai/ai_target.hpp`, `src/ai/default/contexts.hpp`). */

import type { Location } from '../../model/Location.js';

export type TargetType = 'village' | 'threat' | 'leader' | 'xplicit' | 'support' | 'mass' | 'battle_aid';

export interface Target {
  readonly loc: Location;
  value: number;
  readonly type: TargetType;
}
