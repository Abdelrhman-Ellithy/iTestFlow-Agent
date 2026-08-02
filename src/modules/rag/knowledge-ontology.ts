import { buildAliasIndex, entityAliasKey, resolveAlias } from "./entity-aliases";
import type { ProjectKnowledgeBase } from "./project-knowledge.schema";

/**
 * A relationship graph over compiled project knowledge, used to decide which knowledge
 * a work item is actually connected to.
 *
 * Similarity alone answers "does this text resemble that text", which is not the same
 * question. Two modules can be phrased nothing alike and still be inseparable — a claim
 * is raised against a shipment, a shipment is issued against an order, an order is drawn
 * from a schedule — and a rule about the far end of that chain is relevant precisely
 * because of the chain, not because of its wording. Equally, a module can read as
 * similar to a work item and have nothing to do with it.
 *
 * Every edge here is read from the project's own compiled knowledge, so the graph is
 * whatever the board actually is. Boards differ sharply in which edges they carry: on
 * one measured project every business rule had a provenance link to a work item and two
 * thirds named a module, while the compiler had found almost no declared
 * module-to-module dependencies at all. Another board can be the reverse. A design
 * leaning on any single edge type would work on some boards and do nothing on others,
 * so all of them contribute and whichever exists carries the weight.
 *
 * Edges:
 * - **entry -> work item** (`sourceWorkItemIds`): the entry was extracted from that
 *   item. The strongest signal available, and the one present on every board.
 * - **entry -> module** (`moduleName` on rules and transitions).
 * - **module -> module** (`crossDependencies`), traversed in both directions: a
 *   dependency is a relationship, and relevance flows along it either way.
 * - **work item -> module**: the module's name appearing in the item's text, area path
 *   or tags.
 * - **work item -> glossary term**: the term appearing in the item's text. Glossary
 *   entries carry no module, so naming is the only structural edge they have — and a
 *   work item that uses a term is exactly the case where its definition is needed.
 *
 * Module identity is resolved through `entity-aliases` before any of this, because a
 * project names one module several ways and unresolved names become separate nodes. A
 * singular and its plural as two nodes is worse than no graph: rules filed under one
 * are unreachable from the other, and the traversal reports them unconnected.
 */

export type OntologyCategory =
  | "modules"
  | "businessRules"
  | "stateTransitions"
  | "glossary"
  | "crossDependencies"
  | "chatInsights";

/** Composite because entry keys are only unique within a category. */
export function ontologyEntryId(category: OntologyCategory, key: string) {
  return `${category}:${key}`;
}

export type KnowledgeOntology = {
  entryModule: Map<string, string>;
  moduleEntries: Map<string, string[]>;
  moduleNeighbours: Map<string, Set<string>>;
  moduleNamesByKey: Map<string, string>;
  moduleAliases: Map<string, string[]>;
  workItemEntries: Map<string, string[]>;
  glossaryTerms: Map<string, string>;
};

const EMPTY_ONTOLOGY: KnowledgeOntology = {
  entryModule: new Map(),
  moduleEntries: new Map(),
  moduleNeighbours: new Map(),
  moduleNamesByKey: new Map(),
  moduleAliases: new Map(),
  workItemEntries: new Map(),
  glossaryTerms: new Map(),
};

