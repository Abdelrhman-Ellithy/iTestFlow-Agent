import { describe, expect, it } from "vitest";

import { requirement } from "@/test/factories";
import { workItemToContextUnits } from "@/modules/rag/project-context-store.service";

describe("workItemToContextUnits", () => {
  it("splits core fields and acceptance criteria into separate units", () => {
    const item = requirement({
      id: "1",
      title: "Restrict approval",
      description: "Only a department manager may approve.",
      acceptanceCriteria: "Given a request, when submitted, then require manager approval.",
    });

    const units = workItemToContextUnits(item);

    expect(units).toHaveLength(2);
    expect(units[0].field).toBe("core");
    expect(units[1].field).toBe("acceptance_criteria");
  });

  it("omits the acceptance_criteria unit when there is none", () => {
    const item = requirement({
      id: "2",
      title: "No AC item",
      description: "Some description.",
      acceptanceCriteria: undefined,
    });

    const units = workItemToContextUnits(item);

    expect(units).toHaveLength(1);
    expect(units[0].field).toBe("core");
  });

  it("prefixes the title on both units so a chunk from either is identifiable alone", () => {
    const item = requirement({
      id: "3",
      title: "Warehouse stocktake",
      description: "Count items in the warehouse.",
      acceptanceCriteria: "Given a count, when submitted, then reconcile inventory.",
    });

    const [core, acceptanceCriteria] = workItemToContextUnits(item);

    expect(core.text).toContain("Title: Warehouse stocktake");
    expect(acceptanceCriteria.text).toContain("Title: Warehouse stocktake");
  });

  it("keeps acceptance criteria out of the core unit", () => {
    const item = requirement({
      id: "4",
      title: "Split test",
      description: "Core description text.",
      acceptanceCriteria: "Distinct acceptance criteria text.",
    });

    const [core, acceptanceCriteria] = workItemToContextUnits(item);

    expect(core.text).not.toContain("Distinct acceptance criteria text");
    expect(acceptanceCriteria.text).toContain("Distinct acceptance criteria text");
    expect(acceptanceCriteria.text).not.toContain("Core description text");
  });

  it("produces no empty-string units when a work item has minimal content", () => {
    const item = requirement({
      id: "5",
      title: "Bare item",
      description: undefined,
      acceptanceCriteria: undefined,
    });

    const units = workItemToContextUnits(item);

    for (const unit of units) {
      expect(unit.text.trim().length).toBeGreaterThan(0);
    }
  });

  it("handles a work item with only acceptance criteria and no description", () => {
    const item = requirement({
      id: "6",
      title: "AC-only item",
      description: undefined,
      acceptanceCriteria: "Given X, when Y, then Z.",
    });

    const units = workItemToContextUnits(item);

    expect(units).toHaveLength(2);
    expect(units[0].text).not.toContain("Description:");
    expect(units[1].text).toContain("Given X, when Y, then Z.");
  });
});
