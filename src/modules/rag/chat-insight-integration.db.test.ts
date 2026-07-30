import { afterAll, beforeAll, expect, it } from "vitest";

import { flushBackgroundWrites, resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import {
  refreshProjectKnowledgeSearchIndex,
  retrieveContextChatbotEvidence,
} from "@/modules/rag/context-chatbot-retrieval.service";
import {
  integrateProjectKnowledgeCandidate,
  promoteContextChatbotAnswer,
} from "@/modules/rag/project-knowledge-compiled.service";
import { ProjectKnowledgeBaseSchema, type ProjectKnowledgeBase } from "@/modules/rag/project-knowledge.schema";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import { cleanupFixtures, describeDb, seedProject, seedWorkspace, uniqueTestId } from "@/test/db";

/**
 * An answer an admin saves from the Business Owner Assistant has to come back as
 * evidence for a later question, or the save button is decoration.
 *
 * Before this, three separate gates each blocked that independently: a promoted answer
 * was stored ungrounded and could never become grounded (grounding needs every fragment
 * to re-anchor to an immutable snapshot quote, and a synthesis across several work items
 * is not a quote from any of them), the integration action required the grounded state it
 * could never reach, and nothing consumed the resulting status anyway.
 */

const WS = uniqueTestId("ws_chatinsight");
const ORG = `https://dev.azure.com/${WS}`;
const PROJ = uniqueTestId("az_chatinsight");

const scope: ProjectScope = {
  projectId: PROJ,
  azureProjectId: PROJ,
  azureProjectName: "Chat Insight",
  azureOrganizationUrl: ORG,
};

// Wording chosen so the assertion below cannot pass on the compiled entry instead.
const INSIGHT = "Refund approvals above the daily ceiling escalate to a regional finance manager.";

function compiledKnowledge(): ProjectKnowledgeBase {
  return ProjectKnowledgeBaseSchema.parse({
    modules: [{
      id: "billing-module",
      name: "Billing",
      description: "Handles invoicing and refunds.",
      sourceWorkItemIds: ["8001"],
      evidence: "WI 8001",
    }],
    businessRules: [],
    stateTransitions: [],
    glossary: [],
    crossDependencies: [],
  });
}

async function savedAnswer() {
  return promoteContextChatbotAnswer({
    scope,
    actor: "admin-1",
    answer: INSIGHT,
    citations: [{ sourceType: "project_context", sourceId: "WI:8001", workItemId: "8001" }],
  });
}

describeDb("saved chatbot answers reach retrieval (DB-backed)", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: WS, orgUrl: ORG });
    await seedProject({ workspaceId: WS, orgUrl: ORG, azureProjectId: PROJ, azureProjectName: "Chat Insight" });
    await refreshProjectKnowledgeSearchIndex({
      scope,
      knowledgeBaseId: uniqueTestId("pkb"),
      knowledgeBase: compiledKnowledge(),
    });
  });

  afterAll(async () => {
    await flushBackgroundWrites();
    for (const table of [
      "embeddings",
      "project_knowledge_entries_fts",
      "project_knowledge_entries",
      "project_knowledge_candidates",
      "project_knowledge_log",
    ]) {
      await sqlRun(`DELETE FROM ${table} WHERE project_id = @p`, { p: PROJ });
    }
    await cleanupFixtures({ workspaceIds: [WS], userIds: [] });
    await resetDatabaseForTests();
  });

  it("a saved answer is not retrievable until it is integrated", async () => {
    await savedAnswer();

    const evidence = await retrieveContextChatbotEvidence({
      scope,
      query: "refund approvals regional finance manager",
      embeddingProvider: null,
      rerankProvider: null,
    });

    expect(evidence.knowledge.map((item) => item.content)).not.toContain(INSIGHT);
  });

  it("becomes retrievable once integrated, despite never being grounded", async () => {
    const candidate = await savedAnswer();
    // The state the old gate demanded, which this content can never reach.
    expect(candidate.status).toBe("legacy_ungrounded");

    const integrated = await integrateProjectKnowledgeCandidate({
      scope,
      candidateId: candidate.candidateId,
      actor: "admin-1",
    });
    expect(integrated?.status).toBe("integrated");

    const evidence = await retrieveContextChatbotEvidence({
      scope,
      query: "refund approvals regional finance manager",
      embeddingProvider: null,
      rerankProvider: null,
    });

    expect(evidence.knowledge.map((item) => item.content)).toContain(INSIGHT);
  });

  it("survives a knowledge republish, which rebuilds every compiled entry", async () => {
    // The republish path deletes and re-inserts the whole compiled set. An approved
    // insight is not in that set, so without an explicit guard publishing any draft
    // would silently discard it.
    const candidate = await savedAnswer();
    await integrateProjectKnowledgeCandidate({ scope, candidateId: candidate.candidateId, actor: "admin-1" });

    await refreshProjectKnowledgeSearchIndex({
      scope,
      knowledgeBaseId: uniqueTestId("pkb"),
      knowledgeBase: compiledKnowledge(),
    });

    const evidence = await retrieveContextChatbotEvidence({
      scope,
      query: "refund approvals regional finance manager",
      embeddingProvider: null,
      rerankProvider: null,
    });

    expect(evidence.knowledge.map((item) => item.content)).toContain(INSIGHT);
    // ...and the compiled entry is still there, so preserving one did not strand the other.
    const compiledEvidence = await retrieveContextChatbotEvidence({
      scope,
      query: "billing invoicing refunds",
      embeddingProvider: null,
      rerankProvider: null,
    });
    expect(compiledEvidence.knowledge.map((item) => item.entryKey)).toContain("billing-module");
  });

  it("integrating twice replaces the entry instead of duplicating it", async () => {
    const candidate = await savedAnswer();
    await integrateProjectKnowledgeCandidate({ scope, candidateId: candidate.candidateId, actor: "admin-1" });
    await integrateProjectKnowledgeCandidate({ scope, candidateId: candidate.candidateId, actor: "admin-2" });

    const evidence = await retrieveContextChatbotEvidence({
      scope,
      query: "refund approvals regional finance manager",
      embeddingProvider: null,
      rerankProvider: null,
    });

    expect(evidence.knowledge.filter((item) => item.content === INSIGHT)).toHaveLength(1);
  });

  it("records the insight as human-approved rather than verified", async () => {
    // The provenance distinction is the reason this is a separate category at all: an
    // accepted synthesis must not be indistinguishable from an extracted, re-anchorable
    // fact.
    const candidate = await savedAnswer();
    await integrateProjectKnowledgeCandidate({ scope, candidateId: candidate.candidateId, actor: "admin-1" });

    const evidence = await retrieveContextChatbotEvidence({
      scope,
      query: "refund approvals regional finance manager",
      embeddingProvider: null,
      rerankProvider: null,
    });
    const insight = evidence.knowledge.find((item) => item.content === INSIGHT);

    expect(insight?.category).toBe("chat_insight");
    expect(insight?.evidence).toContain("Approved from a Business Owner Assistant answer");
  });
});
