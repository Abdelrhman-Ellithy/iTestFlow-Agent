import { describe, expect, it } from "vitest";

import { reciprocalRank, recallAtK, summarizeBenchmarkRun } from "./retrieval-benchmark-scorer";

describe("recallAtK", () => {
  it("is true when the expected id is within the first k entries", () => {
    expect(recallAtK(["a", "b", "c"], "a", 1)).toBe(true);
    expect(recallAtK(["a", "b", "c"], "c", 3)).toBe(true);
  });

  it("is false when the expected id is present but beyond k", () => {
    expect(recallAtK(["a", "b", "c"], "c", 2)).toBe(false);
  });

  it("is false when the expected id is absent entirely", () => {
    expect(recallAtK(["a", "b", "c"], "z", 10)).toBe(false);
  });

  it("is false for an empty ranked list", () => {
    expect(recallAtK([], "a", 5)).toBe(false);
  });

  it("is false for k <= 0, including negative k (never treats it as 'from the end')", () => {
    expect(recallAtK(["a", "b", "c"], "a", 0)).toBe(false);
    expect(recallAtK(["a", "b", "c"], "c", -1)).toBe(false);
  });
});

describe("reciprocalRank", () => {
  it("scores 1 for a first-place match", () => {
    expect(reciprocalRank(["a", "b", "c"], "a")).toBe(1);
  });

  it("scores 1/(position+1) for a later match", () => {
    expect(reciprocalRank(["a", "b", "c", "d"], "c")).toBeCloseTo(1 / 3);
    expect(reciprocalRank(["a", "b", "c", "d", "e"], "e")).toBeCloseTo(1 / 5);
  });

  it("scores 0 when the expected id is not found", () => {
    expect(reciprocalRank(["a", "b"], "z")).toBe(0);
    expect(reciprocalRank([], "z")).toBe(0);
  });
});

describe("summarizeBenchmarkRun", () => {
  it("scores 0 for mrr and every recall@k on an empty run", () => {
    expect(summarizeBenchmarkRun([])).toEqual({
      mrr: 0,
      recallAtK: { 1: 0, 3: 0, 5: 0, 10: 0 },
    });
  });

  it("aggregates mrr and recall@k across a mixed set of hits and a miss", () => {
    // Case 1: expected at rank 1 (RR = 1; hits recall@1 and up).
    // Case 2: expected at rank 3 (RR = 1/3; misses recall@1, hits recall@3 and up).
    // Case 3: expected not retrieved at all (RR = 0; misses every k).
    const summary = summarizeBenchmarkRun([
      { rankedWorkItemIds: ["A", "B", "C"], expectedWorkItemId: "A" },
      { rankedWorkItemIds: ["X", "Y", "Z"], expectedWorkItemId: "Z" },
      { rankedWorkItemIds: ["P", "Q"], expectedWorkItemId: "R" },
    ]);

    expect(summary.mrr).toBeCloseTo((1 + 1 / 3 + 0) / 3);
    expect(summary.recallAtK[1]).toBeCloseTo(1 / 3);
    expect(summary.recallAtK[3]).toBeCloseTo(2 / 3);
    expect(summary.recallAtK[5]).toBeCloseTo(2 / 3);
    expect(summary.recallAtK[10]).toBeCloseTo(2 / 3);
  });

  it("accepts a custom set of k values", () => {
    const summary = summarizeBenchmarkRun(
      [{ rankedWorkItemIds: ["A", "B"], expectedWorkItemId: "B" }],
      [2, 4],
    );
    expect(summary.recallAtK).toEqual({ 2: 1, 4: 1 });
    expect(summary.recallAtK[1]).toBeUndefined();
  });
});
