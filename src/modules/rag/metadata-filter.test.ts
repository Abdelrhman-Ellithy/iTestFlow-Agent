import { describe, expect, it } from "vitest";

import {
  metadataFilterParams,
  workItemPathFilterSql,
  workItemTypeFilterSql,
} from "@/modules/rag/metadata-filter";

describe("metadataFilterParams", () => {
  it("normalizes an empty filter to all-null (no-op)", () => {
    expect(metadataFilterParams(undefined)).toEqual({
      workItemTypes: null,
      areaPaths: null,
      iterationPaths: null,
    });
  });

  it("normalizes empty arrays to null", () => {
    expect(metadataFilterParams({ workItemTypes: [], areaPaths: [], iterationPaths: [] })).toEqual({
      workItemTypes: null,
      areaPaths: null,
      iterationPaths: null,
    });
  });

  it("passes through non-empty arrays unchanged", () => {
    const result = metadataFilterParams({
      workItemTypes: ["Bug"],
      areaPaths: ["Team\\Alpha"],
      iterationPaths: undefined,
    });
    expect(result).toEqual({
      workItemTypes: ["Bug"],
      areaPaths: ["Team\\Alpha"],
      iterationPaths: null,
    });
  });

  it("never includes a state field", () => {
    // Explicit guard: state filtering must never be added here. Closed bugs carry
    // reproduction steps and expected-vs-actual, high-value QA content this product
    // must never silently exclude at query time.
    const result = metadataFilterParams({ workItemTypes: ["Bug"] });
    expect(result).not.toHaveProperty("state");
    expect(result).not.toHaveProperty("states");
  });
});

describe("workItemTypeFilterSql", () => {
  it("produces a null-checked ANY() clause", () => {
    const sql = workItemTypeFilterSql();
    expect(sql).toContain("@workItemTypes::text[] IS NULL");
    expect(sql).toContain("work_item_type = ANY(@workItemTypes)");
  });

  it("respects a column prefix for aliased queries", () => {
    const sql = workItemTypeFilterSql("dc.");
    expect(sql).toContain("dc.work_item_type = ANY(@workItemTypes)");
  });
});

describe("workItemPathFilterSql", () => {
  it("produces null-checked EXISTS clauses for both area and iteration path", () => {
    const sql = workItemPathFilterSql(
      { projectId: "dc.project_id", azureProjectId: "dc.azure_project_id", azureWorkItemId: "dc.azure_work_item_id" },
      "mf",
    );
    expect(sql).toContain("@areaPaths::text[] IS NULL");
    expect(sql).toContain("area_path = ANY(@areaPaths)");
    expect(sql).toContain("@iterationPaths::text[] IS NULL");
    expect(sql).toContain("iteration_path = ANY(@iterationPaths)");
  });

  it("uses distinct join aliases so two filter fragments in one query cannot collide", () => {
    const sql = workItemPathFilterSql(
      { projectId: "project_id", azureProjectId: "azure_project_id", azureWorkItemId: "azure_work_item_id" },
      "mf",
    );
    expect(sql).toContain("azure_devops_work_items mf\n");
    expect(sql).toContain("azure_devops_work_items mf_it\n");
  });
});
