"use client";

import { useCallback, useEffect, useState } from "react";

export type ExternalLlmAvailabilityStatus = "loading" | "enabled" | "disabled" | "unavailable";

export type ExternalLlmAvailability = {
  /** The workspace this result belongs to, if one has been resolved. */
  workspaceId?: string;
  status: ExternalLlmAvailabilityStatus;
  enabled: boolean;
  message: string;
};

type WorkspaceCapabilitiesResponse = {
  workspaceId: string;
  externalLlmEnabled: boolean;
};

const messages = {
  loading: "Checking whether External LLM is available for this workspace.",
  disabled: "External LLM is disabled by a workspace owner or admin.",
  unavailable: "External LLM is unavailable until workspace capability settings can be verified.",
};

function initialAvailability(workspaceId?: string): ExternalLlmAvailability {
  return {
    workspaceId,
    status: "loading",
    enabled: false,
    message: messages.loading,
  };
}

/**
 * Resolves the workspace-level permission for copy/paste External LLM flows.
 * The client intentionally fails closed until the authenticated capability API
 * confirms that the active workspace has enabled the feature.
 */
export function useExternalLlmAvailability(workspaceId?: string) {
  const [availability, setAvailability] = useState<ExternalLlmAvailability>(() => initialAvailability(workspaceId));
  const [refreshVersion, setRefreshVersion] = useState(0);

  const refresh = useCallback(() => {
    setRefreshVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setAvailability({
      workspaceId,
      status: "loading",
      enabled: false,
      message: messages.loading,
    });

    const capabilityUrl = workspaceId
      ? `/api/workspace/capabilities?workspaceId=${encodeURIComponent(workspaceId)}`
      : "/api/workspace/capabilities";
    void fetch(capabilityUrl, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as WorkspaceCapabilitiesResponse | null;
        if (
          !response.ok ||
          !body ||
          (workspaceId !== undefined && body.workspaceId !== workspaceId) ||
          typeof body.externalLlmEnabled !== "boolean"
        ) {
          throw new Error("Workspace capabilities could not be verified.");
        }

        if (controller.signal.aborted) return;
        setAvailability({
          workspaceId: body.workspaceId,
          status: body.externalLlmEnabled ? "enabled" : "disabled",
          enabled: body.externalLlmEnabled,
          message: body.externalLlmEnabled ? "External LLM is available for this workspace." : messages.disabled,
        });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setAvailability({
          workspaceId,
          status: "unavailable",
          enabled: false,
          message: messages.unavailable,
        });
      });

    return () => controller.abort();
  }, [refreshVersion, workspaceId]);

  useEffect(() => {
    const onCapabilitiesChanged = (event: Event) => {
      const changedWorkspaceId = (event as CustomEvent<{ workspaceId?: string }>).detail?.workspaceId;
      if (
        !changedWorkspaceId ||
        changedWorkspaceId === workspaceId ||
        changedWorkspaceId === availability.workspaceId
      ) {
        refresh();
      }
    };
    const onFocus = () => refresh();

    window.addEventListener("itestflow:workspace-capabilities-changed", onCapabilitiesChanged);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("itestflow:workspace-capabilities-changed", onCapabilitiesChanged);
      window.removeEventListener("focus", onFocus);
    };
  }, [availability.workspaceId, refresh, workspaceId]);

  // Do not temporarily reuse a previous workspace's success state while a
  // project switch is rendering. Treat that brief transition as unavailable.
  if (workspaceId !== undefined && availability.workspaceId !== workspaceId) return initialAvailability(workspaceId);

  return { ...availability, refresh };
}
