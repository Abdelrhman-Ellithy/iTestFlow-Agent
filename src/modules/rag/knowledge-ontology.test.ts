import { describe, expect, it } from "vitest";

import {
  buildKnowledgeOntology,
  MAX_DEPENDENCY_HOPS,
  ontologyEntryId,
  resolveConnectedEntries,
} from "@/modules/rag/knowledge-ontology";
import type { ProjectKnowledgeBase } from "@/modules/rag/project-knowledge.schema";

/**
 * A board where modules genuinely depend on one another: a change request is raised
 * against a waybill, a waybill is issued against a transport order, and a transport
 * order is drawn from the master plan. Nothing in the wording of a master plan rule
 * resembles a change request work item — the chain is the only thing that connects
 * them, and it is the project's own compiled knowledge that states it.
 */
function chainedBoard(): ProjectKnowledgeBase {
  const projectModule = (id: string, name: string, workItems: string[] = []) => ({
    id, name, description: `${name} module`, sourceWorkItemIds: workItems, evidence: `${name} evidence`,
  });
  const rule = (id: string, moduleName: string, workItems: string[] = []) => ({
    id, rule: `Rule ${id}`, sourceField: "description", moduleName,
    sourceWorkItemIds: workItems, evidence: `Evidence ${id}`,
  });
  const dependency = (id: string, sourceModule: string, targetModule: string) => ({
    id, sourceModule, targetModule, dependencyType: "service dependency",
    description: `${sourceModule} depends on ${targetModule}`, sourceWorkItemIds: [], evidence: "dep",
  });

  return {
    modules: [
      projectModule("mod-bcr", "BCR"),
      projectModule("mod-waybill", "Waybill"),
      projectModule("mod-to", "PO / TO Request"),
      projectModule("mod-plan", "Master Plan"),
      projectModule("mod-helpdesk", "HelpDesk"),
    ],
    businessRules: [
      rule("rule-bcr", "BCR", ["900"]),
      rule("rule-waybill", "Waybill"),
      rule("rule-to", "PO / TO Request"),
      rule("rule-plan", "Master Plan"),
      rule("rule-helpdesk", "HelpDesk"),
      rule("rule-orphan", ""),
    ],
    stateTransitions: [
      {
        id: "st-bcr", workflowName: "Change Request Workflow", fromState: "Draft", toState: "Raised",
        triggerOrCondition: "Submitted", actor: "Requester", moduleName: "BCR",
        sourceWorkItemIds: [], evidence: "transition evidence",
      },
    ],
    glossary: [
      { term: "Waybill", type: "term", definition: "A transport document", sourceWorkItemIds: ["901"], evidence: "g" },
    ],
    crossDependencies: [
      dependency("dep-bcr-waybill", "BCR", "Waybill"),
      dependency("dep-waybill-to", "Waybill", "PO / TO Request"),
      dependency("dep-to-plan", "PO / TO Request", "Master Plan"),
    ],
  } as ProjectKnowledgeBase;
}

describe("buildKnowledgeOntology", () => {
  it("indexes every edge type the board carries", () => {
    const ontology = buildKnowledgeOntology(chainedBoard());

    expect(ontology.moduleNamesByKey.size).toBe(5);
    expect(ontology.workItemEntries.get("900")).toContain(ontologyEntryId("businessRules", "rule-bcr"));
    expect(ontology.workItemEntries.get("901")).toContain(ontologyEntryId("glossary", "Waybill"));
    expect([...(ontology.moduleNeighbours.get("bcr") ?? [])]).toContain("waybill");
  });

  it("treats a dependency as bidirectional", () => {
    // A dependency is a relationship. A work item in Waybill is as entitled to know
    // that BCR depends on it as the reverse.
    const ontology = buildKnowledgeOntology(chainedBoard());

    expect([...(ontology.moduleNeighbours.get("waybill") ?? [])]).toContain("bcr");
  });

  it("survives a knowledge base with no relationships at all", () => {
    const ontology = buildKnowledgeOntology({
      modules: [], businessRules: [], stateTransitions: [], glossary: [], crossDependencies: [],
    } as unknown as ProjectKnowledgeBase);

    expect(resolveConnectedEntries(ontology, { workItemIds: ["1"], text: "anything" }).size).toBe(0);
  });

  it("returns an empty graph for a project with no compiled knowledge", () => {
    expect(buildKnowledgeOntology(null).moduleNamesByKey.size).toBe(0);
  });
});

