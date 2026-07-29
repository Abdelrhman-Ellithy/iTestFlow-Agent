// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useExternalLlmAvailability } from "./use-external-llm-availability";

function capabilityResponse(workspaceId: string, externalLlmEnabled: boolean) {
  return Promise.resolve(new Response(JSON.stringify({ workspaceId, externalLlmEnabled }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useExternalLlmAvailability", () => {
  it("loads a workspace capability and enables External LLM only after verification", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(capabilityResponse("workspace 1", true));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useExternalLlmAvailability("workspace 1"));

    expect(result.current).toMatchObject({ status: "loading", enabled: false });
    await waitFor(() => expect(result.current).toMatchObject({ status: "enabled", enabled: true, workspaceId: "workspace 1" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspace/capabilities?workspaceId=workspace%201",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("fails closed for a disabled capability and refreshes after a workspace settings update", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockReturnValueOnce(capabilityResponse("workspace-1", true))
      .mockReturnValueOnce(capabilityResponse("workspace-1", false));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useExternalLlmAvailability("workspace-1"));

    await waitFor(() => expect(result.current.enabled).toBe(true));
    act(() => {
      window.dispatchEvent(new CustomEvent("itestflow:workspace-capabilities-changed", {
        detail: { workspaceId: "workspace-1" },
      }));
    });
    await waitFor(() => expect(result.current).toMatchObject({ status: "disabled", enabled: false }));
    expect(result.current.message).toContain("disabled by a workspace owner or admin");
  });

  it("uses the server-resolved active workspace for legacy scopes and fails closed on errors", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockReturnValueOnce(capabilityResponse("resolved-workspace", true))
      .mockRejectedValueOnce(new Error("network offline"));
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(({ workspaceId }: { workspaceId?: string }) => useExternalLlmAvailability(workspaceId), {
      initialProps: { workspaceId: undefined } as { workspaceId?: string },
    });

    await waitFor(() => expect(result.current).toMatchObject({ workspaceId: "resolved-workspace", enabled: true }));
    expect(fetchMock).toHaveBeenCalledWith("/api/workspace/capabilities", expect.objectContaining({ cache: "no-store" }));

    rerender({ workspaceId: "workspace-2" });
    await waitFor(() => expect(result.current).toMatchObject({ status: "unavailable", enabled: false }));
  });
});
