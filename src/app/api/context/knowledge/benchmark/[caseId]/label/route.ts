import { NextResponse } from "next/server";
import { z } from "zod";
import { authErrorResponse, requireWorkflowContext, requireWorkflowRole } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { labelProjectKnowledgeBenchmarkCase } from "@/modules/rag/project-knowledge-benchmark.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  expectedWorkItemId: z.string().trim().min(1).max(200).optional(),
  expectedAnswerSnippet: z.string().trim().min(1).max(2000).optional(),
});
type RouteParams = { params: Promise<{ caseId: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "A valid benchmark label is required." }, { status: 400 });
  }

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can label retrieval benchmark cases.");
    const trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const { caseId } = await params;
    return NextResponse.json({
      case: await labelProjectKnowledgeBenchmarkCase({
        scope: trustedScope,
        caseId,
        expectedWorkItemId: parsed.data.expectedWorkItemId,
        expectedAnswerSnippet: parsed.data.expectedAnswerSnippet,
        labeledBy: ctx.userId,
      }),
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "The benchmark case could not be labeled." });
  }
}
