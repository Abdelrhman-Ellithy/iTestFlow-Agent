import "server-only";

import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import { createEmbeddingProvider } from "./embedding-provider";
import { searchProjectKnowledgeByEmbedding } from "./embedding-store.service";

/**
 * Ranks compiled knowledge entries against the work item a workflow is reasoning about,
 * using the entry embeddings that already exist.
 *
 * Workflow prompts rank knowledge by keyword overlap. That is adequate only while the
 * whole knowledge base fits in the window and ranking merely decides ordering. Once the
 * corpus outgrows the budget, ranking decides *inclusion*, and keyword overlap is a poor
 * instrument for it: a rule phrased "authorisation" never surfaces for a work item about
 * "permissions", and the excluded rule is invisible — there is no signal in the output
 * that a relevant condition was dropped.
 *
 * Knowledge entries are already embedded for the Business Owner Assistant
 * (`source_type = 'project_knowledge_entry'`), so this reuses those vectors rather than
 * introducing an index. Returns entry keys in relevance order, which the prompt renderer
 * applies as an ordering override.
 *
 * Degrades to `null` on any failure, which leaves the caller on keyword ranking. Better
 * ordering is an improvement, never a dependency.
 */

/** Matches the synthetic id used when knowledge entries are embedded. */
export type RankedKnowledgeKeys = Partial<Record<
  "modules" | "businessRules" | "stateTransitions" | "glossary" | "crossDependencies",
  string[]
>>;

const CATEGORY_BY_STORED_NAME: Record<string, keyof RankedKnowledgeKeys> = {
  module: "modules",
  business_rule: "businessRules",
  state_transition: "stateTransitions",
  glossary: "glossary",
  dependency: "crossDependencies",
};

/**
 * How many entries to rank. Generous because this only reorders what the token budget
 * later trims — the cost is one query embedding plus an in-process scan the assistant
 * already performs per message.
 */
const MAX_RANKED_ENTRIES = 500;

export async function rankProjectKnowledgeByRelevance(input: {
  scope: ProjectScope;
  /** Text of the work item under analysis, plus any related context. */
  queryText: string;
}): Promise<RankedKnowledgeKeys | null> {
  const queryText = input.queryText.trim();
  if (!queryText) return null;

  try {
    const ranked = await searchProjectKnowledgeByEmbedding({
      scope: input.scope,
      provider: createEmbeddingProvider(),
      query: queryText,
      topK: MAX_RANKED_ENTRIES,
    });
    if (!ranked.length) return null;

    const byCategory: RankedKnowledgeKeys = {};
    for (const entry of ranked) {
      const category = CATEGORY_BY_STORED_NAME[entry.category];
      if (!category) continue;
      (byCategory[category] ??= []).push(entry.entry_key);
    }
    return Object.keys(byCategory).length ? byCategory : null;
  } catch (error) {
    // Keyword ranking remains correct, just less discerning.
    console.error("Semantic knowledge ranking failed; falling back to keyword ranking.", error);
    return null;
  }
}
