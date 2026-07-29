import { describe, expect, it, vi } from "vitest";

vi.mock("@/modules/workspace/workspace-settings.service", () => ({
  getWorkspaceSettings: vi.fn().mockResolvedValue(null),
}));

import { clampTopK, resolveRetrievalTopK, DEFAULT_TOP_K, TOP_K_MAX, TOP_K_MIN } from "@/modules/rag/retrieval-config";

describe("clampTopK", () => {
  it("clamps within [TOP_K_MIN, TOP_K_MAX]", () => {
    expect(clampTopK(0)).toBe(TOP_K_MIN);
    expect(clampTopK(1000)).toBe(TOP_K_MAX);
    expect(clampTopK(10)).toBe(10);
  });

  it("falls back to the default for non-finite input", () => {
    expect(clampTopK(NaN)).toBe(DEFAULT_TOP_K);
    expect(clampTopK(Infinity)).toBe(DEFAULT_TOP_K);
  });

  it("truncates fractional values", () => {
    expect(clampTopK(5.9)).toBe(5);
  });
});

describe("resolveRetrievalTopK", () => {
  it("ignores the query and returns the same value as the workspace-only resolution today", async () => {
    // Regression guard: this function is deliberately a pass-through until the
    // evaluation loop exists to validate a query-dependent heuristic against real
    // data. If someone wires in query-sensitivity before that, this test should
    // catch the behavior change.
    const withQuery = await resolveRetrievalTopK({ workspaceId: "ws-1", query: "a very specific narrow question" });
    const withDifferentQuery = await resolveRetrievalTopK({ workspaceId: "ws-1", query: "" });
    const withBroadQuery = await resolveRetrievalTopK({
      workspaceId: "ws-1",
      query: "tell me everything about the whole system across every module",
    });

    expect(withQuery).toBe(DEFAULT_TOP_K);
    expect(withDifferentQuery).toBe(DEFAULT_TOP_K);
    expect(withBroadQuery).toBe(DEFAULT_TOP_K);
  });
});
