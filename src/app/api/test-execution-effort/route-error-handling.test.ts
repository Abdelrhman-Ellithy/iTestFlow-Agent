import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireExternalLlmEnabled: vi.fn(),
  getUserAzureAdapter: vi.fn(),
  resolveProjectScope: vi.fn(),
  resolveRetrievalTopK: vi.fn(),
  loadTestExecutionEffortData: vi.fn(),
  getWorkspaceSettings: vi.fn(),
  buildPromptDraft: vi.fn(),
  getUserLLMProvider: vi.fn(),
  startWorkflowRun: vi.fn(),
  failWorkflowRun: vi.fn(),
  completeWorkflowRun: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return {
    ...actual,
    requireWorkflowContext: mocks.requireWorkflowContext,
    requireExternalLlmEnabled: mocks.requireExternalLlmEnabled,
    getUserAzureAdapter: mocks.getUserAzureAdapter,
    getUserLLMProvider: mocks.getUserLLMProvider,
  };
});
vi.mock("@/modules/analytics/workflow-analytics.service", () => ({
  startWorkflowRun: mocks.startWorkflowRun,
  failWorkflowRun: mocks.failWorkflowRun,
  completeWorkflowRun: mocks.completeWorkflowRun,
}));
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/rag/retrieval-config", () => ({
  resolveRetrievalTopK: mocks.resolveRetrievalTopK,
}));
vi.mock("@/modules/test-execution-effort/test-execution-effort.data-loader", () => ({
  loadTestExecutionEffortData: mocks.loadTestExecutionEffortData,
}));
vi.mock("@/modules/workspace/workspace-settings.service", () => ({
  getWorkspaceSettings: mocks.getWorkspaceSettings,
}));
vi.mock("@/modules/test-execution-effort/test-execution-effort.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/test-execution-effort/test-execution-effort.service")>();
  return { ...actual, buildTestExecutionEffortPromptDraft: mocks.buildPromptDraft };
});

import { azureDevOpsIntegrationError } from "@/modules/integrations/azure-devops/azure-devops-error";
import { fakeAzureAdapter, jsonRequest, projectScope } from "@/test/factories";
import { POST as externalPromptPost } from "./external-prompt/route";
import { POST as preparePost } from "./prepare/route";
import { POST as generatePost } from "./generate/route";

const trustedScope = projectScope();
const context = {
  userId: "user-1",
  workspace: { id: "ws-1", azureOrgUrl: "https://dev.azure.com/demo" },
};

function body() {
  return {
    scope: { ...trustedScope, workspaceId: "ws-1" },
    storyId: "123",
  };
}

function expiredPatError() {
  return azureDevOpsIntegrationError(
    401,
    JSON.stringify({ message: "TF400813: not authorized" }),
    "_apis/wit/workitems/123?api-version=7.1",
  );
}

describe("test-execution-effort route integration errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue(context);
    mocks.requireExternalLlmEnabled.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getUserAzureAdapter.mockResolvedValue(fakeAzureAdapter());
    mocks.resolveRetrievalTopK.mockResolvedValue(6);
    mocks.loadTestExecutionEffortData.mockRejectedValue(expiredPatError());
    mocks.getWorkspaceSettings.mockResolvedValue({ modelInputTokenLimitOverride: 128_000 });
    mocks.buildPromptDraft.mockReturnValue({ prompt: "p", relevantProjectKnowledgeBase: null });
    mocks.getUserLLMProvider.mockResolvedValue({ name: "stub", model: "m", maxInputTokens: 128_000 });
    mocks.startWorkflowRun.mockReturnValue("run-1");
  });

  it("maps prepare integration auth failures to 401 with the integration header", async () => {
    const response = await preparePost(jsonRequest("/api/test-execution-effort/prepare", body()));

    expect(response.status).toBe(401);
    expect(response.headers.get("x-itf-error-scope")).toBe("integration");
    expect(await response.json()).toEqual({ error: "Test Execution Effort preview failed." });
  });

  it("maps external-prompt integration auth failures to 401 with the integration header", async () => {
    const response = await externalPromptPost(jsonRequest("/api/test-execution-effort/external-prompt", body()));

    expect(response.status).toBe(401);
    expect(response.headers.get("x-itf-error-scope")).toBe("integration");
    expect(await response.json()).toEqual({
      error: "External LLM Test Execution Effort prompt preparation failed.",
    });
  });

  it("maps generate integration auth failures to 401 with the integration header", async () => {
    // This route had no coverage at all, despite being the one that actually runs the
    // model — so a regression in its error mapping would have surfaced only in production.
    const response = await generatePost(jsonRequest("/api/test-execution-effort/generate", body()));

    expect(response.status).toBe(401);
    expect(response.headers.get("x-itf-error-scope")).toBe("integration");
  });
});

describe("test-execution-effort prompt parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue(context);
    mocks.requireExternalLlmEnabled.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getUserAzureAdapter.mockResolvedValue(fakeAzureAdapter());
    mocks.resolveRetrievalTopK.mockResolvedValue(6);
    mocks.getWorkspaceSettings.mockResolvedValue({ modelInputTokenLimitOverride: 128_000 });
    mocks.buildPromptDraft.mockReturnValue({ prompt: "p", relevantProjectKnowledgeBase: null });
    mocks.loadTestExecutionEffortData.mockResolvedValue({
      targetRequirement: { id: "123", title: "t" },
      linkedTestCases: [],
      relatedWorkItems: [],
      selectedContext: [],
      resolvedContextUsed: {},
      retrievalTopK: 6,
      rankedKnowledgeKeys: { businessRules: ["rule-1"] },
      projectKnowledgeBase: {},
      projectKnowledgeNotice: null,
      hasProjectContext: true,
    });
  });

  it("builds the exported prompt with the same ranking and budget the internal run uses", async () => {
    // Regression guard: this path silently fell back to keyword-only knowledge ranking
    // and a hardcoded related-items floor, so the prompt a user copied out was built from
    // materially different context than the one the app would have run itself.
    await externalPromptPost(jsonRequest("/api/test-execution-effort/external-prompt", body()));

    expect(mocks.buildPromptDraft).toHaveBeenCalledWith(expect.objectContaining({
      rankedKnowledgeKeys: { businessRules: ["rule-1"] },
      relatedWorkItemsFloor: 6,
      maxInputTokens: 128_000,
    }));
  });

  it("skips the ranking work for the preview route, which never uses it", async () => {
    // Preview returns a summary, not a prompt, so paying for a vector search plus an
    // ontology build on every call was pure waste.
    await preparePost(jsonRequest("/api/test-execution-effort/prepare", body()));

    expect(mocks.loadTestExecutionEffortData).toHaveBeenCalledWith(
      expect.objectContaining({ skipKnowledgeRanking: true }),
    );
  });
});
