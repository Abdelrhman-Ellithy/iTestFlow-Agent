import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { flushBackgroundWrites, resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { indexAzureWorkItemsAsProjectContext, workItemToContextUnits } from "@/modules/rag/project-context-store.service";
import { syncProjectChunkEmbeddings } from "@/modules/rag/embedding-store.service";
import { searchProjectChunksHybrid } from "@/modules/rag/hybrid-chunk-search";
import { buildFtsQuery } from "@/modules/rag/full-text-search";
import { createEmbeddingProvider } from "@/modules/rag/embedding-provider";
import { createRerankProvider } from "@/modules/rag/rerank-provider";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import type { Requirement } from "@/modules/integrations/azure-devops/azure-devops-types";
import { fakeAzureAdapter, requirement } from "@/test/factories";
import { cleanupFixtures, describeDb, seedProject, seedWorkspace, uniqueTestId } from "@/test/db";

/**
 * End-to-end proof that the local cross-encoder reranker (Xenova/ms-marco-MiniLM-L-6-v2)
 * earns its place, running the REAL model against a REAL Postgres index -- same spirit
 * as embedding-retrieval.quality.db.test.ts, for the rerank stage.
 *
 * The corpus is a lexical trap: WRONG's chunk text repeats the query's own words MORE
 * than RIGHT's does, yet WRONG answers a different question ("how do I configure CI
 * environment variables") than the one asked. A pure term-frequency signal has no way
 * to see that difference; a cross-encoder reading the query and passage together does.
 *
 * Measured against the real model and a real index: the reranker scores RIGHT's passage
 * 0.999 against WRONG's 0.591, and warm inference over a handful of pairs costs ~2ms.
 * Fusion alone also ranks RIGHT first here (see the last test) -- so what this file
 * proves is that the reranker's own judgement is sound and that adding it does not
 * disturb an already-correct order, NOT that it rescues a broken one.
 */

const WS = uniqueTestId("ws_rerankquality");
const ORG = `https://dev.azure.com/${WS}`;
const PROJ = uniqueTestId("az_rerankquality");

const scope: ProjectScope = {
  projectId: PROJ,
  azureProjectId: PROJ,
  azureProjectName: "Rerank Retrieval Quality",
  azureOrganizationUrl: ORG,
};

const embeddingProvider = createEmbeddingProvider();
const rerankProvider = createRerankProvider();

const QUERY = "how do I export my test run results";
const RIGHT_ID = "9101";
const WRONG_ID = "9102";

const rightItem = requirement({
  id: RIGHT_ID,
  azureProjectId: PROJ,
  title: "Export test run results",
  description:
    "Users can export their finished test run results as a CSV file from the results page for offline analysis and sharing with stakeholders.",
  acceptanceCriteria:
    "Given a completed test run, when the user exports results, then a CSV file with all test run results is produced.",
  tags: [],
});

const wrongItem = requirement({
  id: WRONG_ID,
  azureProjectId: PROJ,
  title: "Export CI environment variables",
  // Deliberately denser in the query's own words than the item above (measured:
  // export/test/run/results appear 21 times total here vs 16 above) -- a passage
  // about a different feature that a term-frequency signal cannot tell apart from a
  // genuine answer.
  description:
    "Before an automated test run starts, the CI pipeline exports environment variables such as API keys so the test runner can authenticate against external services and produce test results. This export applies to every test run in the pipeline configuration.",
  acceptanceCriteria:
    "Given a CI pipeline configuration, when a test run begins, then required environment variables are exported first, before any test results exist. Test run results are generated separately after each test run completes.",
  tags: [],
});

const ITEMS: Requirement[] = [rightItem, wrongItem];

describeDb("rerank retrieval quality (real model, real index)", () => {
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
      // exactly when the real model runs (matches embedding-retrieval.quality.db.test.ts).
      embeddingProvider: null,
    });
    await syncProjectChunkEmbeddings({ scope, provider: embeddingProvider });
  }, 300_000);

  afterAll(async () => {
    await flushBackgroundWrites();
    await sqlRun(`DELETE FROM embeddings WHERE project_id = @p`, { p: PROJ });
    await sqlRun(`DELETE FROM document_chunks_fts WHERE project_id = @p`, { p: PROJ });
    await sqlRun(`DELETE FROM document_chunks WHERE project_id = @p`, { p: PROJ });
    await sqlRun(`DELETE FROM azure_devops_work_items WHERE project_id = @p`, { p: PROJ });
    await sqlRun(`DELETE FROM project_knowledge_log WHERE project_id = @p`, { p: PROJ });
    await cleanupFixtures({ workspaceIds: [WS], userIds: [] });
    await resetDatabaseForTests();
  });

  it("scores the genuinely relevant chunk above a lexically denser but topically wrong one", async () => {
    // Isolates the reranker's own judgment from retrieval/fusion/chunking timing
    // entirely -- built from the exact same chunk-splitting function the indexing
    // pipeline uses (workItemToContextUnits), so this is provably the real input,
    // not a hand-copied approximation of it.
    expect(rerankProvider).not.toBeNull();
    const rightCore = workItemToContextUnits(rightItem)[0]!.text;
    const wrongCore = workItemToContextUnits(wrongItem)[0]!.text;

    const scores = await rerankProvider!.rerank(QUERY, [wrongCore, rightCore]);
    expect(scores[1]).toBeGreaterThan(scores[0]!);
  }, 180_000);

  it("ranks the genuinely relevant work item first once reranking is applied to hybrid search", async () => {
    const reranked = await searchProjectChunksHybrid({
      scope,
      ftsQuery: buildFtsQuery(QUERY) ?? "",
      rawQuery: QUERY,
      topK: 3,
      embeddingProvider,
      rerankProvider,
    });
    expect(reranked[0]!.row.azure_work_item_id).toBe(RIGHT_ID);
  }, 300_000);

  it("does not disturb a fused order that was already correct", async () => {
    // Measured, not assumed: on this corpus fusion ALREADY ranks the right item first
    // without any reranking (the embedding model's cosine similarity outvotes the
    // lexical density trap). So the test above is not proof that reranking rescued a
    // bad order -- it proves reranking preserved a good one, which is the property
    // that actually matters most in production, where fusion is usually right and a
    // reranker's job is to improve the margin without breaking the wins.
    //
    // Deliberately NOT "fixed" by making the wrong item denser until fusion trips:
    // that would be fitting the fixture to a desired narrative. A case where
    // reranking genuinely overturns fusion belongs in the labelled benchmark corpus
    // (see retrieval-benchmark-runner.service.ts), measured across many real
    // questions rather than argued from one hand-built pair.
    const baseline = await searchProjectChunksHybrid({
      scope,
      ftsQuery: buildFtsQuery(QUERY) ?? "",
      rawQuery: QUERY,
      topK: 3,
      embeddingProvider,
      rerankProvider: null,
    });
    expect(baseline[0]!.row.azure_work_item_id).toBe(RIGHT_ID);
  }, 300_000);
});
