/**
 * Pure recall/MRR scoring for a set of (ranked retrieval result, expected work
 * item) pairs. Generalizes the recall@1 check in
 * embedding-retrieval.quality.db.test.ts into reusable functions so the same
 * scoring logic can run against the real labeled corpus (see
 * retrieval-benchmark-runner.service.ts) instead of only three hand-written
 * fixtures — and so the numbers stay comparable release to release.
 *
 * No DB or server-only import: this module is scored by the coverage gate as
 * ordinary pure logic.
 */

export const DEFAULT_BENCHMARK_RECALL_K_VALUES = [1, 3, 5, 10];

/** Is `expectedWorkItemId` within the first `k` entries of `rankedWorkItemIds`? */
export function recallAtK(rankedWorkItemIds: string[], expectedWorkItemId: string, k: number): boolean {
  // Guards negative k too: Array.slice treats a negative end as "from the end",
  // which would wrongly keep matching entries a caller intended to exclude.
  if (k <= 0) return false;
  return rankedWorkItemIds.slice(0, k).includes(expectedWorkItemId);
}

/** 1/(position+1) if `expectedWorkItemId` appears in `rankedWorkItemIds`, else 0. */
export function reciprocalRank(rankedWorkItemIds: string[], expectedWorkItemId: string): number {
  const position = rankedWorkItemIds.indexOf(expectedWorkItemId);
  return position === -1 ? 0 : 1 / (position + 1);
}

export type BenchmarkResultCase = {
  rankedWorkItemIds: string[];
  expectedWorkItemId: string;
};

export type BenchmarkRunSummary = {
  mrr: number;
  recallAtK: Record<number, number>;
};

/** Aggregate MRR and recall@k (for each of `kValues`) across every case. Empty input scores 0 everywhere. */
export function summarizeBenchmarkRun(
  results: BenchmarkResultCase[],
  kValues: number[] = DEFAULT_BENCHMARK_RECALL_K_VALUES,
): BenchmarkRunSummary {
  const recallAtKSummary: Record<number, number> = {};
  for (const k of kValues) {
    const hits = results.filter((result) => recallAtK(result.rankedWorkItemIds, result.expectedWorkItemId, k)).length;
    recallAtKSummary[k] = results.length ? hits / results.length : 0;
  }

  const reciprocalRankSum = results.reduce(
    (sum, result) => sum + reciprocalRank(result.rankedWorkItemIds, result.expectedWorkItemId),
    0,
  );

  return {
    mrr: results.length ? reciprocalRankSum / results.length : 0,
    recallAtK: recallAtKSummary,
  };
}