function moduleKeyResolver(knowledgeBase: ProjectKnowledgeBase) {
  // Every name the board uses for a module, wherever it says it: the module list, the
  // rules and transitions that cite one, and both ends of every declared dependency.
  const index = buildAliasIndex([
    ...knowledgeBase.modules.map((entry) => entry.name),
    ...knowledgeBase.businessRules.map((entry) => entry.moduleName ?? ""),
    ...knowledgeBase.stateTransitions.map((entry) => entry.moduleName ?? ""),
    ...knowledgeBase.crossDependencies.flatMap((entry) => [entry.sourceModule, entry.targetModule]),
  ]);
  return { index, key: (name: string | undefined | null) => resolveAlias(index, name) };
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

  const { index: aliasIndex, key: moduleKey } = moduleKeyResolver(knowledgeBase);
  const ontology: KnowledgeOntology = {
    entryModule: new Map(),
    moduleEntries: new Map(),
    moduleNeighbours: new Map(),
    moduleNamesByKey: new Map(),
    moduleAliases: new Map(),
    workItemEntries: new Map(),
    glossaryTerms: new Map(),
  };

  const attach = (
    category: OntologyCategory,
    key: string,
    owningModule: string | null,
    sourceWorkItemIds: string[] | undefined,
  ) => {
    const entryId = ontologyEntryId(category, key);
    if (owningModule) {
      ontology.entryModule.set(entryId, owningModule);
      push(ontology.moduleEntries, owningModule, entryId);
    }
    for (const workItemId of sourceWorkItemIds ?? []) {
      const trimmed = String(workItemId).trim();
      if (trimmed) push(ontology.workItemEntries, trimmed, entryId);
    }
  };

  for (const [name, key] of aliasIndex.canonicalKeyByName) {
    // Every surface form is retained as an anchor phrase, not just the canonical one:
    // a work item naming the plural must anchor the same node as one naming the
    // singular, and an abbreviation the same node as its expansion.
    push(ontology.moduleAliases, key, name);
  }

  for (const projectModule of knowledgeBase.modules) {
    const key = moduleKey(projectModule.name);
    if (!key) continue;
    ontology.moduleNamesByKey.set(key, aliasIndex.displayNameByKey.get(key) ?? projectModule.name);
    // A module is a member of itself, so anchoring a module also selects its own entry.
    attach("modules", projectModule.id, key, projectModule.sourceWorkItemIds);
  }

  for (const rule of knowledgeBase.businessRules) {
    attach("businessRules", rule.id, moduleKey(rule.moduleName), rule.sourceWorkItemIds);
  }
  for (const transition of knowledgeBase.stateTransitions) {
    attach("stateTransitions", transition.id, moduleKey(transition.moduleName), transition.sourceWorkItemIds);
  }
  for (const term of knowledgeBase.glossary) {
    attach("glossary", term.term, null, term.sourceWorkItemIds);
    if (term.term.trim()) ontology.glossaryTerms.set(ontologyEntryId("glossary", term.term), term.term);
  }
  for (const insight of knowledgeBase.chatInsights) {
    // No module edge: a chat insight is a free-form synthesis, not filed under a module
    // the way a rule or transition is. Provenance is the connection it has -- the work
    // items an admin cited when the answer was generated -- which is the strongest
    // signal this ontology has for anything.
    attach("chatInsights", insight.id, null, insight.sourceWorkItemIds);
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
 * One hop is too little to express "a claim depends on a shipment, which depends on an
 * order"; unbounded traversal reaches the whole board on any well-connected graph and
 * stops discriminating. Three keeps a chain of that shape intact while still ending
 * somewhere.
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
    const owningModule = ontology.entryModule.get(entryId);
    if (owningModule) anchoredModules.add(owningModule);
  }

  // Naming: a module the work item talks about, or files itself under. Area paths are
  // split on their separators so "Portal\\Activity Tracker" anchors Activity Tracker.
  // Normalised the same way names are, so a work item naming a module in the plural
  // matches the module registered in the singular.
  const haystack = ` ${entityAliasKey(anchors.text)} `;
  const mentions = (value: string) => {
    const needle = entityAliasKey(value);
    // Two characters match too much to be evidence of anything.
    return needle.length >= 3 && haystack.includes(` ${needle} `);
  };
  for (const [key, aliases] of ontology.moduleAliases) {
    if (aliases.some(mentions)) anchoredModules.add(key);
  }
  // A term the work item uses is a term the work item needs defined.
  for (const [entryId, term] of ontology.glossaryTerms) {
    if (mentions(term)) reach(entryId, 0);
  }

  // Spread outward along declared dependencies, one hop at a time.
  let frontier = [...anchoredModules];
  const visitedModules = new Set(frontier);
  for (let hops = 0; frontier.length && hops <= MAX_DEPENDENCY_HOPS; hops += 1) {
    for (const moduleAtDistance of frontier) {
      for (const entryId of ontology.moduleEntries.get(moduleAtDistance) ?? []) reach(entryId, hops);
    }
    const next: string[] = [];
    for (const moduleAtDistance of frontier) {
      for (const neighbour of ontology.moduleNeighbours.get(moduleAtDistance) ?? []) {
        if (visitedModules.has(neighbour)) continue;
        visitedModules.add(neighbour);
        next.push(neighbour);
      }
    }
    frontier = next;
  }

  return connected;
}
