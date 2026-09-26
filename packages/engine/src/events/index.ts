/**
 * Public surface of the WML event system port (see pump.ts's module doc
 * comment for the full scope/limitations rundown).
 */

export { VariableStore, newVarNode, varNodeFromConfig, varNodeToConfig } from './variables.js';
export type { VarNode } from './variables.js';

export { unitMatchesFilter, findUnits, locationMatchesFilter, locationMatchesFilterOnBoard, findLocations, unitFormulaContext } from './filter.js';

export { conditionalPassed, builtinConditions, setLuaConditionalEvaluator, type LuaConditionalEvaluator } from './conditionalWml.js';

export { ActionRegistry } from './context.js';
export type { ActionHandler, EventContext, EndLevelState, ExitState, RecordedMessage, MenuItemDef, ChoiceRecord } from './context.js';

export { parseScenarioObjectives, turnCounterSuffix, OBJECTIVE_COLOR } from './objectives.js';
export type { ScenarioObjectives, ScenarioObjectiveEntry, GoldCarryoverEntry, ObjectiveCondition } from './objectives.js';

export { createDefaultActionRegistry, runActionSequence, runActionFlow, applySetVariable, effectEnvFor } from './actionWml.js';

export { runFlow, autoRespond, isFlow } from './interaction.js';
export type { Interaction, MessageInteraction, BeatInteraction, CutsceneBeat, FakeUnitSpec, FakeUnitWalk, InteractionResult, MessageOption, TextInputSpec, Flow, Responder } from './interaction.js';

export { EventManager, EventPump, standardizeEventName } from './pump.js';
export type { WmlEventHandler, QueuedEvent, EventPumpOptions } from './pump.js';
export { findSides, sideMatchesFilter } from './sideFilter.js';
