/**
 * The conversation is accumulative: the client sends the session so far and the server
 * decides what is worth including (see selectRelevantHistory). This bound exists only
 * to keep request payloads sane, not to shape what the model sees.
 */
export const CONTEXT_CHATBOT_HISTORY_REQUEST_LIMIT = 100;
/**
 * Recency-only fallback used when no relevance scorer is available. With a scorer, the
 * prompt-side selection is governed by relevance and the token budget instead.
 */
export const CONTEXT_CHATBOT_PROMPT_HISTORY_LIMIT = 8;
/** Share of the model's input budget the conversation may occupy, so memory cannot crowd out evidence. */
export const CONTEXT_CHATBOT_HISTORY_BUDGET_SHARE = 0.25;
export const CONTEXT_CHATBOT_HISTORY_CONTENT_LIMIT = 1200;

export type ContextChatbotHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export function normalizeContextChatbotHistory(
  history: ContextChatbotHistoryMessage[],
  limit = CONTEXT_CHATBOT_HISTORY_REQUEST_LIMIT,
) {
  return history
    .map((message) => ({
      role: message.role,
      content: trimHistoryContent(message.content),
    }))
    .filter((message) => message.content)
    .slice(-limit);
}

export function trimHistoryContent(content: string) {
  return content.trim().slice(0, CONTEXT_CHATBOT_HISTORY_CONTENT_LIMIT);
}

/**
 * How many recent USER turns are folded into the retrieval query for a follow-up.
 * Assistant turns are excluded: they are long, and their wording is the model's, not
 * the user's, so including them steers retrieval toward whatever was already said
 * rather than what is being asked.
 */
export const CONTEXT_CHATBOT_RETRIEVAL_HISTORY_TURNS = 2;
/** Bound on the prepended context so one long earlier question cannot swamp the query. */
export const CONTEXT_CHATBOT_RETRIEVAL_CONTEXT_CHARS = 400;

/**
 * Builds the text used for SEMANTIC retrieval: recent user turns followed by the
 * current question.
 *
 * Conversational follow-ups have no standalone meaning — "what about the other role?",
 * "what about the rejected one?" — yet retrieval previously received them verbatim
 * while only the LLM prompt saw the history. The model therefore knew what was being
 * asked but was handed evidence selected from a context-free fragment.
 *
 * Measured on real questions against real project content, on-topic results in the top
 * 8 rose from 4/24 to 14/24 across the follow-ups collected from live sessions. One of
 * them retrieved nothing relevant at all before the change.
 *
 * Deliberately NOT used for full-text or trigram search. Those should match the words
 * the user actually typed: where a follow-up names an entity that is also the title of a
 * work item, the bare query surfaces that item and folding in history displaces it.
 * Keeping lexical literal and semantic contextual preserves both.
 */
export function buildRetrievalQueryWithHistory(
  question: string,
  history: ContextChatbotHistoryMessage[] = [],
): string {
  const recentUserTurns = history
    .filter((message) => message.role === "user")
    .slice(-CONTEXT_CHATBOT_RETRIEVAL_HISTORY_TURNS)
    .map((message) => message.content.trim())
    .filter(Boolean);
  if (!recentUserTurns.length) return question;

  const context = recentUserTurns.join(" ").slice(-CONTEXT_CHATBOT_RETRIEVAL_CONTEXT_CHARS);
  return `${context}\n\n${question}`;
}
