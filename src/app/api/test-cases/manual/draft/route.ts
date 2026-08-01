import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authErrorResponse,
  getUserAzureAdapter,
  requireExternalLlmEnabled,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { buildTestCaseGenerationPromptDraft } from "@/modules/test-case-design/application/test-case-generation.service";
import { defaultTestDesignOptions } from "@/modules/test-case-design/test-design-options";
import { TestDesignOptionsRequestSchema } from "@/modules/test-case-design/test-design-options.schema";
import { loadProjectKnowledgeContext } from "@/modules/rag/project-knowledge.service";
import { resolveWorkflowContextWithoutLLM } from "@/modules/rag/auto-context-resolver.service";
import { resolveRetrievalTopK } from "@/modules/rag/retrieval-config";
import { getWorkspaceSettings } from "@/modules/workspace/workspace-settings.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { EXTRA_INSTRUCTIONS_MAX_LENGTH } from "@/modules/llm/extra-instructions";
import { buildWorkflowContextCitations } from "@/modules/rag/workflow-context-citations";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().min(1),
  selectedContextIds: z.array(z.string()).optional().default([]),
  options: TestDesignOptionsRequestSchema.optional(),
  extraInstructions: z.string().max(EXTRA_INSTRUCTIONS_MAX_LENGTH, `Extra Instructions must be ${EXTRA_INSTRUCTIONS_MAX_LENGTH} characters or fewer.`).optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Please select an Azure DevOps project and target work item before preparing the prompt." },
      { status: 400 },
    );
  }

  try {
    const options = parsed.data.options ?? defaultTestDesignOptions;
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireExternalLlmEnabled(ctx);
    const trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const targetRequirement = await adapter.fetchWorkItemById({
      projectId: trustedScope.azureProjectId,
      workItemId: parsed.data.targetWorkItemId,
    });
    const autoContext = await resolveWorkflowContextWithoutLLM({
      scope: trustedScope,
      adapter,
      targetRequirement,
      selectedContextIds: parsed.data.selectedContextIds,
      retrievalTopK: await resolveRetrievalTopK({
        workspaceId: ctx.workspace.id,
        query: `${targetRequirement.title}\n${targetRequirement.description ?? ""}`,
      }),
    });
    const knowledgeContext = await loadProjectKnowledgeContext({ scope: trustedScope, consumer: "test_case_design_manual" });
    // The prepared prompt must match what the internal run sends for the same work item.
    // Without a model window it fell back to a fixed default regardless of the workspace's
    // configured model-input-limit, and without ranked keys it used keyword-only knowledge
    // selection — so a user copying this prompt out got materially less context than
    // production, silently. There is no LLM provider here, so the window comes from the
    // workspace override: the admin's own statement of what their models accept.
    const workspaceSettings = await getWorkspaceSettings(ctx.workspace.id);
    const draft = buildTestCaseGenerationPromptDraft({
      maxInputTokens: workspaceSettings?.modelInputTokenLimitOverride ?? undefined,
      relatedWorkItemsFloor: autoContext.retrievalTopK,
      scope: trustedScope,
      targetRequirement,
      relatedWorkItems: autoContext.relatedWorkItems,
      selectedContext: autoContext.selectedContext,
      projectKnowledgeBase: knowledgeContext.knowledgeBase,
      projectKnowledgeNotice: knowledgeContext.promptNotice,
      options,
      extraInstructions: parsed.data.extraInstructions,
    });
    const contextCitations = buildWorkflowContextCitations({
      resolvedContextUsed: autoContext.contextUsed,
      relevantProjectKnowledgeBase: draft.relevantProjectKnowledgeBase,
    });

    return NextResponse.json({
      targetWorkItemId: parsed.data.targetWorkItemId,
      selectedContextIds: parsed.data.selectedContextIds,
      resolvedContextUsed: autoContext.contextUsed,
      contextCitations,
      retrievalTopK: autoContext.retrievalTopK,
      options,
      ...draft,
      warnings: knowledgeContext.promptNotice ? [knowledgeContext.promptNotice] : undefined,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { domain: "llm", status: 503, fallback: "External LLM test case prompt preparation failed." });
  }
}
