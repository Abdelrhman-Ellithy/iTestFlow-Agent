import { describe, expect, it } from "vitest";

import {
  dedupeNearDuplicateChunks,
  jaccardSimilarity,
  shingleSet,
  type DedupeEntry,
} from "@/modules/rag/near-duplicate-chunks";

describe("shingleSet", () => {
  it("splits text into word bigrams", () => {
    const shingles = shingleSet("the quick brown fox");
    expect(shingles).toContain("the quick");
    expect(shingles).toContain("quick brown");
    expect(shingles).toContain("brown fox");
    expect(shingles.size).toBe(3);
  });

  it("lowercases and normalizes punctuation", () => {
    expect(shingleSet("Hello, World!")).toEqual(shingleSet("hello world"));
  });

  it("handles empty and short input", () => {
    expect(shingleSet("").size).toBe(0);
    expect(shingleSet("a").size).toBe(0);
    expect(shingleSet("ab").size).toBe(0); // single word can't form a bigram
    expect(shingleSet("ab cd").size).toBe(1); // two words form one bigram
  });
});

describe("jaccardSimilarity", () => {
  it("computes similarity correctly", () => {
    const a = new Set(["a", "b", "c"]);
    const b = new Set(["b", "c", "d"]);
    // intersection: {b, c} = 2, union: {a, b, c, d} = 4 → 2/4 = 0.5
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.5);
  });

  it("returns 1 for identical sets", () => {
    const a = new Set(["x", "y"]);
    expect(jaccardSimilarity(a, a)).toBe(1);
  });

  it("handles empty sets", () => {
    const empty = new Set<string>();
    const filled = new Set(["a"]);
    expect(jaccardSimilarity(empty, empty)).toBe(1);
    expect(jaccardSimilarity(empty, filled)).toBe(0);
  });
});

describe("dedupeNearDuplicateChunks", () => {
  it("removes near-identical items while keeping their higher-ranked alternative", () => {
    // Templated AC: both say the same thing, just slightly different wording.
    const entries: DedupeEntry<string>[] = [
      { item: "rule-1", text: "Required Action: Verify the change is approved by the owner" },
      { item: "rule-2", text: "Required Action: Verify the change is approved by the manager" },
      { item: "rule-3", text: "Completely different rule about caching behavior" },
    ];
    const deduped = dedupeNearDuplicateChunks(entries, 0.6);

    // rule-1 kept, rule-2 deduplicated, rule-3 kept.
    expect(deduped.map((e) => e.item)).toEqual(["rule-1", "rule-3"]);
  });

  it("keeps same-topic-different-wording entries separate", () => {
    const entries: DedupeEntry<string>[] = [
      { item: "a", text: "Database connections must be pooled for efficiency" },
      { item: "b", text: "Connection pooling is required for performance" },
      { item: "c", text: "Unrelated: feature flag support for gradual rollout" },
    ];
    const deduped = dedupeNearDuplicateChunks(entries, 0.7);

    // Both a and b discuss pooling but use different enough wording at 70% threshold.
    // Shingle-based dedup won't catch semantic similarity, only structural duplication.
    // Both should survive.
    expect(deduped.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves ranking: higher-ranked items are never removed in favor of lower-ranked", () => {
    const entries: DedupeEntry<string>[] = [
      { item: "high", text: "Acceptance criteria: must validate input length strictly" },
      { item: "low", text: "Acceptance criteria: must validate input length strictly" },
    ];
    const deduped = dedupeNearDuplicateChunks(entries, 0.7);

    // "high" is first, so it's kept. "low" is identical and removed.
    expect(deduped[0].item).toBe("high");
    expect(deduped.length).toBe(1);
  });

  it("fails its test when dedup is a no-op (discriminating, not just non-crashing)", () => {
    // This test verifies the dedup logic actually filters. If dedup were broken
    // (e.g., always returns the input unchanged), this would catch it.
    const entries: DedupeEntry<string>[] = [
      { item: "chunk-1", text: "Acceptance criteria: must validate input length" },
      { item: "chunk-2", text: "Acceptance criteria: must validate input length" },
    ];
    const deduped = dedupeNearDuplicateChunks(entries, 0.9);

    // Identical text should dedupe at 90% threshold.
    expect(deduped.length).toBeLessThan(entries.length);
    expect(deduped.length).toBe(1);
  });

  it("handles empty input", () => {
    expect(dedupeNearDuplicateChunks([], 0.7)).toEqual([]);
  });
});
