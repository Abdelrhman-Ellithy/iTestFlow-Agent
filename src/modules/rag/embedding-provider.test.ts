import { beforeEach, describe, expect, it, vi } from "vitest";

const local = vi.hoisted(() => ({ embedWithLocalModel: vi.fn() }));
vi.mock("./local-embedding", () => local);

import {
  createEmbeddingProvider,
  EMBEDDING_DTYPE,
  EMBEDDING_MODEL,
  EMBEDDING_VECTOR_REFERENCE,
  MAX_EMBED_BATCH_SIZE,
} from "./embedding-provider";

/**
 * Unit coverage for the provider's own logic — prefixing, batching, truncation and
 * validation — with the ONNX model mocked out. The real model's retrieval quality is
 * proven separately in embedding-model.quality.db.test.ts, which is the only place
 * the ~131 MB weights are actually loaded.
 */

/** Returns one vector per input so the count assertion passes by default. */
function respondWithOneVectorPerInput() {
  local.embedWithLocalModel.mockImplementation(async ({ texts }: { texts: string[] }) =>
    texts.map((_, index) => [index]),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  respondWithOneVectorPerInput();
});

describe("createEmbeddingProvider", () => {
  it("pins one model identity that doubles as the stored vector reference", () => {
    const provider = createEmbeddingProvider();

    expect(provider.name).toBe("local");
    expect(provider.model).toBe(EMBEDDING_MODEL);
    // The provider's reference identifies the MODEL (weights + precision). Each
    // pipeline appends its own text-recipe version on top (see embedding-store), so a
    // recipe change in one pipeline cannot invalidate the other's stored vectors.
    expect(provider.vectorReference).toBe(`local:${EMBEDDING_MODEL}:${EMBEDDING_DTYPE}`);
    expect(provider.vectorReference).toBe(EMBEDDING_VECTOR_REFERENCE);
  });

  it("applies nomic retrieval task prefixes, defaulting to document", async () => {
    const provider = createEmbeddingProvider();

    await provider.embed(["alpha"]);
    expect(local.embedWithLocalModel.mock.calls[0]![0].texts).toEqual(["search_document: alpha"]);

    await provider.embed(["alpha"], "query");
    expect(local.embedWithLocalModel.mock.calls[1]![0].texts).toEqual(["search_query: alpha"]);
  });

  it("passes the pinned model and dtype through to the runtime", async () => {
    await createEmbeddingProvider().embed(["alpha"]);

    expect(local.embedWithLocalModel).toHaveBeenCalledWith(
      expect.objectContaining({ model: EMBEDDING_MODEL, dtype: EMBEDDING_DTYPE }),
    );
  });

  it("splits large inputs into bounded batches and preserves overall order", async () => {
    const inputCount = MAX_EMBED_BATCH_SIZE * 2 + 5;
    local.embedWithLocalModel.mockImplementation(async ({ texts }: { texts: string[] }) =>
      texts.map((text) => [Number(text.replace("search_document: item", ""))]),
    );

    const vectors = await createEmbeddingProvider().embed(
      Array.from({ length: inputCount }, (_, index) => `item${index}`),
    );

    expect(vectors).toHaveLength(inputCount);
    expect(local.embedWithLocalModel).toHaveBeenCalledTimes(3);
    expect(local.embedWithLocalModel.mock.calls[0]![0].texts).toHaveLength(MAX_EMBED_BATCH_SIZE);
    expect(local.embedWithLocalModel.mock.calls[2]![0].texts).toHaveLength(5);
    // Batching must not reorder: vector N still belongs to input N.
    expect(vectors[0]).toEqual([0]);
    expect(vectors[inputCount - 1]).toEqual([inputCount - 1]);
  });

  it("truncates oversized input after prefixing, so the prefix always survives", async () => {
    await createEmbeddingProvider().embed(["y".repeat(20_000)], "query");

    const [sent] = local.embedWithLocalModel.mock.calls[0]![0].texts;
    expect(sent).toHaveLength(8000);
    expect(sent.startsWith("search_query: ")).toBe(true);
  });

  it("returns an empty result without invoking the model", async () => {
    await expect(createEmbeddingProvider().embed([])).resolves.toEqual([]);
    expect(local.embedWithLocalModel).not.toHaveBeenCalled();
  });

  it("throws when the runtime returns the wrong number of vectors", async () => {
    // Guards against a silent off-by-one that would misalign every vector with its
    // chunk — the worst possible corruption, since retrieval would look healthy while
    // returning content attributed to the wrong work item.
    local.embedWithLocalModel.mockResolvedValue([[1]]);

    await expect(createEmbeddingProvider().embed(["alpha", "beta"])).rejects.toThrow(
      "returned 1 vectors for 2 inputs",
    );
  });

  it("propagates a model failure so callers can degrade to lexical search", async () => {
    local.embedWithLocalModel.mockRejectedValue(new Error("model download failed"));

    await expect(createEmbeddingProvider().embed(["alpha"])).rejects.toThrow("model download failed");
  });
});
