import { describe, expect, it } from "vitest";

import {
  buildRetrievalQueryWithHistory,
  CONTEXT_CHATBOT_RETRIEVAL_CONTEXT_CHARS,
} from "./context-chatbot-history";

/**
 * Conversational follow-ups have no standalone meaning. Retrieval used to receive them
 * verbatim while only the prompt saw the history, so evidence was selected from a
 * context-free fragment. These lock in the resolution rules.
 */
describe("buildRetrievalQueryWithHistory", () => {
  const user = (content: string) => ({ role: "user" as const, content });
  const assistant = (content: string) => ({ role: "assistant" as const, content });

  it("returns the question unchanged when there is no history", () => {
    expect(buildRetrievalQueryWithHistory("what about the other role ?")).toBe("what about the other role ?");
    expect(buildRetrievalQueryWithHistory("first question", [])).toBe("first question");
  });

  it("folds recent user turns in front of a follow-up", () => {
    const result = buildRetrievalQueryWithHistory("what about the other role ?", [
      user("what are all the roles and personas in the billing module ?"),
    ]);
    expect(result).toContain("roles and persona");
    expect(result).toContain("billing module");
    // The current question is still present and last, so it dominates the encoding.
    expect(result.endsWith("what about the other role ?")).toBe(true);
  });

  it("ignores assistant turns", () => {
    // Assistant replies are long and are the model's wording, not the user's; including
    // them steers retrieval toward what was already said instead of what is being asked.
    const result = buildRetrievalQueryWithHistory("and the rejected ones ?", [
      user("how do PO requests move between states"),
      assistant("PO requests move from Draft to Submitted to Approved, and a rejected request returns to Draft for correction."),
    ]);
    expect(result).toContain("how do PO requests move between states");
    expect(result).not.toContain("returns to Draft for correction");
  });

  it("uses only the most recent user turns, not the whole conversation", () => {
    const result = buildRetrievalQueryWithHistory("what about that ?", [
      user("a question about something long forgotten"),
      user("second topic"),
      user("third topic"),
    ]);
    expect(result).not.toContain("long forgotten");
    expect(result).toContain("third topic");
  });

  it("bounds the prepended context so one long earlier question cannot swamp the query", () => {
    const result = buildRetrievalQueryWithHistory("follow up", [user("x".repeat(5000))]);
    const prepended = result.slice(0, result.indexOf("\n\n"));
    expect(prepended.length).toBeLessThanOrEqual(CONTEXT_CHATBOT_RETRIEVAL_CONTEXT_CHARS);
    expect(result.endsWith("follow up")).toBe(true);
  });

  it("skips blank history entries rather than emitting stray separators", () => {
    const result = buildRetrievalQueryWithHistory("q", [user("   "), user("real topic")]);
    expect(result).toBe("real topic\n\nq");
  });
});
