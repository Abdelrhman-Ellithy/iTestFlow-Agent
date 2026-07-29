import { canonicalizeProjectKnowledgeKey } from "./project-knowledge-contracts";
import type { ProjectKnowledgeBase } from "./project-knowledge.schema";

/**
 * A relationship graph over compiled project knowledge, used to decide which knowledge
 * a work item is actually connected to.
 *
 * Similarity alone answers "does this text resemble that text", which is not the same
 * question. Two modules can be phrased nothing alike and still be inseparable — a
 * change request depends on a waybill, which depends on a transport order, which
 * depends on the master plan — and a rule about the far end of that chain is relevant
 * precisely because of the chain, not because of its wording. Equally, a module can
 * read as similar to a work item and have nothing to do with it.
 *
 * Every edge here is read from the project's own compiled knowledge, so the graph is
 * whatever the board actually is. Boards differ sharply in which edges they carry: on
 * one real project 114 of 114 business rules had provenance links to work items and 76
 * carried a module, while the compiler had found only 2 declared module-to-module
 * dependencies across 39 modules. A design leaning on any single edge type would work
 * on some boards and do nothing on others, so all of them contribute and whichever
 * exists carries the weight.
 *
 * Edges:
 * - **entry -> work item** (`sourceWorkItemIds`): the entry was extracted from that
 *   item. The strongest signal available, and the one present on every board.
 * - **entry -> module** (`moduleName` on rules and transitions).
 * - **module -> module** (`crossDependencies`), traversed in both directions: a
 *   dependency is a relationship, and relevance flows along it either way.
 * - **work item -> module**: the module's name appearing in the item's text, area path
 *   or tags.
 */

export type OntologyCategory =
  | "modules"
  | "businessRules"
  | "stateTransitions"
  | "glossary"
  | "crossDependencies";

/** Composite because entry keys are only unique within a category. */
export function ontologyEntryId(category: OntologyCategory, key: string) {
  return `${category}:${key}`;
}

export type KnowledgeOntology = {
  entryModule: Map<string, string>;
  moduleEntries: Map<string, string[]>;
  moduleNeighbours: Map<string, Set<string>>;
  moduleNamesByKey: Map<string, string>;
  workItemEntries: Map<string, string[]>;
};

const EMPTY_ONTOLOGY: KnowledgeOntology = {
  entryModule: new Map(),
  moduleEntries: new Map(),
  moduleNeighbours: new Map(),
  moduleNamesByKey: new Map(),
  workItemEntries: new Map(),
};

function moduleKey(name: string | undefined | null) {
  const trimmed = name?.trim();
  return trimmed ? canonicalizeProjectKnowledgeKey(trimmed) : null;
}

function push(index: Map<string, string[]>, key: string, value: string) {
  const existing = index.get(key);
  if (existing) existing.push(value);
  else index.set(key, [value]);
}

function link(index: Map<string, Set<string>>, from: string, to: string) {
  (index.get(from) ?? index.set(from, new Set()).get(from)!).add(to);
}

