import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { flushBackgroundWrites, resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { indexAzureWorkItemsAsProjectContext } from "@/modules/rag/project-context-store.service";
import { syncProjectChunkEmbeddings } from "@/modules/rag/embedding-store.service";
import {
  refreshProjectKnowledgeSearchIndex,
  retrieveContextChatbotEvidence,
} from "@/modules/rag/context-chatbot-retrieval.service";
import { ProjectKnowledgeBaseSchema, type ProjectKnowledgeBase } from "@/modules/rag/project-knowledge.schema";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import type { Requirement } from "@/modules/integrations/azure-devops/azure-devops-types";
import { fakeAzureAdapter, requirement } from "@/test/factories";
import { cleanupFixtures, describeDb, seedProject, seedWorkspace, uniqueTestId } from "@/test/db";

const WS = uniqueTestId("ws_chatbotretrieval");
const ORG = `https://dev.azure.com/${WS}`;
const PROJ = uniqueTestId("az_chatbotretrieval");

const scope: ProjectScope = {
  projectId: PROJ,
  azureProjectId: PROJ,
  azureProjectName: "Chatbot Retrieval",
  azureOrganizationUrl: ORG,
};

function checkoutItem(): Requirement {
  return requirement({
    id: "701",
    azureProjectId: PROJ,
    title: "Checkout process",
    // "workflow" only, no standalone "flow" -- proves trigram bridges this for
    // context search, since word-prefix FTS cannot match "flow" against it.
    description: "The checkout workflow charges the customer's card.",
    acceptanceCriteria: "Given a cart, when checkout completes, then confirm the order.",
    tags: [],
  });
}

function knowledgeBaseWithWorkflowEntry(): ProjectKnowledgeBase {
  return ProjectKnowledgeBaseSchema.parse({
    modules: [{
      id: "checkout-module",
      // Same compound-word setup as the context chunk above, on the knowledge side.
      name: "Checkout workflow",
      description: "Handles cart checkout and payment capture.",
      sourceWorkItemIds: ["701"],
      evidence: "WI 701",
    }],
    businessRules: [],
    stateTransitions: [],
    glossary: [],
    crossDependencies: [],
  });
}

async function sync(items: Requirement[]) {
  return indexAzureWorkItemsAsProjectContext({
    scope,
    actor: "db-test",
    adapter: fakeAzureAdapter({ fetchWorkItems: vi.fn(async () => items) }),
    workItemTypes: ["User Story"],
    states: ["Active"],
    embeddingProvider: null,
  });
}

describeDb("context chatbot retrieval (DB-backed)", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: WS, orgUrl: ORG });
    await seedProject({ workspaceId: WS, orgUrl: ORG, azureProjectId: PROJ, azureProjectName: "Chatbot Retrieval" });
    await sync([checkoutItem()]);
    await refreshProjectKnowledgeSearchIndex({
      scope,
      knowledgeBaseId: uniqueTestId("pkb"),
      knowledgeBase: knowledgeBaseWithWorkflowEntry(),
    });
  });

  afterAll(async () => {
    await flushBackgroundWrites();
    await sqlRun(`DELETE FROM embeddings WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM project_knowledge_entries_fts WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM project_knowledge_entries WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM document_chunks_fts WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM document_chunks WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM azure_devops_work_items WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM project_knowledge_log WHERE project_id = @projectId`, { projectId: PROJ });
    await cleanupFixtures({ workspaceIds: [WS], userIds: [] });
    await resetDatabaseForTests();
  });

  it("finds context and knowledge via ordinary full-text matches", async () => {
    const evidence = await retrieveContextChatbotEvidence({ rerankProvider: null, embeddingProvider: null, scope, query: "checkout customer card" });
    // The item has both a description and acceptance criteria, so field-aware chunking
    // gives it two chunks; the chatbot's per-work-item cap is 2, so both surface.
    expect(evidence.context.map((item) => item.workItemId)).toEqual(["701", "701"]);
    expect(evidence.knowledge.map((item) => item.entryKey)).toEqual(["checkout-module"]);
  });

  it("finds context via trigram when the query is a compound-word infix FTS prefix matching misses", async () => {
    const evidence = await retrieveContextChatbotEvidence({ rerankProvider: null, embeddingProvider: null, scope, query: "flow" });
    expect(evidence.context.map((item) => item.workItemId)).toContain("701");
  });

  it("finds knowledge via trigram when the query is a compound-word infix FTS prefix matching misses", async () => {
    const evidence = await retrieveContextChatbotEvidence({ rerankProvider: null, embeddingProvider: null, scope, query: "flow" });
    expect(evidence.knowledge.map((item) => item.entryKey)).toContain("checkout-module");
  });

  it("returns empty context and browse-order knowledge for a whitespace-only query", async () => {
    const evidence = await retrieveContextChatbotEvidence({ rerankProvider: null, embeddingProvider: null, scope, query: "   " });
    expect(evidence.context).toEqual([]);
    expect(evidence.knowledge.map((item) => item.entryKey)).toContain("checkout-module");
  });

  it("scopes both context and knowledge to the requesting project", async () => {
    const otherScope: ProjectScope = {
      projectId: uniqueTestId("az_chatbotretrieval_other"),
      azureProjectId: uniqueTestId("az_chatbotretrieval_other"),
      azureProjectName: "Other project",
      azureOrganizationUrl: ORG,
    };
    const evidence = await retrieveContextChatbotEvidence({ rerankProvider: null, embeddingProvider: null, scope: otherScope, query: "checkout customer card" });
    expect(evidence.context).toEqual([]);
    expect(evidence.knowledge).toEqual([]);
  });
  it("resolves a follow-up for semantic search without widening lexical search", async () => {
    // The whole point of separating the two: a follow-up needs its prior turn to mean
    // anything semantically, but full-text/trigram must still match the literal words.
    // Folding history into the lexical query would broaden it back into the
    // match-everything behaviour the stopword fix removed.
    const captured: string[] = [];
    const recordingProvider = {
      name: "local" as const,
      model: "capture",
      vectorReference: "ollama:capture",
      embed: async (texts: string[], kind: "document" | "query" = "document") => {
        if (kind === "query") captured.push(...texts);
        return texts.map(() => [1, 0, 0]);
      },
    };
    // Semantic search returns early when the project has no vectors at this reference,
    // so seed them first or the query is never embedded and this asserts nothing.
    await syncProjectChunkEmbeddings({ scope, provider: recordingProvider });

    await retrieveContextChatbotEvidence({
      rerankProvider: null,
      scope,
      query: "what about the rejected one ?",
      history: [{ role: "user", content: "how do PO requests move between states" }],
      embeddingProvider: recordingProvider,
    });

    // The query actually embedded carries the prior turn.
    const semantic = captured.join(" || ");
    expect(semantic).toContain("PO requests move between states");
    expect(semantic).toContain("what about the rejected one");
  });
});
