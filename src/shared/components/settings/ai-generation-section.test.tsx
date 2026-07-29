// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiGenerationSection } from "./ai-generation-section";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

const credentialStatus = {
  workspaceId: "ws_1",
  azureOrgUrl: "https://dev.azure.com/org-a",
  azurePat: { status: "configured", maskedPreview: "****pat", isStale: false },
  llm: {
    status: "configured",
    maskedPreview: "sk-****key",
    provider: "openai",
    model: "gpt-4.1",
    isStale: false,
  },
};

const workspaceSettings = {
  workspaceId: "ws_1",
  settings: { retrievalTopK: null, maxOutputTokenCap: null, llmRetryAttempts: null, externalLlmEnabled: true },
  defaults: {
    maxOutputTokenCapDefault: 32000,
    maxOutputTokenCapOptions: [16000, 32000, 64000],
    retryAttemptsDefault: 1,
    retryAttemptsOptions: [0, 1, 2, 3],
  },
};

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("AiGenerationSection", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    let savedWorkspaceSettings = {
      ...workspaceSettings,
      settings: { ...workspaceSettings.settings },
    };
    fetchMock.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/settings/credentials")) return jsonResponse(credentialStatus);
      if (url.includes("/api/workspace/settings")) {
        if (init?.method === "PUT") {
          savedWorkspaceSettings = {
            ...savedWorkspaceSettings,
            settings: {
              ...savedWorkspaceSettings.settings,
              ...JSON.parse(String(init.body)),
            },
          };
        }
        return jsonResponse(savedWorkspaceSettings);
      }
      return jsonResponse({ error: `Unexpected request: ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(cleanup);

  it("clears the selected model when the provider changes away from the saved provider", async () => {
    render(<AiGenerationSection />);

    await screen.findByText("gpt-4.1");

    fireEvent.change(screen.getByLabelText("LLM Provider"), { target: { value: "gemini" } });

    await waitFor(() => {
      expect(screen.queryByText("gpt-4.1")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("combobox", { name: "Save an API key first" })).toBeDisabled();
  });

  it("restores the saved model when the saved provider is selected again", async () => {
    render(<AiGenerationSection />);

    await screen.findByText("gpt-4.1");

    const providerSelect = screen.getByLabelText("LLM Provider");
    fireEvent.change(providerSelect, { target: { value: "gemini" } });
    fireEvent.change(providerSelect, { target: { value: "openai" } });

    expect(screen.getByText("gpt-4.1")).toBeInTheDocument();
  });

  it("keeps the owner/admin-only notice visible to workspace members", async () => {
    fetchMock.mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/settings/credentials")) return jsonResponse(credentialStatus);
      if (url.includes("/api/workspace/settings")) {
        return jsonResponse({ error: "Only owners and admins can update workspace settings." }, 403);
      }
      return jsonResponse({ error: `Unexpected request: ${url}` }, 500);
    });

    render(<AiGenerationSection />);

    expect(await screen.findByText("Only workspace owners and admins can change these settings.")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Allow External LLM" })).not.toBeInTheDocument();
  });

  it("saves only the changed External LLM setting", async () => {
    render(<AiGenerationSection />);

    await screen.findByRole("heading", { name: "Workspace AI controls" });
    const externalLlmCheckbox = screen.getByRole("checkbox", { name: "Allow External LLM" });
    expect(externalLlmCheckbox).toBeChecked();
    expect(screen.getByText(/Auto Generate and saved provider credentials are unaffected/)).toBeInTheDocument();

    fireEvent.click(externalLlmCheckbox);
    expect(externalLlmCheckbox).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
      expect(putCall).toBeDefined();
      expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
        externalLlmEnabled: false,
      });
    });
  });

  it("uses the refreshed baseline so later cap and retry saves do not resend External LLM", async () => {
    render(<AiGenerationSection />);

    await screen.findByRole("heading", { name: "Workspace AI controls" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Allow External LLM" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
      expect(screen.getByRole("checkbox", { name: "Allow External LLM" })).not.toBeChecked();
    });

    fireEvent.click(screen.getByRole("button", { name: /64/ }));
    fireEvent.click(screen.getByRole("button", { name: /^2/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");
      expect(writes).toHaveLength(2);
      expect(JSON.parse(String(writes[1]?.[1]?.body))).toEqual({
        maxOutputTokenCap: 64000,
        llmRetryAttempts: 2,
      });
    });
  });
});
