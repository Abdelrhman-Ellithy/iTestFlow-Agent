import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTestCaseGenerationMarkdownPrompt, buildRequirementAnalysisMarkdownPrompt } from "@/modules/llm/markdown-prompt-renderer";
import type { ProjectKnowledgeBase } from "@/modules/rag/project-knowledge.schema";

function kb(n: number): ProjectKnowledgeBase {
  const pad = (l: string, i: number) => `${l} ${i} covering behaviour that the system must enforce consistently`;
  return {
    modules: Array.from({ length: 60 }, (_, i) => ({ id: `mod-${i}`, name: `Module ${i}`, description: pad("Module behaviour", i), sourceWorkItemIds: [`${900 + i}`], evidence: `Module evidence ${i}` })),
    businessRules: Array.from({ length: n }, (_, i) => ({ id: `rule-${i}`, rule: pad("Business rule", i), sourceField: "description", moduleName: `Module ${i % 60}`, sourceWorkItemIds: [`${900 + i}`], evidence: `Rule evidence ${i}` })),
    stateTransitions: Array.from({ length: 120 }, (_, i) => ({ id: `st-${i}`, workflowName: `Workflow ${i}`, fromState: "Draft", toState: "Approved", triggerOrCondition: pad("Transition trigger", i), actor: "Reviewer", moduleName: `Module ${i % 60}`, sourceWorkItemIds: [`${900 + i}`], evidence: `Transition evidence ${i}` })),
    glossary: Array.from({ length: 200 }, (_, i) => ({ term: `Term${i}`, type: "term", definition: pad("Definition", i), sourceWorkItemIds: [`${900 + i}`], evidence: `Glossary evidence ${i}` })),
    crossDependencies: Array.from({ length: 80 }, (_, i) => ({ id: `dep-${i}`, sourceModule: `Module ${i % 60}`, targetModule: `Module ${(i + 1) % 60}`, dependencyType: "event", description: pad("Dependency", i), sourceWorkItemIds: [`${900 + i}`], evidence: `Dependency evidence ${i}` })),
  };
}

describe("dbg", () => {
  it("dumps", () => {
    const out: string[] = [];
    for (const tokens of [4_000, 16_000, 128_000, 200_000]) {
      for (const [label, b] of [["design", buildTestCaseGenerationMarkdownPrompt], ["analysis", buildRequirementAnalysisMarkdownPrompt]] as const) {
        const s = b({ currentProject: { azureProjectId: "a", azureProjectName: "b" }, targetRequirement: { id: 101, title: "Checkout" }, outputContract: {}, projectKnowledgeBase: kb(1000), maxInputTokens: tokens }).relevantProjectKnowledgeBase;
        out.push(`${tokens} ${label} ` + JSON.stringify({ m: s?.modules.length, br: s?.businessRules.length, st: s?.stateTransitions.length, g: s?.glossary.length, cd: s?.crossDependencies.length }));
      }
    }
    writeFileSync("dbg-out.txt", out.join("
"));
    expect(true).toBe(true);
  });
});
