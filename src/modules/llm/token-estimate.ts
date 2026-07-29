import "server-only";

/**
 * Shared, deliberately crude token estimation for prompt budgeting.
 *
 * A real tokenizer would have to match whichever provider the user configured, which
 * is not knowable here. Every consumer applies a safety margin on top, so being wrong
 * in the conservative direction costs nothing.
 */
const CHARS_PER_TOKEN = 4;

/** Fraction of a model's input limit a prompt may plan to occupy. */
export const PROMPT_BUDGET_SAFETY_FRACTION = 0.9;

/** Applied when the configured model's input limit is unknown. */
export const FALLBACK_MAX_INPUT_TOKENS = 16_000;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** The share of a model's window a prompt may spend, after its safety margin. */
export function usableInputTokens(maxInputTokens?: number): number {
  const limit =
    typeof maxInputTokens === "number" && Number.isFinite(maxInputTokens) && maxInputTokens > 0
      ? Math.floor(maxInputTokens)
      : FALLBACK_MAX_INPUT_TOKENS;
  return Math.floor(limit * PROMPT_BUDGET_SAFETY_FRACTION);
}
