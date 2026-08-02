import "server-only";

import path from "node:path";

/**
 * In-process cross-encoder inference via transformers.js (ONNX), mirroring
 * local-embedding.ts's loading mechanics (lazy dynamic import, shared data/model-cache
 * directory, a singleton loaded once and reused). A cross-encoder scores a (query,
 * passage) PAIR together in one transformer forward pass -- unlike the embedding
 * model, which encodes each text independently -- so this needs AutoTokenizer +
 * AutoModelForSequenceClassification rather than the feature-extraction pipeline.
 *
 * Verified against the installed @huggingface/transformers version's actual type
 * definitions (node_modules/@huggingface/transformers/types) rather than assumed from
 * memory, and spiked end-to-end (real weights downloaded, real inference run) before
 * this was written: AutoModelForSequenceClassification.from_pretrained returns a
 * callable model whose logits carry dims [batchSize, 1] for this model (a regression-
 * style single relevance score per pair, confirmed via its config.json's
 * id2label/label2id both being single-entry).
 */

export type LocalRerankDtype = "q8" | "fp16" | "fp32" | "q4";

type TokenizedPairs = Record<string, unknown>;

type RerankTokenizer = (
  queries: string[],
  options: { text_pair: string[]; padding: boolean; truncation: boolean },
) => TokenizedPairs;

type RerankModel = (inputs: TokenizedPairs) => Promise<{ logits: { data: ArrayLike<number> } }>;

type Reranker = { tokenizer: RerankTokenizer; model: RerankModel };

let rerankerKey = "";
let rerankerPromise: Promise<Reranker> | null = null;

export async function rerankWithLocalModel(input: {
  model: string;
  dtype: LocalRerankDtype;
  query: string;
  texts: string[];
}): Promise<number[]> {
  const key = `${input.model}::${input.dtype}`;
  if (!rerankerPromise || rerankerKey !== key) {
    rerankerKey = key;
    rerankerPromise = createReranker(input.model, input.dtype).catch((error) => {
      // A failed load (offline first run, bad model id) must not poison the
      // singleton forever; the next call retries.
      rerankerPromise = null;
      throw error;
    });
  }
  const { tokenizer, model } = await rerankerPromise;
  // Same query paired against every candidate passage; the tokenizer requires
  // `text` and `text_pair` to be arrays of equal length for a batch.
  const queries = input.texts.map(() => input.query);
  const encoded = tokenizer(queries, { text_pair: input.texts, padding: true, truncation: true });
  const output = await model(encoded);
  // Sigmoid rather than this model's own raw-logit default (its config.json records
  // sbert_ce_default_activation_function: Identity, i.e. no activation): a raw logit
  // can be negative (measured on this model), and downstream relevance display (see
  // project-context-store.service's normalizeRank) divides by the top score in a
  // result list, which breaks the moment that top score is <= 0. Sigmoid is
  // monotonic -- it reorders nothing -- and keeps every score positive and bounded
  // the way every other ranking signal in this codebase already is.
  return Array.from(output.logits.data).map(sigmoid);
}

function sigmoid(logit: number): number {
  return 1 / (1 + Math.exp(-logit));
}

async function createReranker(model: string, dtype: LocalRerankDtype): Promise<Reranker> {
  const transformers = await import("@huggingface/transformers");
  transformers.env.cacheDir = path.join(process.cwd(), "data", "model-cache");
  const [tokenizer, sequenceModel] = await Promise.all([
    transformers.AutoTokenizer.from_pretrained(model),
    transformers.AutoModelForSequenceClassification.from_pretrained(model, { dtype }),
  ]);
  return {
    tokenizer: tokenizer as unknown as RerankTokenizer,
    model: sequenceModel as unknown as RerankModel,
  };
}
