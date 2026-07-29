import {
  estimateTokens,
  FALLBACK_MAX_INPUT_TOKENS,
  usableInputTokens,
} from "@/modules/llm/token-estimate";

export { estimateTokens, FALLBACK_MAX_INPUT_TOKENS };

/**
 * Chooses how much retrieved evidence to put in the prompt, by token budget rather
 * than by a fixed item count.
 *
 * The assistant previously sent a hard-coded 10 context chunks and 10 knowledge
 * entries regardless of the model. On a real project that meant 10 of 213 compiled
 * knowledge entries — about 5% — reached the model, while the entire compiled
 * knowledge base is roughly 8k tokens and would fit comfortably in any modern context
 * window. Questions asking for a complete picture ("what are all the roles?") were
 * therefore answered from a similarity-selected slice, which invites the model to fill
 * the gaps by inference.
 *
 * The model's input limit is already configured per user (AI provider settings), the
 * system prompt is a constant, and the history and question are known before
 * retrieval is assembled — so the space actually available for evidence is
 * computable. Fill it.
 */


/**
 * Floors, so a long conversation or an unusually large system prompt can never
 * squeeze evidence out entirely. Answering from too little context is bad; answering
 * from none while claiming to be source-grounded is worse.
 */
const MIN_CONTEXT_ITEMS = 3;
const MIN_KNOWLEDGE_ITEMS = 3;

/**
 * Share of the evidence budget offered to compiled knowledge before raw context.
 * Knowledge entries are curated, deduplicated and citation-backed, and they are small
 * (a few hundred characters), so they buy more grounding per token than raw chunks.
 * Anything this share does not use is handed to context, and vice versa — the split is
 * a starting preference, not a reservation.
 */
const KNOWLEDGE_BUDGET_SHARE = 0.5;

export type BudgetedEvidence<TContext, TKnowledge> = {
  context: TContext[];
  knowledge: TKnowledge[];
  /** Reported in audit metadata so budget behaviour is observable in production. */
  budget: {
    maxInputTokens: number;
    fixedCostTokens: number;
    evidenceBudgetTokens: number;
    usedTokens: number;
    contextConsidered: number;
    knowledgeConsidered: number;
  };
};

/**
 * Trims already-ranked evidence to what fits alongside the fixed prompt cost.
 *
 * Both lists must arrive in descending relevance order — this only decides how far
 * down each list to go, never what is more relevant.
 */
export function selectEvidenceWithinBudget<TContext, TKnowledge>(input: {
  /** Everything in the prompt that is not retrieved evidence: system prompt, history, question, scaffolding. */
  fixedPromptText: string;
  context: TContext[];
  knowledge: TKnowledge[];
  renderContext: (item: TContext) => string;
  renderKnowledge: (item: TKnowledge) => string;
  /** From the user's configured model; falls back when the model is unknown. */
  maxInputTokens?: number;
}): BudgetedEvidence<TContext, TKnowledge> {
  const maxInputTokens = normalizePositiveInt(input.maxInputTokens) ?? FALLBACK_MAX_INPUT_TOKENS;
  const fixedCostTokens = estimateTokens(input.fixedPromptText);
  const evidenceBudgetTokens = Math.max(0, usableInputTokens(maxInputTokens) - fixedCostTokens);

  const knowledge = fill(
    input.knowledge,
    input.renderKnowledge,
    Math.floor(evidenceBudgetTokens * KNOWLEDGE_BUDGET_SHARE),
    MIN_KNOWLEDGE_ITEMS,
  );
  // Context gets everything knowledge left behind, not just its nominal half.
  const context = fill(
    input.context,
    input.renderContext,
    evidenceBudgetTokens - knowledge.usedTokens,
    MIN_CONTEXT_ITEMS,
  );

  return {
    context: context.items,
    knowledge: knowledge.items,
    budget: {
      maxInputTokens,
      fixedCostTokens,
      evidenceBudgetTokens,
      usedTokens: knowledge.usedTokens + context.usedTokens,
      contextConsidered: input.context.length,
      knowledgeConsidered: input.knowledge.length,
    },
  };
}

/**
 * Takes items in rank order while they fit. `minItems` is honoured even when the
 * budget is already exhausted, so evidence is never empty purely because the fixed
 * prompt cost was large; a single oversized item is likewise kept rather than skipped,
 * because skipping it would silently promote a less relevant one in its place.
 */
function fill<TItem>(
  items: TItem[],
  render: (item: TItem) => string,
  budgetTokens: number,
  minItems: number,
): { items: TItem[]; usedTokens: number } {
  const selected: TItem[] = [];
  let usedTokens = 0;
  for (const item of items) {
    const cost = estimateTokens(render(item));
    const withinBudget = usedTokens + cost <= budgetTokens;
    if (!withinBudget && selected.length >= minItems) break;
    selected.push(item);
    usedTokens += cost;
  }
  return { items: selected, usedTokens };
}

function normalizePositiveInt(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}
