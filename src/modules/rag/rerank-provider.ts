import "server-only";

import { rerankWithLocalModel, type LocalRerankDtype } from "./local-rerank";

/**
 * The reranking backend for retrieval precision: a local cross-encoder
 * (Xenova/ms-marco-MiniLM-L-6-v2, an ONNX build of cross-encoder/ms-marco-MiniLM-L-6-v2)
 * runs in-process via transformers.js/ONNX, auto-downloading quantized weights (~23 MB,
 * well under the embedding model's ~131 MB) into data/model-cache on first use -- the
 * same zero-config local-model pattern embedding-provider.ts uses.
 *
 * Unlike the embedding model, reranking is not load-bearing for anything persisted (no
 * vectors are stored from it, it only reorders a candidate list at query time), so
 * unlike embeddings it is safe to make this the one configurable RAG backend:
 * RERANK_PROVIDER=off disables it deployment-wide for an operator who wants to skip the
 * extra inference cost or cannot download the weights. Every caller treats a null
 * provider -- and a rerank failure -- identically to "skip reranking, keep the fused
 * order", so disabling it degrades precision but never breaks retrieval.
 */

export type RerankProvider = {
  name: "local";
  model: string;
  /** Scores align 1:1 with `texts`, in the same order; the caller does the sorting. */
  rerank(query: string, texts: string[]): Promise<number[]>;
};

export const RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
export const RERANK_DTYPE: LocalRerankDtype = "q8";

// A rerank batch runs each (query, passage) pair through its own full transformer
// forward pass with no computation shared across items -- a bi-encoder embeds each
// passage once and reuses it against every future query, a cross-encoder cannot.
// Pairs also pad to the batch's longest COMBINED sequence length. Smaller than
// MAX_EMBED_BATCH_SIZE (64) to keep peak memory bounded against that higher per-item
// cost; the wide candidate pool this feeds from is itself capped at 50 (see
// hybrid-chunk-search.ts), so this still means at most a handful of batches per call.
export const MAX_RERANK_BATCH_SIZE = 16;
// Document chunks run ~2000 chars; this bounds pathological inputs cheaply before they
// reach the tokenizer's own truncation (this model's max_position_embeddings is 512
// tokens, covering query + passage combined).
const MAX_RERANK_INPUT_CHARS = 2000;

/**
 * Resolves the deployment-configured rerank backend. Returns null when explicitly
 * disabled via RERANK_PROVIDER=off; every other value (including unset) resolves to
 * the local cross-encoder, matching this product's "on by default, opt out" stance for
 * local-model features.
 */
export function createRerankProvider(): RerankProvider | null {
  const mode = (process.env.RERANK_PROVIDER ?? "local").trim().toLowerCase();
  if (mode === "off") return null;
  return {
    name: "local",
    model: RERANK_MODEL,
    rerank: (query, texts) => rerankInBatches(query, texts),
  };
}

async function rerankInBatches(query: string, texts: string[]): Promise<number[]> {
  if (!texts.length) return [];
  const preparedQuery = query.slice(0, MAX_RERANK_INPUT_CHARS);
  const preparedTexts = texts.map((text) => text.slice(0, MAX_RERANK_INPUT_CHARS));
  const scores: number[] = [];
  for (let start = 0; start < preparedTexts.length; start += MAX_RERANK_BATCH_SIZE) {
    const batch = preparedTexts.slice(start, start + MAX_RERANK_BATCH_SIZE);
    const batchScores = await rerankWithLocalModel({
      model: RERANK_MODEL,
      dtype: RERANK_DTYPE,
      query: preparedQuery,
      texts: batch,
    });
    assertScoreCount(batchScores, batch.length);
    scores.push(...batchScores);
  }
  return scores;
}

function assertScoreCount(scores: number[], expected: number) {
  if (scores.length !== expected) {
    throw new Error(`Local reranker returned ${scores.length} scores for ${expected} inputs.`);
  }
}
