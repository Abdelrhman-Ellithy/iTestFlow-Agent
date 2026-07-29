/**
 * Detects near-duplicate chunks within a ranked list.
 *
 * Identity-level dedup (same chunk id, same work item id) already exists at fusion and
 * citation building. This catches the case where two different work items have
 * templated or copy-pasted acceptance criteria: they get different chunk ids and work
 * item ids but are semantically redundant, occupying multiple top-K slots carrying the
 * same information and crowding out other sources.
 *
 * Similarity is measured via Jaccard index over word k-shingles, not embedding cosine:
 * vectors aren't uniformly available at the fusion point (a chunk surfacing via FTS or
 * trigram alone was never embedded), and cosine conflates "duplicate" with "topically
 * related" — exactly the axis where an earlier absolute-threshold approach failed
 * (measured on-topic margin fell below off-topic margin).
 *
 * The dedup is greedy over the *already-ranked* list: keep an item unless it's a
 * near-duplicate of an already-kept higher-ranked item. This reuses the shape of
 * applyPerWorkItemCap's loop, making it a filter that preserves ordering.
 */

const MIN_SHINGLE_LENGTH = 2;
const DEFAULT_JACCARD_THRESHOLD = 0.7;

/**
 * Splits text into word k-shingles (k=MIN_SHINGLE_LENGTH).
 *
 * Words are lowercased and normalized. Punctuation is stripped via a loose
 * non-alphanumeric boundary: "don't" → ["don", "t"], "test_case" → ["test", "case"].
 * Short shingles are noise; a 2-word window catches templated structures like
 * "Required Action: ..." while still needing multiple matching bigrams to call
 * something a duplicate.
 */
export function shingleSet(text: string, k: number = MIN_SHINGLE_LENGTH): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);

  const shingles = new Set<string>();
  // Only create shingles if we have enough words for at least one full k-gram.
  if (words.length >= k) {
    for (let i = 0; i <= words.length - k; i += 1) {
      const shingle = words.slice(i, i + k).join(" ");
      if (shingle.length > 0) shingles.add(shingle);
    }
  }
  return shingles;
}

/**
 * Jaccard similarity between two sets: |A ∩ B| / |A ∪ B|.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;
  const intersection = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union > 0 ? intersection / union : 0;
}

export type DedupeEntry<T> = {
  item: T;
  text: string;
};

/**
 * Greedy dedup over a ranked list.
 *
 * Iterates the input list in order (maintaining ranking). For each item, checks if it's
 * a near-duplicate of any already-kept item. If so, skips it. Otherwise keeps it.
 * Returns the deduplicated list in the same order.
 *
 * @param ranked the list to dedup, in rank order
 * @param threshold Jaccard similarity threshold [0, 1] for considering two items duplicates
 * @returns deduplicated list, subset of input, in original order
 */
export function dedupeNearDuplicateChunks<T>(
  ranked: DedupeEntry<T>[],
  threshold: number = DEFAULT_JACCARD_THRESHOLD,
): DedupeEntry<T>[] {
  const kept: DedupeEntry<T>[] = [];
  const keptShingles: Set<string>[] = [];

  for (const entry of ranked) {
    const entryShingles = shingleSet(entry.text);
    // Check against every kept item in order. If it's a duplicate of any, skip it.
    let isDuplicate = false;
    for (const keptSet of keptShingles) {
      if (jaccardSimilarity(entryShingles, keptSet) >= threshold) {
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) {
      kept.push(entry);
      keptShingles.push(entryShingles);
    }
  }
  return kept;
}
