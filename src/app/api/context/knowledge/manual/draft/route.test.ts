import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  requireExternalLlmEnabled: vi.fn(),
  resolveProjectScope: vi.fn(),
  buildProjectKnowledgeManualDraft: vi.fn(),
  resumeLatestProjectKnowledgeManualDraft: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return {
    ...actual,
    requireWorkflowContext: mocks.requireWorkflowContext,
    requireWorkflowRole: mocks.requireWorkflowRole,
    requireExternalLlmEnabled: mocks.requireExternalLlmEnabled,
  };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/rag/project-knowledge.service", () => ({
  buildProjectKnowledgeManualDraft: mocks.buildProjectKnowledgeManualDraft,
  resumeLatestProjectKnowledgeManualDraft: mocks.resumeLatestProjectKnowledgeManualDraft,
}));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();
const requestScope = { ...trustedScope, workspaceId: "ws-1" };

describe("POST /api/context/knowledge/manual/draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "owner-1", workspace: { id: "ws-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.requireExternalLlmEnabled.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.buildProjectKnowledgeManualDraft.mockResolvedValue({ draftId: "fresh-draft" });
  });

  it("resumes the latest eligible manual draft only after owner/admin and capability checks", async () => {
    const draft = {
      draftId: "saved-draft",
      mode: "incremental",
      batchCount: 2,
      batches: [],
      validatedBatchIndexes: [1],
    };
    mocks.resumeLatestProjectKnowledgeManualDraft.mockResolvedValue(draft);

    const response = await POST(jsonRequest("/api/context/knowledge/manual/draft", {
      scope: requestScope,
      resumeLatest: true,
    }));

    expect(response.status).toBe(200);
    expect(mocks.requireWorkflowRole).toHaveBeenCalledWith(
      expect.anything(),
      ["owner", "admin"],
      expect.any(String),
    );
    expect(mocks.requireExternalLlmEnabled).toHaveBeenCalledWith(expect.anything());
    expect(mocks.resolveProjectScope).toHaveBeenCalledWith(expect.anything(), requestScope);
    expect(mocks.resumeLatestProjectKnowledgeManualDraft).toHaveBeenCalledWith({ scope: trustedScope });
    expect(mocks.buildProjectKnowledgeManualDraft).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ draft });
  });

  it("does not resolve project scope when External LLM is disabled", async () => {
    mocks.requireExternalLlmEnabled.mockRejectedValue(new WorkflowAuthError(
      "External LLM is disabled by a workspace owner or admin.",
      403,
    ));

    const response = await POST(jsonRequest("/api/context/knowledge/manual/draft", {
      scope: requestScope,
      resumeLatest: true,
    }));

    expect(response.status).toBe(403);
    expect(mocks.resolveProjectScope).not.toHaveBeenCalled();
    expect(mocks.resumeLatestProjectKnowledgeManualDraft).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean resume request before authorization", async () => {
    const response = await POST(jsonRequest("/api/context/knowledge/manual/draft", {
      scope: requestScope,
      resumeLatest: "yes",
    }));

    expect(response.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });
});
