import { describe, expect, it } from "vitest";

import { embeddableChunkText } from "./embedding-store.service";

/**
 * The embedded projection is not the stored content. Only meaning-bearing text is
 * embedded; identifiers, paths and timestamps are dropped because they are close to
 * constant across a project and pull every vector toward the same region.
 */
describe("embeddableChunkText", () => {
  const chunk = (content: string, document_name: string | null = "Restrict approval") => ({
    content,
    document_name,
  });

  it("drops identifier, path and timestamp lines but keeps real content", () => {
    const text = embeddableChunkText(
      chunk(
        [
          "Work item ID: 40460",
          "",
          "Type: Task",
          "",
          "State: New",
          "",
          "Title: Restrict approval",
          "",
          "Description:",
          "Only a department manager may approve.",
          "",
          "Area path: SPPCTracker",
          "",
          "Iteration path: SPPCTracker\January - 2026",
          "",
          "Updated: 2026-04-30T05:28:53.007Z",
        ].join("\n"),
      ),
    );

    expect(text).not.toContain("Work item ID");
    expect(text).not.toContain("Area path");
    expect(text).not.toContain("Iteration path");
    expect(text).not.toContain("Updated:");
    // Type and State are low-cardinality but genuinely meaningful, so they stay.
    expect(text).toContain("Type: Task");
    expect(text).toContain("State: New");
    expect(text).toContain("Only a department manager may approve.");
  });

  it("prefixes the work item title so continuation chunks are identifiable", () => {
    const text = embeddableChunkText(chunk("Description:\nsome body", "Warehouse stocktake"));
    expect(text.startsWith("Warehouse stocktake\n\n")).toBe(true);
  });

  it("never embeds an empty string when a chunk is nothing but header lines", () => {
    // 18% of chunks in a real project had no description or acceptance criteria.
    // Stripping every line would otherwise send "" to the model.
    const text = embeddableChunkText(
      chunk("Work item ID: 33047\n\nArea path: SPPCTracker\n\nUpdated: 2025-12-09T06:21:39.33Z", null),
    );
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).toContain("33047");
  });

  it("collapses the blank lines left behind by removal", () => {
    const text = embeddableChunkText(chunk("Type: Bug\n\nArea path: X\n\nState: Closed", null));
    expect(text).not.toMatch(/\n{3,}/);
    expect(text).toBe("Type: Bug\n\nState: Closed");
  });

  it("handles a chunk with no title", () => {
    expect(embeddableChunkText(chunk("Type: Bug", null))).toBe("Type: Bug");
  });
});