describe("resolveConnectedEntries", () => {
  const ontology = buildKnowledgeOntology(chainedBoard());

  it("follows a dependency chain across several modules", () => {
    // The whole point: a Master Plan rule is three dependency hops from a BCR work
    // item and shares no wording with it, yet it is exactly the rule a tester needs.
    const connected = resolveConnectedEntries(ontology, {
      workItemIds: [],
      text: "Change request raised in the BCR screen is not reflected",
    });

    expect(connected.has(ontologyEntryId("businessRules", "rule-bcr"))).toBe(true);
    expect(connected.has(ontologyEntryId("businessRules", "rule-waybill"))).toBe(true);
    expect(connected.has(ontologyEntryId("businessRules", "rule-to"))).toBe(true);
    expect(connected.has(ontologyEntryId("businessRules", "rule-plan"))).toBe(true);
  });

  it("does not reach a module that has no path to the anchor", () => {
    // HelpDesk exists on the same board and is named nowhere in the chain. Adaptive
    // means the graph excludes it, not that a category was judged noisy in advance.
    const connected = resolveConnectedEntries(ontology, {
      workItemIds: [],
      text: "Change request raised in the BCR screen is not reflected",
    });

    expect(connected.has(ontologyEntryId("businessRules", "rule-helpdesk"))).toBe(false);
    expect(connected.has(ontologyEntryId("modules", "mod-helpdesk"))).toBe(false);
  });

  it("reports increasing hop distance along the chain", () => {
    const connected = resolveConnectedEntries(ontology, { workItemIds: [], text: "BCR issue" });

    const bcr = connected.get(ontologyEntryId("businessRules", "rule-bcr"))!;
    const waybill = connected.get(ontologyEntryId("businessRules", "rule-waybill"))!;
    const plan = connected.get(ontologyEntryId("businessRules", "rule-plan"))!;

    expect(bcr).toBeLessThan(waybill);
    expect(waybill).toBeLessThan(plan);
    expect(plan).toBeLessThanOrEqual(MAX_DEPENDENCY_HOPS);
  });

  it("anchors on provenance without needing the module to be named", () => {
    // The work item text mentions no module. The rule was extracted from work item
    // 900, which is the strongest statement of relevance the board can make.
    const connected = resolveConnectedEntries(ontology, {
      workItemIds: ["900"],
      text: "Attachment does not open after upload",
    });

    expect(connected.get(ontologyEntryId("businessRules", "rule-bcr"))).toBe(0);
    // ...and the chain still opens up from the module that rule belongs to.
    expect(connected.has(ontologyEntryId("businessRules", "rule-waybill"))).toBe(true);
  });

  it("anchors on the area path, where boards state module membership without saying it", () => {
    const connected = resolveConnectedEntries(ontology, {
      workItemIds: [],
      text: "Some title with no module name\\nPortal\\\\Logistics\\\\Waybill",
    });

    expect(connected.has(ontologyEntryId("businessRules", "rule-waybill"))).toBe(true);
  });

  it("does not anchor on a module name that merely appears inside a longer word", () => {
    const connected = resolveConnectedEntries(ontology, {
      workItemIds: [],
      text: "The BCRs dashboard shows subBCRitems",
    });

    // "BCR" is a substring of both, but neither is a mention of the module.
    expect(connected.has(ontologyEntryId("businessRules", "rule-helpdesk"))).toBe(false);
  });

  it("connects a glossary term the work item actually uses", () => {
    // Glossary entries carry no module, so provenance and naming are their only edges.
    // A bug titled "... not visible in the provider activity log" needs the definition
    // of the term it is named after, whichever work item that definition came from.
    const connected = resolveConnectedEntries(ontology, {
      workItemIds: [],
      text: "Waybill document does not render for the driver",
    });

    expect(connected.get(ontologyEntryId("glossary", "Waybill"))).toBe(0);
  });

  it("connects nothing when the work item names no module and links to nothing", () => {
    const connected = resolveConnectedEntries(ontology, {
      workItemIds: ["nonexistent"],
      text: "A completely unrelated observation",
    });

    expect(connected.size).toBe(0);
  });
});
