import { describe, expect, it } from "vitest";

import {
  hasAnyRelevantEntry,
  MIN_ABSOLUTE_SIMILARITY,
  selectRelevantEntryKeys,
  type ScoredEntry,
} from "@/modules/rag/knowledge-relevance-cutoff";

/**
 * The fixtures below are real similarity distributions, measured with the pinned local
 * embedding model against a live project's compiled knowledge base (114 business rules,
 * 48 glossary terms, 39 modules, 10 state transitions, 2 dependencies). Synthetic
 * numbers would prove only that the arithmetic works; these encode the shapes that
 * actually broke.
 */

function scored(similarities: number[], prefix = "e"): ScoredEntry[] {
  return similarities.map((similarity, index) => ({ key: `${prefix}${index + 1}`, similarity }));
}

/**
 * Rebuilds a full category from its measured head plus its measured size and floor.
 * The cut-off keys off the category median, so a fixture truncated to its top entries
 * would measure a different distribution than the one that was observed.
 */
function withTail(head: number[], options: { count: number; min: number }): ScoredEntry[] {
  const tailLength = options.count - head.length;
  const from = head[head.length - 1];
  const tail = Array.from({ length: tailLength }, (_, index) =>
    from - ((from - options.min) * (index + 1)) / tailLength,
  );
  return scored([...head, ...tail]);
}

describe("selectRelevantEntryKeys", () => {
  describe("work item 45105 - attachments not visible in the provider activity log", () => {
    it("rejects a category where nothing is relevant", () => {
      // The project's only two dependencies are about swap requests and waybills.
      // Both rank top-of-category against this work item purely because there is
      // nothing else to compare them against.
      const dependencies = scored([0.586, 0.567]);

      expect(selectRelevantEntryKeys(dependencies, "crossDependencies")).toEqual([]);
    });

    it("keeps the one module the work item is about and drops the tail", () => {
      // Activity Tracker, then HelpDesk, IPP, BCR, Waybill — none of which the bug
      // touches. Naming them in the domain brief asserts a relationship that is not
      // there.
      const modules = scored([0.723, 0.651, 0.619, 0.617, 0.609, 0.605, 0.603, 0.600]);

      expect(selectRelevantEntryKeys(modules, "modules")).toEqual(["e1"]);
    });

    it("drops a state transition belonging to an unrelated workflow", () => {
      // Rank 5 is "Master Plan Workflow: confirmed", which has nothing to do with
      // clarification attachments.
      const transitions = scored([0.678, 0.662, 0.634, 0.633, 0.623, 0.615, 0.603, 0.595, 0.590, 0.579]);

      expect(selectRelevantEntryKeys(transitions, "stateTransitions")).toEqual(["e1", "e2"]);
    });
  });

  describe("work item 45104 - parent task cannot close while a subtask is rejected", () => {
    it("keeps the rules behind an unusually strong leader", () => {
      // 0.848 is a near-exact restatement of the work item, but the 0.782 and 0.777
      // behind it are also directly on point. Measuring distance from the best entry
      // instead of from the category median discarded both.
      const rules = withTail([0.848, 0.782, 0.777, 0.763, 0.720, 0.713, 0.709, 0.704], {
        count: 114, min: 0.530,
      });

      const kept = selectRelevantEntryKeys(rules, "businessRules");

      expect(kept).toContain("e2");
      expect(kept).toContain("e3");
      expect(kept.length).toBeLessThan(8);
    });
  });

  describe("work item 45102 - platform freezes during submission causing duplicates", () => {
    it("does not admit most of a flat category", () => {
      // Best 0.726 against a median of 0.607: no clear winner, and a distance-from-best
      // rule admitted 26 of 114 rules here. Business rules are deliberately the most
      // lenient category, so this stays generous — but bounded.
      const rules = withTail([0.726, 0.703, 0.680, 0.679, 0.673, 0.671, 0.666, 0.666], {
        count: 114, min: 0.506,
      });

      const kept = selectRelevantEntryKeys(rules, "businessRules");

      expect(kept.length).toBeGreaterThan(3);
      expect(kept.length).toBeLessThan(rules.length / 4);
    });
  });

  it("is more lenient for business rules than for modules on the same distribution", () => {
    // A missing business rule is a missing test condition; an unrelated module name is
    // a false claim about scope. The asymmetry is deliberate.
    const distribution = scored([0.760, 0.720, 0.700, 0.690, 0.680, 0.660, 0.640, 0.620]);

    expect(selectRelevantEntryKeys(distribution, "businessRules").length)
      .toBeGreaterThan(selectRelevantEntryKeys(distribution, "modules").length);
  });

  it("returns entries best first regardless of input order", () => {
    const shuffled: ScoredEntry[] = [
      { key: "middle", similarity: 0.78 },
      { key: "worst", similarity: 0.30 },
      { key: "best", similarity: 0.80 },
      { key: "low", similarity: 0.40 },
    ];

    expect(selectRelevantEntryKeys(shuffled, "businessRules")).toEqual(["best", "middle"]);
  });

  it("rejects everything below the absolute floor even when the spread looks healthy", () => {
    const belowFloor = scored([
      MIN_ABSOLUTE_SIMILARITY - 0.01,
      MIN_ABSOLUTE_SIMILARITY - 0.20,
      MIN_ABSOLUTE_SIMILARITY - 0.25,
    ]);

    expect(selectRelevantEntryKeys(belowFloor, "businessRules")).toEqual([]);
  });

  it("handles an empty category", () => {
    expect(selectRelevantEntryKeys([], "glossary")).toEqual([]);
  });

  it("always keeps the best entry when it clears the floor", () => {
    const entries = scored([0.90, 0.62, 0.61]);

    expect(selectRelevantEntryKeys(entries, "modules")[0]).toBe("e1");
  });
});

describe("hasAnyRelevantEntry", () => {
  it("is false only when every category came back empty", () => {
    expect(hasAnyRelevantEntry({ modules: [], businessRules: [] })).toBe(false);
    expect(hasAnyRelevantEntry({ modules: [], businessRules: ["rule-1"] })).toBe(true);
    expect(hasAnyRelevantEntry({})).toBe(false);
  });
});
