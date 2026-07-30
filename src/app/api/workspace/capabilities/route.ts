import { NextResponse } from "next/server";

import {
  resolveWorkspaceRequest,
  resolveWorkspaceRequestForWorkspace,
  workspaceRequestError,
} from "@/modules/workspace/workspace-request";
import {
  DEFAULT_EXTERNAL_LLM_ENABLED,
  getWorkspaceSettings,
} from "@/modules/workspace/workspace-settings.service";

export const runtime = "nodejs";

/**
 * Member-readable workspace feature availability. A supplied workspaceId is
 * resolved against server-side membership; without one, use the caller's active
 * workspace. Keep this intentionally small so it cannot expose settings or secrets.
 */
export async function GET(request: Request) {
  const requestedWorkspaceId = new URL(request.url).searchParams.get("workspaceId")?.trim();

  let context: Awaited<ReturnType<typeof resolveWorkspaceRequest>>;
  try {
    context = requestedWorkspaceId
      ? await resolveWorkspaceRequestForWorkspace(requestedWorkspaceId)
      : await resolveWorkspaceRequest();
  } catch (error) {
    const response = workspaceRequestError(error);
    if (response) return response;
    throw error;
  }

  const settings = await getWorkspaceSettings(context.workspace.id);
  return NextResponse.json(
    {
      workspaceId: context.workspace.id,
      externalLlmEnabled: settings?.externalLlmEnabled ?? DEFAULT_EXTERNAL_LLM_ENABLED,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