export function buildKnowledgeOntology(knowledgeBase: ProjectKnowledgeBase | null | undefined): KnowledgeOntology {
  if (!knowledgeBase) return EMPTY_ONTOLOGY;

  const ontology: KnowledgeOntology = {
    entryModule: new Map(),
    moduleEntries: new Map(),
    moduleNeighbours: new Map(),
    moduleNamesByKey: new Map(),
    workItemEntries: new Map(),
  };

  const attach = (
    category: OntologyCategory,
    key: string,
    module: string | null,
    sourceWorkItemIds: string[] | undefined,
  ) => {
    const entryId = ontologyEntryId(category, key);
    if (module) {
      ontology.entryModule.set(entryId, module);
      push(ontology.moduleEntries, module, entryId);
    }
    for (const workItemId of sourceWorkItemIds ?? []) {
      const trimmed = String(workItemId).trim();
      if (trimmed) push(ontology.workItemEntries, trimmed, entryId);
    }
  };

  for (const module of knowledgeBase.modules) {
    const key = moduleKey(module.name);
    if (!key) continue;
    ontology.moduleNamesByKey.set(key, module.name);
    // A module is a member of itself, so anchoring a module also selects its own entry.
    attach("modules", module.id, key, module.sourceWorkItemIds);
  }

  for (const rule of knowledgeBase.businessRules) {
    attach("businessRules", rule.id, moduleKey(rule.moduleName), rule.sourceWorkItemIds);
  }
  for (const transition of knowledgeBase.stateTransitions) {
    attach("stateTransitions", transition.id, moduleKey(transition.moduleName), transition.sourceWorkItemIds);
  }
  for (const term of knowledgeBase.glossary) {
    attach("glossary", term.term, null, term.sourceWorkItemIds);
  }

  for (const dependency of knowledgeBase.crossDependencies) {
    const source = moduleKey(dependency.sourceModule);
    const target = moduleKey(dependency.targetModule);
    // A dependency belongs to both endpoints, so anchoring either one surfaces it.
    const entryId = ontologyEntryId("crossDependencies", dependency.id);
    for (const endpoint of [source, target]) {
      if (!endpoint) continue;
      ontology.entryModule.set(entryId, endpoint);
      push(ontology.moduleEntries, endpoint, entryId);
    }
    for (const workItemId of dependency.sourceWorkItemIds ?? []) {
      const trimmed = String(workItemId).trim();
      if (trimmed) push(ontology.workItemEntries, trimmed, entryId);
    }
    if (source && target) {
      link(ontology.moduleNeighbours, source, target);
      link(ontology.moduleNeighbours, target, source);
    }
  }

  return ontology;
}

/**
 * How far dependency edges are followed away from the anchored modules.
 *
 * One hop is too little to express "a change request depends on a waybill, which
 * depends on a transport order"; unbounded traversal reaches the whole board on any
 * well-connected graph and stops discriminating. Three keeps a chain of that shape
 * intact while still ending somewhere.
 */
export const MAX_DEPENDENCY_HOPS = 3;

export type OntologyAnchors = {
  /** The work item under analysis, and anything Azure DevOps links it to. */
  workItemIds: string[];
  /** Free text used to detect module names: title, description, area path, tags. */
  text: string;
};

/**
 * Returns the ids of entries connected to the anchors, with the number of hops it took
 * to reach them. Entries absent from the result are not connected at all.
 */
export function resolveConnectedEntries(
  ontology: KnowledgeOntology,
  anchors: OntologyAnchors,
): Map<string, number> {
  const connected = new Map<string, number>();
  const reach = (entryId: string, hops: number) => {
    const existing = connected.get(entryId);
    if (existing === undefined || hops < existing) connected.set(entryId, hops);
  };

  // Provenance: entries extracted from the work item itself, or from something it links
  // to. Nothing beats "this rule came from this requirement".
  for (const workItemId of anchors.workItemIds) {
    for (const entryId of ontology.workItemEntries.get(String(workItemId).trim()) ?? []) {
      reach(entryId, 0);
    }
  }

  const anchoredModules = new Set<string>();
  for (const entryId of connected.keys()) {
    const module = ontology.entryModule.get(entryId);
    if (module) anchoredModules.add(module);
  }

  // Naming: a module the work item talks about, or files itself under. Area paths are
  // split on their separators so "Portal\\Activity Tracker" anchors Activity Tracker.
  const haystack = ` ${anchors.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
  for (const [key, name] of ontology.moduleNamesByKey) {
    const needle = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    // Two characters match too much to be evidence of anything.
    if (needle.length < 3) continue;
    if (haystack.includes(` ${needle} `)) anchoredModules.add(key);
  }

  // Spread outward along declared dependencies, one hop at a time.
  let frontier = [...anchoredModules];
  const visitedModules = new Set(frontier);
  for (let hops = 1; frontier.length && hops <= MAX_DEPENDENCY_HOPS; hops += 1) {
    for (const module of frontier) {
      for (const entryId of ontology.moduleEntries.get(module) ?? []) reach(entryId, hops - 1);
    }
    const next: string[] = [];
    for (const module of frontier) {
      for (const neighbour of ontology.moduleNeighbours.get(module) ?? []) {
        if (visitedModules.has(neighbour)) continue;
        visitedModules.add(neighbour);
        next.push(neighbour);
      }
    }
    frontier = next;
  }

  return connected;
}
