// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "./api-error";
import { formatElapsedTime } from "./ai-generation-time";
import { GenerationModeToggle } from "./generation-mode-toggle";
import { validateGeneratedTestCase } from "./generated-test-cases-review";
import { validateRequirementFinding } from "./requirement-findings-review";

afterEach(cleanup);

describe("critical workflow UI behavior", () => {
  it("exposes generation modes as tabs and reports user selection", async () => {
    const onChange = vi.fn();
    render(createElement(GenerationModeToggle, {
      mode: "auto",
      onChange,
      externalLlmAvailability: {
        status: "enabled",
        enabled: true,
        message: "External LLM is available for this workspace.",
      },
    }));
    expect(screen.getByRole("tab", { name: "Auto Generate" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: "External LLM" }));
    expect(onChange).toHaveBeenCalledWith("manual");
  });

  it("keeps External LLM visible but disabled with an explanation when unavailable", () => {
    render(createElement(GenerationModeToggle, {
      mode: "manual",
      onChange: vi.fn(),
      externalLlmAvailability: {
        status: "disabled",
        enabled: false,
        message: "External LLM is disabled by a workspace owner or admin.",
      },
    }));

    expect(screen.getByRole("tab", { name: "External LLM" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Auto Generate" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("status")).toHaveTextContent("disabled by a workspace owner or admin");
  });

  it("validates editable generated cases before publishing", () => {
    expect(validateGeneratedTestCase({
      id: "1", title: " ", description: "", priority: 2, type: "", category: "",
      tags: [], relatedAcceptanceCriteria: [], relatedBusinessRules: [], relatedModules: [],
      preconditions: "", testData: "", steps: [],
    }).issues).toEqual(expect.arrayContaining([
      "Add a title.",
      "Choose a test type.",
      "Add at least one executable step.",
    ]));
  });

  it("validates editable requirement findings", () => {
    expect(validateRequirementFinding({
      id: "F-1",
      checklistItemId: "ambiguity_clarity",
      issueType: "ambiguity",
      severity: "high",
      title: "",
      description: "",
      suggestion: "",
      riskLevel: "high",
      riskJustification: "",
      affectedAreas: [],
      references: [],
      contradiction: false,
    }).valid).toBe(false);
  });

  it("maps API response payloads without trusting malformed metadata", () => {
    expect(ApiError.fromResponse({
      error: "Friendly",
      code: "NOT_A_CODE",
      technicalDetails: 42,
      technicalContext: ["bad"],
    }, 422)).toMatchObject({
      message: "Friendly",
      status: 422,
      code: undefined,
      technicalDetails: undefined,
      technicalContext: undefined,
    });
  });

  it.each([
    [-1, "0s"],
    [59.9, "59s"],
    [60, "1m 0s"],
    [125, "2m 5s"],
  ])("formats elapsed time %s", (seconds, expected) => {
    expect(formatElapsedTime(seconds)).toBe(expected);
  });
});
