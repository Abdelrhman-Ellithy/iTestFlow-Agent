import { describe, expect, it } from "vitest";

import {
  estimateTokens,
  FALLBACK_MAX_INPUT_TOKENS,
  selectEvidenceWithinBudget,
} from "./evidence-budget";

/**
 * Evidence used to be a hard-coded 10 items per source regardless of model. On a real
 * project that sent 10 of 213 compiled knowledge entries — ~5% — to a model whose
 * window could have held all of them.
 */
const render = (item: { text: string }) => item.text;
const items = (count: number, chars: number, prefix = "i") =>
  Array.from({ length: count }, (_, index) => ({ text: `${prefix}${index}${"x".repeat(chars)}` }));

function select(overrides: Partial<Parameters<typeof selectEvidenceWithinBudget>[0]> = {}) {
  return selectEvidenceWithinBudget({
    fixedPromptText: "",
    context: items(50, 400, "c"),
    knowledge: items(200, 400, "k"),
    renderContext: render,
    renderKnowledge: render,
    maxInputTokens: 128_000,
    ...overrides,
  } as Parameters<typeof selectEvidenceWithinBudget>[0]);
}

describe("selectEvidenceWithinBudget", () => {
  it("sends far more than the old fixed ten when the window allows it", () => {
    const result = select();
    expect(result.knowledge.length).toBeGreaterThan(10);
    expect(result.context.length).toBeGreaterThan(10);
  });

  it("scales down for a small model instead of overflowing it", () => {
    const large = select({ maxInputTokens: 128_000 });
    const small = select({ maxInputTokens: 8_000 });

    expect(small.knowledge.length).toBeLessThan(large.knowledge.length);
    expect(small.context.length).toBeLessThan(large.context.length);
    // Never exceeds the configured window (a safety margin is held back on purpose).
    expect(small.budget.usedTokens).toBeLessThanOrEqual(8_000);
  });

  it("charges the fixed prompt cost against the evidence budget", () => {
    const cheap = select({ maxInputTokens: 20_000, fixedPromptText: "" });
    const expensive = select({ maxInputTokens: 20_000, fixedPromptText: "h".repeat(40_000) });

    expect(expensive.budget.fixedCostTokens).toBeGreaterThan(cheap.budget.fixedCostTokens);
    expect(expensive.budget.evidenceBudgetTokens).toBeLessThan(cheap.budget.evidenceBudgetTokens);
  });

  it("never returns empty evidence, even when the fixed prompt consumes the window", () => {
    // A long conversation must degrade how much evidence is sent, not whether any is.
    // Grounding on nothing while claiming to be source-restricted is the worst outcome.
    const result = select({ maxInputTokens: 1_000, fixedPromptText: "h".repeat(100_000) });
    expect(result.budget.evidenceBudgetTokens).toBe(0);
    expect(result.context.length).toBeGreaterThan(0);
    expect(result.knowledge.length).toBeGreaterThan(0);
  });

  it("gives context whatever knowledge did not use", () => {
    // Knowledge has a nominal half-share; when it is nearly empty the rest must not be
    // wasted, or a knowledge-poor project would silently under-fill the window.
    const withKnowledge = select({ maxInputTokens: 6_000 });
    const withoutKnowledge = select({ maxInputTokens: 6_000, knowledge: [] });
    expect(withKnowledge.context.length).toBeLessThan(withoutKnowledge.context.length);
    // ...and the spill is real: context alone now uses more than its nominal half.
    expect(withoutKnowledge.budget.usedTokens)
      .toBeGreaterThan(Math.floor(withoutKnowledge.budget.evidenceBudgetTokens * 0.5));
  });

  it("falls back to a conservative window when the model's limit is unknown", () => {
    const unknown = select({ maxInputTokens: undefined });
    expect(unknown.budget.maxInputTokens).toBe(FALLBACK_MAX_INPUT_TOKENS);

    // Nonsense values are treated as unknown rather than trusted.
    expect(select({ maxInputTokens: 0 }).budget.maxInputTokens).toBe(FALLBACK_MAX_INPUT_TOKENS);
    expect(select({ maxInputTokens: -5 }).budget.maxInputTokens).toBe(FALLBACK_MAX_INPUT_TOKENS);
    expect(select({ maxInputTokens: Number.NaN }).budget.maxInputTokens).toBe(FALLBACK_MAX_INPUT_TOKENS);
  });

  it("preserves the relevance order it was given", () => {
    // This decides how far down each ranked list to go — never what ranks higher.
    const result = select({ maxInputTokens: 20_000 });
    expect(result.knowledge.slice(0, 3).map((item) => (item as { text: string }).text.slice(0, 3)))
      .toEqual(["k0x", "k1x", "k2x"]);
  });

  it("keeps a single oversized item rather than skipping to a less relevant one", () => {
    const result = select({
      maxInputTokens: 2_000,
      knowledge: [{ text: "z".repeat(100_000) }, { text: "small" }],
      context: [],
    });
    expect(result.knowledge[0]!.text.startsWith("z")).toBe(true);
  });

  it("reports what it considered, for observability", () => {
    const result = select({ maxInputTokens: 8_000 });
    expect(result.budget.knowledgeConsidered).toBe(200);
    expect(result.budget.contextConsidered).toBe(50);
    expect(result.knowledge.length).toBeLessThan(result.budget.knowledgeConsidered);
  });

  it("estimates tokens from character length", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("x".repeat(400))).toBe(100);
  });
});
