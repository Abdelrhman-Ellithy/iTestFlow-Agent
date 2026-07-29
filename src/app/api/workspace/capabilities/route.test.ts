import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveWorkspaceRequest: vi.fn(),
  resolveWorkspaceRequestForWorkspace: vi.fn(),
  getWorkspaceSettings: vi.fn(),
}));

vi.mock("@/modules/workspace/workspace-request", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/workspace/workspace-request")>();
  return {
    ...actual,
    resolveWorkspaceRequest: mocks.resolveWorkspaceRequest,
    resolveWorkspaceRequestForWorkspace: mocks.resolveWorkspaceRequestForWorkspace,
  };
});
vi.mock("@/modules/workspace/workspace-settings.service", () => ({
  DEFAULT_EXTERNAL_LLM_ENABLED: true,
  getWorkspaceSettings: mocks.getWorkspaceSettings,
}));

import { SessionError } from "@/modules/auth/session.service";
import { WorkspaceAccessError } from "@/modules/workspace/workspace-access.service";
import { GET } from "./route";

const activeContext = {
  userId: "member-1",
  workspace: { id: "ws-active" },
};

describe("GET /api/workspace/capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveWorkspaceRequest.mockResolvedValue(activeContext);
    mocks.getWorkspaceSettings.mockResolvedValue(null);
  });

  it("returns the enabled default for a member when no settings row exists", async () => {
    const response = await GET(new Request("http://localhost/api/workspace/capabilities"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      workspaceId: "ws-active",
      externalLlmEnabled: true,
    });
    expect(mocks.resolveWorkspaceRequest).toHaveBeenCalledWith();
    expect(mocks.resolveWorkspaceRequestForWorkspace).not.toHaveBeenCalled();
    expect(mocks.getWorkspaceSettings).toHaveBeenCalledWith("ws-active");
  });

  it("uses a server-membership-checked requested workspace and returns its setting", async () => {
    mocks.resolveWorkspaceRequestForWorkspace.mockResolvedValue({
      userId: "member-1",
      workspace: { id: "ws-requested" },
    });
    mocks.getWorkspaceSettings.mockResolvedValue({ externalLlmEnabled: false });

    const response = await GET(
      new Request("http://localhost/api/workspace/capabilities?workspaceId=ws-requested"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workspaceId: "ws-requested",
      externalLlmEnabled: false,
    });
    expect(mocks.resolveWorkspaceRequestForWorkspace).toHaveBeenCalledWith("ws-requested");
    expect(mocks.resolveWorkspaceRequest).not.toHaveBeenCalled();
    expect(mocks.getWorkspaceSettings).toHaveBeenCalledWith("ws-requested");
  });

  it("denies a requested foreign workspace before reading its settings", async () => {
    mocks.resolveWorkspaceRequestForWorkspace.mockRejectedValue(
      new WorkspaceAccessError("You do not have access to this workspace."),
    );

    const response = await GET(
      new Request("http://localhost/api/workspace/capabilities?workspaceId=ws-foreign"),
    );

    expect(response.status).toBe(403);
    expect(mocks.getWorkspaceSettings).not.toHaveBeenCalled();
  });

  it("maps an unauthenticated active-workspace request before reading settings", async () => {
    mocks.resolveWorkspaceRequest.mockRejectedValue(new SessionError());

    const response = await GET(new Request("http://localhost/api/workspace/capabilities"));

    expect(response.status).toBe(401);
    expect(mocks.getWorkspaceSettings).not.toHaveBeenCalled();
  });

  it("rethrows unexpected workspace-resolution and settings failures", async () => {
    const resolutionFailure = new Error("session store unavailable");
    mocks.resolveWorkspaceRequest.mockRejectedValueOnce(resolutionFailure);
    await expect(GET(new Request("http://localhost/api/workspace/capabilities"))).rejects.toBe(resolutionFailure);

    mocks.resolveWorkspaceRequest.mockResolvedValue(activeContext);
    const persistenceFailure = new Error("settings unavailable");
    mocks.getWorkspaceSettings.mockRejectedValueOnce(persistenceFailure);
    await expect(GET(new Request("http://localhost/api/workspace/capabilities"))).rejects.toBe(persistenceFailure);
  });
});
