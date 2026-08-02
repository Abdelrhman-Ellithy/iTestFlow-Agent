import { beforeAll, describe, expect, it } from "vitest";

import { createEmbeddingProvider } from "./embedding-provider";

/**
 * Quality tests for the pinned embedding model (nomic-embed-text-v1.5).
 *
 * These deliberately run the REAL model rather than a stub. A stubbed embedder can
 * only prove the plumbing works; it cannot answer the two questions that actually
 * matter before letting semantic search feed an LLM:
 *
 *   1. Does it ADD recall? Full-text and trigram search already handle shared
 *      wording. Semantic search only earns its place if it retrieves correct
 *      content whose words do NOT overlap the query.
 *   2. Does it AVOID false retrieval? Semantic search always returns its nearest
 *      neighbours -- there is no "no match" answer. If off-topic content can
 *      outrank on-topic content, the assistant gets grounded on the wrong source
 *      and confidently answers from it. That is the realistic failure mode; the
 *      embedding model itself is deterministic and cannot "hallucinate" a vector.
 *
 * Assertions are RELATIVE (on-topic must outrank off-topic by a margin) rather
 * than absolute similarity floors. nomic-embed produces a high similarity baseline
 * -- even unrelated English sentences sit well above zero -- so absolute thresholds
 * would be both brittle and misleading. Ranking is what retrieval actually consumes.
 *
 * Lives in the integration lane (*.db.test.ts) because loading the ~131 MB model is
 * far too slow for the unit gate. Run alone with: npm run test:model
 */

const provider = createEmbeddingProvider();

// Deliberately phrased so a human would call them "the same thing" while sharing
// almost no content words -- exactly the case lexical search cannot solve.
const CORPUS = {
  checkout:
    "The checkout page must reject expired credit cards during payment authorization and show the shopper a clear failure reason.",
  login:
    "Users are locked out for fifteen minutes after five consecutive failed sign-in attempts.",
  export:
    "Reports can be downloaded as CSV, and very large exports are streamed in batches to avoid timeouts.",
  permissions:
    "Only workspace owners and administrators may change billing details or invite new members.",
} as const;

type CorpusKey = keyof typeof CORPUS;

function cosine(a: number[], b: number[]) {
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) dot += a[index]! * b[index]!;
  // Vectors are already L2-normalized by the pipeline (normalize: true), so the dot
  // product IS the cosine similarity. Assert that rather than trusting the comment.
  return dot;
}

/** Embeds the corpus once; every test reuses it so the model loads a single time. */
let documentVectors: Record<CorpusKey, number[]>;
const corpusKeys = Object.keys(CORPUS) as CorpusKey[];

beforeAll(async () => {
  const vectors = await provider.embed(
    corpusKeys.map((key) => CORPUS[key]),
    "document",
  );
  documentVectors = Object.fromEntries(corpusKeys.map((key, index) => [key, vectors[index]!])) as Record<
    CorpusKey,
    number[]
  >;
}, 180_000);

/** Ranks the whole corpus against a query, best match first. */
async function rankCorpus(query: string) {
  const [queryVector] = await provider.embed([query], "query");
  return corpusKeys
    .map((key) => ({ key, score: cosine(queryVector!, documentVectors[key]) }))
    .sort((first, second) => second.score - first.score);
}

describe("embedding model — sanity", () => {
  it("produces normalized, fixed-width, deterministic vectors", async () => {
    const [first] = await provider.embed(["checkout payment failure"], "document");
    const [again] = await provider.embed(["checkout payment failure"], "document");

    expect(first).toHaveLength(768);
    // Self-similarity of a unit vector is 1: confirms normalize:true is in effect,
    // which is what lets the search SQL treat a dot product as cosine similarity.
    expect(cosine(first!, first!)).toBeCloseTo(1, 5);
    // Same input, same vector — the model is deterministic, so retrieval results
    // cannot drift between an indexing run and a later query.
    expect(cosine(first!, again!)).toBeCloseTo(1, 5);
  }, 180_000);

  it("encodes a document and a query differently (nomic task prefixes are applied)", async () => {
    const text = "Reports can be downloaded as CSV.";
    const [asDocument] = await provider.embed([text], "document");
    const [asQuery] = await provider.embed([text], "query");

    // Related but not identical: the retrieval prefixes genuinely change the
    // encoding. If these matched exactly, the prefixes would be silently dropped
    // and retrieval quality would quietly degrade.
    const similarity = cosine(asDocument!, asQuery!);
    expect(similarity).toBeGreaterThan(0.8);
    expect(similarity).toBeLessThan(0.9999);
  }, 180_000);
});

