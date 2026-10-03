/** `fallback_ai_to_human_exception`: thrown by `ai.fallback_human()`, ends the AI's turn and gives the side to a human. */
export class FallbackAiToHumanError extends Error {
  constructor() {
    super('ai.fallback_human');
  }
}
