import "server-only";

import { embedWithLocalModel, type LocalEmbeddingDtype } from "./local-embedding";

/**
 * The embedding backend for semantic retrieval. There is exactly one, and it is not
 * configurable: nomic-embed-text-v1.5 runs in-process via transformers.js/ONNX,
 * auto-downloading quantized weights (~131 MB) into data/model-cache on first use.
 * No server to install, no API key, no environment variables, nothing for an
 * operator to get wrong.
 *
 * This is deliberately not pluggable. Swapping embedding models silently
 * invalidates every stored vector (they are only comparable within one model's
 * vector space), so a configurable backend turns a one-line settings change into a
 * full re-index that nothing in the product prompts for. Pinning one model keeps
 * stored vectors and query vectors permanently compatible.
 *
 * Callers still handle a failed embed: every retrieval path catches embedding
 * errors and degrades to full-text + trigram search, so a machine that cannot
 * download the model (offline, air-gapped) loses semantic ranking but keeps working.
 */

export type EmbeddingInputKind = "document" | "query";

export type EmbeddingProvider = {
  name: "local";
  model: string;
  /** Stable vector identity persisted per row, so a model change forces re-embedding. */
  vectorReference: string;
  embed(texts: string[], kind?: EmbeddingInputKind): Promise<number[][]>;
};

export const EMBEDDING_MODEL = "nomic-ai/nomic-embed-text-v1.5";
/** Quantized weights: ~131 MB, the accuracy/size tradeoff this product ships. */
export const EMBEDDING_DTYPE: LocalEmbeddingDtype = "q8";

/**
 * Identity of the model that produced a vector: weights plus precision. Callers
 * append their own text-recipe version to this (see embedding-store.service), because
 * what gets embedded is decided per pipeline, not by the provider.
 */
export const EMBEDDING_VECTOR_REFERENCE = `local:${EMBEDDING_MODEL}:${EMBEDDING_DTYPE}`;

// Nomic embedding models require task-specific prefixes for retrieval quality:
// the same sentence embeds differently as a stored document than as a search query.
const NOMIC_TASK_PREFIXES: Record<EmbeddingInputKind, string> = {
  document: "search_document: ",
  query: "search_query: ",
};

// Bounded so one inference call cannot exhaust memory on a large sync, and so a
// single failure loses at most one batch of work. Exported so callers that persist
// partial progress (embedding-store's per-batch insert) can slice work identically.
// This is the PERSISTENCE unit, not the inference unit -- see
// EMBED_INFERENCE_BATCH_SIZE, which is deliberately much smaller.
export const MAX_EMBED_BATCH_SIZE = 64;

/**
 * How many texts go through the model at once, independent of how many are persisted
 * together.
 *
 * A batch pads every sequence to the longest one in it, so mixing a 2,000-character
 * chunk with 200-character chunks makes the model compute the long shape for all of
 * them. Measured on a real corpus (median 258 chars, max 2,072) over the same 256
 * texts, time per text:
 *
 *   batch 64, arrival order   715ms   <- what this used to do
 *   batch 64, length-sorted   299ms
 *   batch 16, length-sorted   122ms
 *   batch  8, length-sorted   103ms
 *
 * Two separate effects: sorting removes the padding waste, and smaller batches are
 * additionally faster even once lengths are uniform. 16 takes nearly all of the
 * available win while keeping the number of inference calls (and their per-call
 * overhead) reasonable.
 */
export const EMBED_INFERENCE_BATCH_SIZE = 16;
// The model's context window is modest; chunks are ~2000 chars but query-side text
// (a whole requirement) can be far longer.
const MAX_EMBED_INPUT_CHARS = 8000;

/**
 * The embedding provider. Always available — there is no "off" and no null return;
 * callers that need to disable embeddings (tests) inject null at the seam instead.
 */
export function createEmbeddingProvider(): EmbeddingProvider {
  return {
    name: "local",
    model: EMBEDDING_MODEL,
    vectorReference: EMBEDDING_VECTOR_REFERENCE,
    embed: (texts, kind = "document") => embedInBatches(applyTaskPrefix(texts, kind)),
  };
}

function applyTaskPrefix(texts: string[], kind: EmbeddingInputKind) {
  const prefix = NOMIC_TASK_PREFIXES[kind];
  return texts.map((text) => prefix + text);
}

/**
 * Embeds every text, grouping similar lengths into the same inference batch so short
 * texts are not padded up to the longest one in the call (see
 * EMBED_INFERENCE_BATCH_SIZE for the measured cost of not doing this).
 *
 * Sorting is an internal detail: the returned array is in the caller's original order.
 * That contract is load-bearing rather than cosmetic — callers pair vectors with rows
 * positionally (`vectors[index]` against `batch[index]` in embedding-store), so an
 * off-by-one here would attach each chunk the wrong vector and corrupt retrieval
 * silently, with no error and no visibly wrong data. Hence the explicit scatter back
 * to original positions and the length assertion.
 */
async function embedInBatches(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const prepared = texts.map((text, index) => ({
    index,
    text: text.slice(0, MAX_EMBED_INPUT_CHARS),
  }));
  // Ties broken by original index so batching is deterministic for a given input.
  prepared.sort((first, second) => first.text.length - second.text.length || first.index - second.index);

  const vectors = new Array<number[] | undefined>(texts.length);
  for (let start = 0; start < prepared.length; start += EMBED_INFERENCE_BATCH_SIZE) {
    const batch = prepared.slice(start, start + EMBED_INFERENCE_BATCH_SIZE);
    const batchVectors = await embedWithLocalModel({
      model: EMBEDDING_MODEL,
      dtype: EMBEDDING_DTYPE,
      texts: batch.map((entry) => entry.text),
    });
    assertVectorCount(batchVectors, batch.length);
    for (const [position, entry] of batch.entries()) vectors[entry.index] = batchVectors[position];
  }

  // Every slot must be filled: a hole would mean a vector was dropped between sorting
  // and scattering, which positional pairing downstream cannot detect.
  const restored: number[][] = [];
  for (const [index, vector] of vectors.entries()) {
    if (!vector) throw new Error(`Local embeddings produced no vector for input ${index}.`);
    restored.push(vector);
  }
  return restored;
}

function assertVectorCount(vectors: number[][], expected: number) {
  if (vectors.length !== expected) {
    throw new Error(`Local embeddings returned ${vectors.length} vectors for ${expected} inputs.`);
  }
}
