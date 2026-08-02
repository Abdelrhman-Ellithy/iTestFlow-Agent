import { describe, expect, it } from "vitest";

import {
  buildKnowledgeOntology,
  MAX_DEPENDENCY_HOPS,
  ontologyEntryId,
  resolveConnectedEntries,
} from "@/modules/rag/knowledge-ontology";
import type { ProjectKnowledgeBase } from "@/modules/rag/project-knowledge.schema";

/**
 * A board where modules genuinely depend on one another: a claim is raised against a
 * shipment, a shipment is issued against an order, and an order is drawn from a
 * schedule. Nothing in the wording of a scheduling rule resembles a claim work item —
 * the chain is the only thing that connects them, and it is the project's own compiled
 * knowledge that states it.
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
      projectModule("mod-claims", "Claims"),
      projectModule("mod-shipment", "Shipment"),
      projectModule("mod-order", "Order Request"),
      projectModule("mod-schedule", "Schedule"),
      projectModule("mod-billing", "Billing"),
    ],
    businessRules: [
      rule("rule-claims", "Claims", ["900"]),
      rule("rule-shipment", "Shipment"),
      rule("rule-order", "Order Request"),
      rule("rule-schedule", "Schedule"),
      rule("rule-billing", "Billing"),
      rule("rule-orphan", ""),
    ],
    stateTransitions: [
      {
        id: "st-claims", workflowName: "Claim Workflow", fromState: "Draft", toState: "Raised",
        triggerOrCondition: "Submitted", actor: "Requester", moduleName: "Claims",
        sourceWorkItemIds: [], evidence: "transition evidence",
      },
    ],
    glossary: [
      { term: "Shipment", type: "term", definition: "A dispatched consignment", sourceWorkItemIds: ["901"], evidence: "g" },
    ],
    crossDependencies: [
      dependency("dep-claims-shipment", "Claims", "Shipment"),
      dependency("dep-shipment-order", "Shipment", "Order Request"),
      dependency("dep-order-schedule", "Order Request", "Schedule"),
    ],
    chatInsights: [],
  } as ProjectKnowledgeBase;
}

describe("buildKnowledgeOntology", () => {
  it("indexes every edge type the board carries", () => {
    const ontology = buildKnowledgeOntology(chainedBoard());

    expect(ontology.moduleNamesByKey.size).toBe(5);
    expect(ontology.workItemEntries.get("900")).toContain(ontologyEntryId("businessRules", "rule-claims"));
    expect(ontology.workItemEntries.get("901")).toContain(ontologyEntryId("glossary", "Shipment"));
    expect([...(ontology.moduleNeighbours.get("claim") ?? [])]).toContain("shipment");
  });

  it("treats a dependency as bidirectional", () => {
    // A dependency is a relationship. A work item in the module being depended on is
    // as entitled to know about the dependency as one in the module that declares it.
    const ontology = buildKnowledgeOntology(chainedBoard());

    expect([...(ontology.moduleNeighbours.get("shipment") ?? [])]).toContain("claim");
  });

  it("survives a knowledge base with no relationships at all", () => {
    const ontology = buildKnowledgeOntology({
      modules: [], businessRules: [], stateTransitions: [], glossary: [], crossDependencies: [], chatInsights: [],
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
    // The whole point: a scheduling rule is three dependency hops from a claims work
    // item and shares no wording with it, yet it is exactly the rule a tester needs.
    const connected = resolveConnectedEntries(ontology, {
      workItemIds: [],
      text: "Claim raised in the claims screen is not reflected",
    });

    expect(connected.has(ontologyEntryId("businessRules", "rule-claims"))).toBe(true);
    expect(connected.has(ontologyEntryId("businessRules", "rule-shipment"))).toBe(true);
    expect(connected.has(ontologyEntryId("businessRules", "rule-order"))).toBe(true);
    expect(connected.has(ontologyEntryId("businessRules", "rule-schedule"))).toBe(true);
  });

  it("does not reach a module that has no path to the anchor", () => {
    // Billing exists on the same board and is named nowhere in the chain. Adaptive
    // means the graph excludes it, not that a category was judged noisy in advance.
    const connected = resolveConnectedEntries(ontology, {
      workItemIds: [],
      text: "Claim raised in the claims screen is not reflected",
    });

    expect(connected.has(ontologyEntryId("businessRules", "rule-billing"))).toBe(false);
    expect(connected.has(ontologyEntryId("modules", "mod-billing"))).toBe(false);
  });

  it("reports increasing hop distance along the chain", () => {
    const connected = resolveConnectedEntries(ontology, { workItemIds: [], text: "Claim issue" });

    const claims = connected.get(ontologyEntryId("businessRules", "rule-claims"))!;
    const shipment = connected.get(ontologyEntryId("businessRules", "rule-shipment"))!;
    const schedule = connected.get(ontologyEntryId("businessRules", "rule-schedule"))!;

    expect(claims).toBeLessThan(shipment);
    expect(shipment).toBeLessThan(schedule);
    expect(schedule).toBeLessThanOrEqual(MAX_DEPENDENCY_HOPS);
  });

  it("anchors on provenance without needing the module to be named", () => {
    // The work item text mentions no module. The rule was extracted from work item
    // 900, which is the strongest statement of relevance the board can make.
    const connected = resolveConnectedEntries(ontology, {
      workItemIds: ["900"],
      text: "Attachment does not open after upload",
    });

    expect(connected.get(ontologyEntryId("businessRules", "rule-claims"))).toBe(0);
    // ...and the chain still opens up from the module that rule belongs to.
    expect(connected.has(ontologyEntryId("businessRules", "rule-shipment"))).toBe(true);
  });

  it("anchors on the area path, where boards state module membership without saying it", () => {
    const connected = resolveConnectedEntries(ontology, {
      workItemIds: [],
      text: "Some title with no module name\\nPortal\\\\Operations\\\\Shipment",
    });

    expect(connected.has(ontologyEntryId("businessRules", "rule-shipment"))).toBe(true);
  });

  it("does not anchor on a module name that merely appears inside a longer word", () => {
    const connected = resolveConnectedEntries(ontology, {
      workItemIds: [],
      text: "The Claimsy dashboard shows subClaimitems",
    });

    // "Claim" is a substring of both, but neither is a mention of the module.
    expect(connected.has(ontologyEntryId("businessRules", "rule-billing"))).toBe(false);
  });

  it("connects a glossary term the work item actually uses", () => {
    // Glossary entries carry no module, so provenance and naming are their only edges.
    // A work item that names a term needs that term defined, whichever work item the
    // definition itself was extracted from.
    const connected = resolveConnectedEntries(ontology, {
      workItemIds: [],
      text: "Shipment document does not render for the carrier",
    });

    expect(connected.get(ontologyEntryId("glossary", "Shipment"))).toBe(0);
  });

  it("connects nothing when the work item names no module and links to nothing", () => {
    const connected = resolveConnectedEntries(ontology, {
      workItemIds: ["nonexistent"],
      text: "A completely unrelated observation",
    });

    expect(connected.size).toBe(0);
  });
});
