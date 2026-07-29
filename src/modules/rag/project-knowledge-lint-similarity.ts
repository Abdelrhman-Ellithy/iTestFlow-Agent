import { acronymOf, entityAliasKey } from "./entity-aliases";
import type { ProjectKnowledgeBase } from "./project-knowledge.schema";
import type { ProjectKnowledgeLintIssue } from "./project-knowledge-compiled.service";

type NameSimilarityIssue = Omit<ProjectKnowledgeLintIssue, "id" | "createdAt" | "updatedAt" | "status" | "origin">;

function normalizeKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Canonical form for name-similarity comparison: lowercase, punctuation stripped,
 * and generic head/qualifier words removed so "Payment Service" and "Payment"
 * compare as the same token set.
 */
export function similarityKey(value: string) {
  return normalizeKey(value)
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(the|a|an|module|system|service)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Two canonical names are similar only when they share at least two words that
 * cover ≥66% of the larger name's word set. A raw substring test was removed
 * deliberately: after stopword stripping it collapsed whole families to one head
 * noun ("payment") and flagged every entry containing it, flooding the lint panel.
 */
export function areNamesSimilar(first: string, second: string) {
  if (first.length < 5 || second.length < 5) return false;
  const firstWords = new Set(first.split(" "));
  const secondWords = new Set(second.split(" "));
  const overlap = Array.from(firstWords).filter((word) => secondWords.has(word)).length;
  return overlap >= 2 && overlap / Math.max(firstWords.size, secondWords.size) >= 0.66;
}

export function addNameSimilarityIssues(
  knowledgeBase: ProjectKnowledgeBase,
  issues: NameSimilarityIssue[],
) {
  const names = [
    ...knowledgeBase.modules.map((entry) => ({
      category: "module",
      entryKey: entry.id,
      name: entry.name,
      sourceWorkItemIds: entry.sourceWorkItemIds,
    })),
    ...knowledgeBase.glossary.map((entry) => ({
      category: "glossary",
      entryKey: entry.term,
      name: entry.term,
      sourceWorkItemIds: entry.sourceWorkItemIds,
    })),
  ];
  for (let firstIndex = 0; firstIndex < names.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < names.length; secondIndex += 1) {
      const first = names[firstIndex];
      const second = names[secondIndex];
      const firstKey = similarityKey(first.name);
      const secondKey = similarityKey(second.name);
      if (firstKey === secondKey || !areNamesSimilar(firstKey, secondKey)) continue;
      issues.push({
        issueType: "similar_name",
        severity: "warning",
        title: `Potential duplicate names: ${first.name} / ${second.name}`,
        message: "Canonical name similarity indicates that these entries may represent the same subject. Review before merging.",
        category: first.category === second.category ? first.category : "cross_category",
        entryKey: [first.entryKey, second.entryKey].sort().join(" | "),
        sourceWorkItemIds: Array.from(new Set([...first.sourceWorkItemIds, ...second.sourceWorkItemIds])),
      });
    }
  }

  addEntityNamingIssues(names, issues);
}

/**
 * Flags naming variants that word-overlap similarity cannot see.
 *
 * `areNamesSimilar` needs two shared words, so it never reports the most common
 * fragmentation there is: a plural. On a real board several module identities were
 * split between a singular and a plural spelling and none were reported, each one
 * dividing that module's rules across two entries with separate evidence.
 *
 * Retrieval resolves these to one identity so the relationship graph does not fragment,
 * but the knowledge base still holds two entries, and that is a curation problem only a
 * person can close.
 */
function addEntityNamingIssues(
  names: { category: string; entryKey: string; name: string; sourceWorkItemIds: string[] }[],
  issues: NameSimilarityIssue[],
) {
  const byAliasKey = new Map<string, typeof names>();
  for (const entry of names) {
    const key = entityAliasKey(entry.name);
    if (!key) continue;
    const existing = byAliasKey.get(key);
    if (existing) existing.push(entry);
    else byAliasKey.set(key, [entry]);
  }

  for (const [, group] of byAliasKey) {
    const distinct = Array.from(new Set(group.map((entry) => entry.name)));
    if (distinct.length < 2) continue;
    // Names that `similarityKey` already reduces to one form are this file's existing
    // deliberate carve-out — they differ only by a generic head word, which the
    // consolidation pass owns. This pass adds the cases word overlap cannot see.
    if (new Set(distinct.map(similarityKey)).size < 2) continue;
    issues.push({
      issueType: "similar_name",
      severity: "warning",
      title: `Same entity written several ways: ${distinct.join(" / ")}`,
      message:
        "These names differ only by pluralisation, punctuation or a generic word such as \"module\". They almost certainly describe one subject, and holding them as separate entries splits its rules and evidence.",
      category: group.every((entry) => entry.category === group[0].category) ? group[0].category : "cross_category",
      entryKey: Array.from(new Set(group.map((entry) => entry.entryKey))).sort().join(" | "),
      sourceWorkItemIds: Array.from(new Set(group.flatMap((entry) => entry.sourceWorkItemIds))),
    });
  }

  // An acronym that could expand two ways cannot be resolved automatically without
  // guessing which was meant, so the project has to say.
  const expansionsByAcronym = new Map<string, string[]>();
  for (const key of byAliasKey.keys()) {
    const acronym = acronymOf(key);
    if (!acronym) continue;
    const existing = expansionsByAcronym.get(acronym);
    if (existing) existing.push(key);
    else expansionsByAcronym.set(acronym, [key]);
  }
  for (const [acronym, expansions] of expansionsByAcronym) {
    const group = byAliasKey.get(acronym);
    if (!group || expansions.length < 2) continue;
    issues.push({
      issueType: "similar_name",
      severity: "warning",
      title: `Ambiguous abbreviation: ${group[0].name}`,
      message: `"${group[0].name}" reads as an abbreviation of ${expansions.length} entries on this board (${expansions.join(", ")}). Retrieval will not guess which, so it is treated as its own subject until the duplicate is merged or renamed.`,
      category: group[0].category,
      entryKey: Array.from(new Set(group.map((entry) => entry.entryKey))).sort().join(" | "),
      sourceWorkItemIds: Array.from(new Set(group.flatMap((entry) => entry.sourceWorkItemIds))),
    });
  }
}
