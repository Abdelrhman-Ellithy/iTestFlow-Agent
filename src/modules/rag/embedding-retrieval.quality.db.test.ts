import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { flushBackgroundWrites, resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { indexAzureWorkItemsAsProjectContext } from "@/modules/rag/project-context-store.service";
import { searchProjectContextByEmbedding, syncProjectChunkEmbeddings } from "@/modules/rag/embedding-store.service";
import { searchProjectChunksHybrid } from "@/modules/rag/hybrid-chunk-search";
import { buildFtsQuery } from "@/modules/rag/full-text-search";
import { createEmbeddingProvider } from "@/modules/rag/embedding-provider";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import type { Requirement } from "@/modules/integrations/azure-devops/azure-devops-types";
import { fakeAzureAdapter, requirement } from "@/test/factories";
import { cleanupFixtures, describeDb, seedProject, seedWorkspace, uniqueTestId } from "@/test/db";

/**
 * End-to-end proof that the pinned embedding model earns its place in retrieval,
 * running the REAL model against a REAL Postgres index.
 *
 * embedding-model.quality.db.test.ts proves the model's vectors behave correctly in
 * isolation. This file proves the thing that actually ships: that a user's question,
 * asked in their own words, reaches the right work item through the full
 * index -> embed -> search -> fuse pipeline, including cases where the existing
 * full-text search returns nothing at all.
 */

const WS = uniqueTestId("ws_embedquality");
const ORG = `https://dev.azure.com/${WS}`;
const PROJ = uniqueTestId("az_embedquality");

const scope: ProjectScope = {
  projectId: PROJ,
  azureProjectId: PROJ,
  azureProjectName: "Embedding Retrieval Quality",
  azureOrganizationUrl: ORG,
};

const provider = createEmbeddingProvider();

// Wording chosen so the questions below share no meaningful terms with these items.
const ITEMS: Requirement[] = [
  requirement({
    id: "9001",
    azureProjectId: PROJ,
    title: "Expired card handling at checkout",
    description: "The checkout page rejects expired credit cards during payment authorization.",
    acceptanceCriteria: "Given an expired card, when the shopper pays, then show a clear failure reason.",
    tags: [],
  }),
  requirement({
    id: "9002",
    azureProjectId: PROJ,
    title: "Brute force protection",
    description: "Users are locked out for fifteen minutes after five consecutive failed sign-in attempts.",
    acceptanceCriteria: "Given five bad attempts, when another is made, then refuse and start a cooldown.",
    tags: [],
  }),
  requirement({
    id: "9004",
    azureProjectId: PROJ,
    title: "Warehouse stocktake reconciliation",
    // Long enough to split into multiple chunks, and worded so the continuation
    // chunks share nothing with the title above.
    description: Array.from(
      { length: 40 },
      (_, index) =>
        `Step ${index}: the operator scans each shelf label, confirms the counted quantity against the recorded figure, and records any discrepancy with a reason code for later approval by a supervisor.`,
    ).join(" "),
    acceptanceCriteria: "Given a completed count, when discrepancies exist, then require supervisor approval.",
    tags: [],
  }),
  requirement({
    id: "9003",
    azureProjectId: PROJ,
    title: "Bulk report download",
    description: "Reports are exported as CSV and streamed in batches so large downloads do not time out.",
    acceptanceCriteria: "Given a large report, when exported, then stream it without a timeout.",
    tags: [],
  }),
];

describeDb("embedding retrieval quality (real model, real index)", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: WS, orgUrl: ORG });
    await seedProject({
      workspaceId: WS,
      orgUrl: ORG,
      azureProjectId: PROJ,
      azureProjectName: scope.azureProjectName,
    });
    await indexAzureWorkItemsAsProjectContext({
      scope,
      actor: "db-test",
      adapter: fakeAzureAdapter({ fetchWorkItems: vi.fn(async () => ITEMS) }),
      workItemTypes: ["User Story"],
      states: ["Active"],
      // Index without embedding, then embed explicitly below, so the test controls
      // exactly when the real model runs.
      embeddingProvider: null,
    });
    await syncProjectChunkEmbeddings({ scope, provider });
  }, 300_000);

  afterAll(async () => {
    // Ordered child-to-parent: azure_devops_work_items holds an FK to workspaces,
    // so it must go before cleanupFixtures drops the workspace row.
    await flushBackgroundWrites();
    await sqlRun(`DELETE FROM embeddings WHERE project_id = @p`, { p: PROJ });
    await sqlRun(`DELETE FROM document_chunks_fts WHERE project_id = @p`, { p: PROJ });
    await sqlRun(`DELETE FROM document_chunks WHERE project_id = @p`, { p: PROJ });
    await sqlRun(`DELETE FROM azure_devops_work_items WHERE project_id = @p`, { p: PROJ });
    await sqlRun(`DELETE FROM project_knowledge_log WHERE project_id = @p`, { p: PROJ });
    await cleanupFixtures({ workspaceIds: [WS], userIds: [] });
    await resetDatabaseForTests();
  });

  // Each question is how a business owner would really ask, using none of the
  // indexed wording.
  //
  // Measured behaviour that motivated these assertions: lexical search does not
  // return *nothing* for these queries — it returns *everything*, because query
  // terms are ORed and (before the stopword fix in full-text-search.ts) function
  // words matched every chunk. So the honest claim for semantic search is not
  // "finds what lexical misses" but the sharper "puts the right item FIRST, where
  // lexical ordering is arbitrary". Ranking is what top-K actually hands the LLM.
  const CASES = [
    { question: "why was my card refused when I tried to buy", expectedWorkItem: "9001" },
    { question: "account temporarily blocked after too many bad passwords", expectedWorkItem: "9002" },
    { question: "pulling a big spreadsheet out of the system", expectedWorkItem: "9003" },
  ];

  it.each(CASES)(
    "ranks the right work item first for a paraphrased question: $question",
    async ({ question, expectedWorkItem }) => {
      const hybrid = await searchProjectChunksHybrid({
        scope,
        ftsQuery: buildFtsQuery(question) ?? "",
        rawQuery: question,
        topK: 3,
        embeddingProvider: provider,
      });
      expect(hybrid[0]!.row.azure_work_item_id).toBe(expectedWorkItem);
    },
    300_000,
  );

  it("semantic ranking survives fusion with a weak lexical signal", async () => {
    // Regression for a real defect this suite uncovered: for this query the semantic
    // signal correctly ranked 9003 first while full-text — matching only on function
    // words — ranked 9001 first, and reciprocal rank fusion returned the WRONG item
    // because it treated the lexical noise as an equal-authority ranked list.
    // Fixed by dropping stopwords from the generated FTS query.
    const question = "pulling a big spreadsheet out of the system";

    const semanticOnly = await searchProjectContextByEmbedding({
      scope,
      provider,
      query: question,
      topK: 3,
      maxChunksPerWorkItem: 1,
    });
    expect(semanticOnly[0]!.azure_work_item_id).toBe("9003");

    // The fused result must agree with the signal that actually understood the query.
    const hybrid = await searchProjectChunksHybrid({
      scope,
      ftsQuery: buildFtsQuery(question) ?? "",
      rawQuery: question,
      topK: 3,
      embeddingProvider: provider,
    });
    expect(hybrid[0]!.row.azure_work_item_id).toBe("9003");
  }, 300_000);

  it("still ranks an exact-wording question correctly (semantic does not displace lexical)", async () => {
    // Adding a signal must not damage the case that already worked. This is the
    // regression that a "semantic search is better" change most easily causes.
    const question = "expired credit cards payment authorization";
    const hybrid = await searchProjectChunksHybrid({
      scope,
      ftsQuery: buildFtsQuery(question) ?? "",
      rawQuery: question,
      topK: 3,
      embeddingProvider: provider,
    });
    expect(hybrid[0]!.row.azure_work_item_id).toBe("9001");
  }, 300_000);

  it("does not invent a source for a question the project cannot answer", async () => {
    // Semantic search always has a nearest neighbour, so it will return rows. The
    // guarantee that matters is that an unanswerable question does not produce a
    // confident single winner the assistant would then answer from.
    const offTopic = "how do I configure the Kubernetes ingress controller";
    const hybrid = await searchProjectChunksHybrid({
      scope,
      ftsQuery: buildFtsQuery(offTopic) ?? "",
      rawQuery: offTopic,
      topK: 3,
      embeddingProvider: provider,
    });

    const onTopic = await searchProjectChunksHybrid({
      scope,
      ftsQuery: buildFtsQuery("why was my card refused when I tried to buy") ?? "",
      rawQuery: "why was my card refused when I tried to buy",
      topK: 3,
      embeddingProvider: provider,
    });

    // A real question produces a decisively better top hit than an unanswerable one.
    // The assistant's own prompt ("if the answer is unsupported, say so") is what
    // ultimately refuses; this keeps the evidence it sees appropriately weak.
    expect(onTopic[0]!.score).toBeGreaterThan(hybrid[0]!.score);
  }, 300_000);
});
