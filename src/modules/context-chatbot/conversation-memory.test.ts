import { describe, expect, it, vi } from "vitest";

import {
  groupIntoExchanges,
  MAX_EMBEDDED_EXCHANGES,
  RECENT_EXCHANGES_ALWAYS_KEPT,
  selectRelevantHistory,
} from "./conversation-memory";

const user = (content: string) => ({ role: "user" as const, content });
const assistant = (content: string) => ({ role: "assistant" as const, content });

/** Scores by keyword presence so relevance is deterministic and readable. */
const scoreByKeyword = (keyword: string) =>
  vi.fn(async ({ exchanges }: { exchanges: Array<{ text: string }> }) =>
    exchanges.map((exchange) => (exchange.text.includes(keyword) ? 1 : 0)),
  );

describe("groupIntoExchanges", () => {
  it("pairs each question with the answer that followed it", () => {
    const exchanges = groupIntoExchanges([
      user("q1"), assistant("a1"),
      user("q2"), assistant("a2"), assistant("a2 continued"),
    ]);
    expect(exchanges).toHaveLength(2);
    expect(exchanges[1]!.messages.map((m) => m.content)).toEqual(["q2", "a2", "a2 continued"]);
  });

  it("does not drop a leading assistant turn", () => {
    expect(groupIntoExchanges([assistant("orphan"), user("q")])).toHaveLength(2);
  });
});

describe("selectRelevantHistory", () => {
  it("always keeps the most recent exchanges, whatever their relevance", async () => {
    // Follow-up resolution depends on the immediately preceding turns, so recency is
    // not negotiable — relevance only governs what happens behind that window.
    const history = Array.from({ length: 10 }, (_, i) => [user(`q${i}`), assistant(`a${i}`)]).flat();
    const result = await selectRelevantHistory({
      history,
      question: "unrelated",
      budgetTokens: 0,
      scoreExchanges: scoreByKeyword("nothing-matches"),
    });
    const contents = result.map((m) => m.content);
    for (let i = 10 - RECENT_EXCHANGES_ALWAYS_KEPT; i < 10; i += 1) {
      expect(contents).toContain(`q${i}`);
    }
  });

  it("recovers an older relevant exchange that a recency window would have dropped", async () => {
    // The point of the feature: a constraint stated early, or a correction, must
    // survive once the conversation is longer than the recency window.
    const history = [
      user("wrong, that role does not belong to the billing module"),
      assistant("understood, corrected"),
      ...Array.from({ length: 8 }, (_, i) => [user(`filler ${i}`), assistant(`reply ${i}`)]).flat(),
    ];
    const result = await selectRelevantHistory({
      history,
      question: "which roles belong to billing?",
      budgetTokens: 1_000,
      scoreExchanges: scoreByKeyword("billing"),
    });
    expect(result.map((m) => m.content)).toContain("wrong, that role does not belong to the billing module");
  });

  it("keeps an answer with the question it answered", async () => {
    const history = [
      user("who approves a refund?"), assistant("a section manager approves it"),
      ...Array.from({ length: 6 }, (_, i) => [user(`filler ${i}`), assistant(`reply ${i}`)]).flat(),
    ];
    const result = await selectRelevantHistory({
      history,
      question: "refund approval",
      budgetTokens: 1_000,
      scoreExchanges: scoreByKeyword("refund"),
    });
    const contents = result.map((m) => m.content);
    // An assistant reply without its question reads as an answer to nothing.
    expect(contents).toContain("who approves a refund?");
    expect(contents).toContain("a section manager approves it");
  });

  it("returns messages in chronological order, never relevance order", async () => {
    const history = [
      user("first billing question"), assistant("first answer"),
      ...Array.from({ length: 6 }, (_, i) => [user(`filler ${i}`), assistant(`reply ${i}`)]).flat(),
    ];
    const result = await selectRelevantHistory({
      history,
      question: "billing",
      budgetTokens: 1_000,
      scoreExchanges: scoreByKeyword("billing"),
    });
    const contents = result.map((m) => m.content);
    // A conversation shown out of sequence reads as a different conversation.
    expect(contents.indexOf("first billing question")).toBeLessThan(contents.indexOf("filler 5"));
  });

  it("stops adding older exchanges once the budget is spent", async () => {
    const history = [
      ...Array.from({ length: 12 }, (_, i) => [user(`billing topic ${i} ${"x".repeat(400)}`), assistant("a")]).flat(),
    ];
    const generous = await selectRelevantHistory({
      history, question: "billing", budgetTokens: 5_000, scoreExchanges: scoreByKeyword("billing"),
    });
    const tight = await selectRelevantHistory({
      history, question: "billing", budgetTokens: 200, scoreExchanges: scoreByKeyword("billing"),
    });
    expect(tight.length).toBeLessThan(generous.length);
  });

  it("falls back to recency when no scorer is supplied", async () => {
    const history = Array.from({ length: 8 }, (_, i) => [user(`q${i}`), assistant(`a${i}`)]).flat();
    const result = await selectRelevantHistory({ history, question: "q0", budgetTokens: 10_000 });
    expect(result).toHaveLength(RECENT_EXCHANGES_ALWAYS_KEPT * 2);
    expect(result.map((m) => m.content)).not.toContain("q0");
  });

  it("degrades to recency when the scorer throws rather than failing the answer", async () => {
    const history = Array.from({ length: 8 }, (_, i) => [user(`q${i}`), assistant(`a${i}`)]).flat();
    const result = await selectRelevantHistory({
      history,
      question: "anything",
      budgetTokens: 10_000,
      scoreExchanges: async () => { throw new Error("model unavailable"); },
    });
    expect(result).toHaveLength(RECENT_EXCHANGES_ALWAYS_KEPT * 2);
  });

  it("embeds only a bounded number of candidates, not the whole backlog", async () => {
    // Embedding is ~12 ms per exchange; scoring the full 20-candidate backlog cost
    // ~250 ms per message, 87% of a turn's embedding work. A free word-overlap pass
    // picks the plausible few first so the expensive step stays bounded.
    const history = [
      ...Array.from({ length: 18 }, (_, i) => [user(`unrelated topic ${i}`), assistant("a")]).flat(),
      user("billing roles question"), assistant("about billing roles"),
      ...Array.from({ length: 3 }, (_, i) => [user(`recent ${i}`), assistant("a")]).flat(),
    ];
    const scorer = vi.fn(async ({ exchanges }: { exchanges: Array<{ text: string }> }) =>
      exchanges.map((exchange) => (exchange.text.includes("billing") ? 1 : 0)),
    );

    const result = await selectRelevantHistory({
      history, question: "which roles belong to billing?", budgetTokens: 5_000, scoreExchanges: scorer,
    });

    expect(scorer).toHaveBeenCalledTimes(1);
    expect(scorer.mock.calls[0]![0].exchanges.length).toBeLessThanOrEqual(MAX_EMBEDDED_EXCHANGES);
    // The prefilter must still surface the one that matters, not just cut blindly.
    expect(result.map((m) => m.content)).toContain("billing roles question");
  });

  it("handles an empty conversation", async () => {
    expect(await selectRelevantHistory({ history: [], question: "q", budgetTokens: 100 })).toEqual([]);
  });
});
