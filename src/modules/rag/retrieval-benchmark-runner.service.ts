import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { retrieveContextChatbotEvidence } from "@/modules/rag/context-chatbot-retrieval.service";
import { listProjectKnowledgeBenchmarkCases } from "@/modules/rag/project-knowledge-benchmark.service";
import {
  reciprocalRank,
  recallAtK,
  summarizeBenchmarkRun,
  type BenchmarkRunSummary,
} from "@/modules/rag/retrieval-benchmark-scorer";

// Mirrors context-chatbot.service.ts's real retrieval call (its CONTEXT_CANDIDATE_LIMIT /
// KNOWLEDGE_CANDIDATE_LIMIT / maxContextChunksPerWorkItem) so this measures the same
// retrieval config the Business Owner Assistant actually uses, before evidence-budget's
// later token-cost trimming — a prompt-size concern, unrelated to ranking quality.
const CONTEXT_CANDIDATE_LIMIT = 40;
const KNOWLEDGE_CANDIDATE_LIMIT = 120;
const MAX_CONTEXT_CHUNKS_PER_WORK_ITEM = 2;

export type RetrievalBenchmarkCaseResult = {
  caseId: string;
  question: string;
  expectedWorkItemId: string;
  rankedWorkItemIds: string[];
  recallAt1: boolean;
  reciprocalRank: number;
};

export type RetrievalBenchmarkRunResult = {
  caseCount: number;
  results: RetrievalBenchmarkCaseResult[];
  summary: BenchmarkRunSummary;
};

/**
 * Scores the real retrieval path against every labeled benchmark case for a project:
 * for each collected, human-labeled question, runs the same retrieval the Business
 * Owner Assistant uses and checks whether the admin-specified expected work item comes
 * back, and how highly ranked it is. Unlabeled cases are excluded (there is nothing to
 * score them against) — see project-knowledge-benchmark.service.ts's labeledOnly filter.
 */
export async function runRetrievalBenchmark(input: { scope: ProjectScope }): Promise<RetrievalBenchmarkRunResult> {
  const scope = assertProjectScope(input.scope);
  const labeledCases = await listProjectKnowledgeBenchmarkCases({ scope, labeledOnly: true, limit: 500 });

  const results: RetrievalBenchmarkCaseResult[] = [];
  for (const benchmarkCase of labeledCases) {
    // Guaranteed by labeledOnly, but keeps the result type's expectedWorkItemId non-nullable.
    if (!benchmarkCase.expectedWorkItemId) continue;

    const evidence = await retrieveContextChatbotEvidence({
      scope,
      query: benchmarkCase.question,
      contextLimit: CONTEXT_CANDIDATE_LIMIT,
      knowledgeLimit: KNOWLEDGE_CANDIDATE_LIMIT,
      maxContextChunksPerWorkItem: MAX_CONTEXT_CHUNKS_PER_WORK_ITEM,
    });
    const rankedWorkItemIds = dedupeWorkItemIds(evidence.context.map((item) => item.workItemId));

    results.push({
      caseId: benchmarkCase.id,
      question: benchmarkCase.question,
      expectedWorkItemId: benchmarkCase.expectedWorkItemId,
      rankedWorkItemIds,
      recallAt1: recallAtK(rankedWorkItemIds, benchmarkCase.expectedWorkItemId, 1),
      reciprocalRank: reciprocalRank(rankedWorkItemIds, benchmarkCase.expectedWorkItemId),
    });
  }

  const summary = summarizeBenchmarkRun(
    results.map((result) => ({ rankedWorkItemIds: result.rankedWorkItemIds, expectedWorkItemId: result.expectedWorkItemId })),
  );

  return { caseCount: results.length, results, summary };
}

/**
 * Evidence chunks are per-chunk, so the same work item can appear up to
 * MAX_CONTEXT_CHUNKS_PER_WORK_ITEM times. Recall/MRR are about work-item rank, so
 * collapse to first-occurrence order — otherwise a duplicate could occupy a top-k slot
 * a different, lower-ranked work item should have counted against.
 */
function dedupeWorkItemIds(workItemIds: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const id of workItemIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
  }
  return deduped;
}