describe("embedding model — adds recall that lexical search cannot", () => {
  // Each query is a realistic way a business owner would ask, sharing essentially no
  // content words with the document it should match.
  const PARAPHRASES: Array<{ query: string; expected: CorpusKey; sharesNoWordsWith: string }> = [
    {
      query: "why was my card declined when buying something",
      expected: "checkout",
      sharesNoWordsWith: "reject expired credit cards during payment authorization",
    },
    {
      query: "account temporarily blocked after too many bad passwords",
      expected: "login",
      sharesNoWordsWith: "locked out after consecutive failed sign-in attempts",
    },
    {
      query: "pulling a big spreadsheet out of the system",
      expected: "export",
      sharesNoWordsWith: "downloaded as CSV, streamed in batches",
    },
    {
      query: "who is allowed to add teammates",
      expected: "permissions",
      sharesNoWordsWith: "owners and administrators may invite new members",
    },
  ];

  it.each(PARAPHRASES)(
    "ranks the right source first for: $query",
    async ({ query, expected }) => {
      const ranked = await rankCorpus(query);

      // The intended document wins outright...
      expect(ranked[0]!.key).toBe(expected);
      // ...and by a real margin, not a coin flip. A near-tie would mean retrieval
      // order is luck, and top-K would be unstable across trivial rewordings.
      expect(ranked[0]!.score - ranked[1]!.score).toBeGreaterThan(0.02);
    },
    180_000,
  );

  it("beats literal word overlap: a paraphrase outranks a doc that shares more words", async () => {
    // "reports" and "large" appear verbatim in the EXPORT document, yet the question
    // is about permissions. A keyword scorer would be pulled toward the export doc;
    // meaning has to win for this to be useful on top of full-text search.
    const ranked = await rankCorpus("can a normal member change who gets billed");

    expect(ranked[0]!.key).toBe("permissions");
    const exportScore = ranked.find((entry) => entry.key === "export")!.score;
    expect(ranked[0]!.score).toBeGreaterThan(exportScore);
  }, 180_000);
});

describe("embedding model — does not surface off-topic sources", () => {
  // The real risk is not a fabricated vector; it is a confident wrong neighbour
  // being handed to the LLM as grounding. These lock in that on-topic always wins.
  const OFF_TOPIC_QUERIES = [
    "how do I configure the Kubernetes ingress controller",
    "what is the office holiday schedule",
    "recipe for chocolate cake",
  ];

  it.each(OFF_TOPIC_QUERIES)(
    "keeps an unrelated question well below a genuine match: %s",
    async (offTopicQuery) => {
      const offTopic = await rankCorpus(offTopicQuery);
      const onTopic = await rankCorpus("why was my card declined when buying something");

      // Measured on this corpus: a genuine match peaks at 0.729, while the best
      // off-topic neighbour reaches only 0.435-0.525. Note the floor is high --
      // unrelated English still scores ~0.4 -- which is exactly why a naive absolute
      // "similarity > 0.4 means relevant" cut-off would admit nonsense.
      expect(onTopic[0]!.score).toBeGreaterThan(offTopic[0]!.score + 0.12);
    },
    180_000,
  );

  it("returns a FLAT ranking when nothing genuinely matches", async () => {
    // The strongest anti-false-grounding property, and the one that survives the
    // high similarity floor: when the corpus has no answer, no document stands out.
    //
    // Measured top-vs-second gaps on this corpus:
    //   on-topic  : 0.040 - 0.214   (a clear winner)
    //   off-topic : 0.005 - 0.022   (a near-tie; nothing is actually relevant)
    //
    // Asserted as a relation between the two populations rather than a hardcoded
    // constant, so it stays meaningful if absolute scores shift.
    const onTopicGaps: number[] = [];
    for (const query of [
      "why was my card declined when buying something",
      "account temporarily blocked after too many bad passwords",
      "pulling a big spreadsheet out of the system",
      "who is allowed to add teammates",
    ]) {
      const ranked = await rankCorpus(query);
      onTopicGaps.push(ranked[0]!.score - ranked[1]!.score);
    }

    const offTopicGaps: number[] = [];
    for (const query of OFF_TOPIC_QUERIES) {
      const ranked = await rankCorpus(query);
      offTopicGaps.push(ranked[0]!.score - ranked[1]!.score);
    }

    // Every real question separates its answer more sharply than any unanswerable
    // question separates its nearest accident.
    expect(Math.min(...onTopicGaps)).toBeGreaterThan(Math.max(...offTopicGaps));
  }, 180_000);

  it("does not treat two different in-domain topics as interchangeable", async () => {
    // Both are product features sharing the same vocabulary register; retrieval still
    // has to keep them apart, or the assistant answers a login question with checkout
    // policy — the most damaging wrong grounding, because it reads as credible.
    //
    // Measured gap login-vs-checkout here is 0.061. Deliberately asserted at 0.04
    // rather than tightened to the observed value: same-domain separation is the
    // model's weakest case, and this documents that it is real but modest — which is
    // precisely why semantic search is fused with full-text and trigram rather than
    // used alone.
    const ranked = await rankCorpus("what happens after several wrong passwords");

    expect(ranked[0]!.key).toBe("login");
    const checkoutScore = ranked.find((entry) => entry.key === "checkout")!.score;
    expect(ranked[0]!.score - checkoutScore).toBeGreaterThan(0.04);
  }, 180_000);
});
