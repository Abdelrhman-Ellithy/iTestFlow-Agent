import type { ContextChatbotHistoryMessage } from "./context-chatbot-history";
import { estimateTokens } from "./evidence-budget";

/**
 * Chooses which parts of an accumulated conversation to put in the prompt.
 *
 * History used to be a pure recency window — the last few turns, everything older
 * discarded regardless of what it contained. In a long session that silently throws
 * away the turns that matter most: the constraint the user gave at the start, or a
 * correction like "wrong, planning officer doesn't belong to ECMS module", which is
 * exactly the turn that must survive so the mistake is not repeated.
 *
 * So the conversation accumulates in full, and this decides what is worth sending:
 * recent turns always, older turns by relevance to the question being asked, within a
 * token budget.
 */

/**
 * Exchanges kept verbatim regardless of relevance. Follow-up resolution depends on the
 * immediately preceding turns ("what about the rejected one?" means nothing without
 * them), so recency is not negotiable — relevance selection only governs what happens
 * *behind* this window.
 */
export const RECENT_EXCHANGES_ALWAYS_KEPT = 3;

/**
 * Upper bound on how far back relevance scoring reaches. Bounds both cost (each
 * candidate is embedded) and the risk of dragging a long-abandoned topic back into a
 * conversation that has moved on.
 */
export const MAX_SCORED_EXCHANGES = 20;

/**
 * A user turn together with the assistant turn(s) that answered it.
 *
 * Selection happens at this granularity on purpose: including an assistant answer
 * without the question it answered leaves the model reading a reply to nothing, and
 * including a question without its answer hides what was already established.
 */
export type ConversationExchange = {
  messages: ContextChatbotHistoryMessage[];
  /** Position in the original conversation; used to restore chronological order. */
  index: number;
  text: string;
};

/** Groups a flat message list into exchanges, preserving order. */
export function groupIntoExchanges(history: ContextChatbotHistoryMessage[]): ConversationExchange[] {
  const exchanges: ConversationExchange[] = [];
  for (const message of history) {
    const current = exchanges[exchanges.length - 1];
    // A user turn opens a new exchange; assistant turns attach to the open one. A
    // conversation that somehow starts with an assistant turn still gets an exchange
    // rather than being dropped.
    if (message.role === "user" || !current) {
      exchanges.push({ messages: [message], index: exchanges.length, text: message.content });
      continue;
    }
    current.messages.push(message);
    current.text = `${current.text}\n${message.content}`;
  }
  return exchanges;
}

export type ExchangeScorer = (input: {
  question: string;
  exchanges: ConversationExchange[];
}) => Promise<number[]>;

/**
 * Returns the messages worth sending, in chronological order.
 *
 * Output order is always chronological, never relevance order: a conversation shown
 * out of sequence reads as a different conversation, and the model has no way to tell
 * that turns were omitted rather than reordered.
 */
export async function selectRelevantHistory(input: {
  history: ContextChatbotHistoryMessage[];
  question: string;
  budgetTokens: number;
  /** Optional; without it the selection is recency-only, which is the old behaviour. */
  scoreExchanges?: ExchangeScorer;
}): Promise<ContextChatbotHistoryMessage[]> {
  const exchanges = groupIntoExchanges(input.history);
  if (!exchanges.length) return [];

  const recentStart = Math.max(0, exchanges.length - RECENT_EXCHANGES_ALWAYS_KEPT);
  const recent = exchanges.slice(recentStart);
  const older = exchanges.slice(0, recentStart);

  const selected = new Map<number, ConversationExchange>();
  let usedTokens = 0;
  for (const exchange of recent) {
    selected.set(exchange.index, exchange);
    usedTokens += estimateTokens(exchange.text);
  }

  if (older.length && input.scoreExchanges) {
    // Only the most recent slice of the backlog is scored; older than that, relevance
    // is rarely worth the cost of computing it.
    const candidates = older.slice(-MAX_SCORED_EXCHANGES);
    let scores: number[] = [];
    try {
      scores = await input.scoreExchanges({ question: input.question, exchanges: candidates });
    } catch (error) {
      // Memory is an enhancement, never a dependency: a scorer failure degrades to the
      // recency window rather than failing the answer.
      console.error("Conversation relevance scoring failed; falling back to recent turns.", error);
    }

    if (scores.length === candidates.length) {
      const ranked = candidates
        .map((exchange, position) => ({ exchange, score: scores[position]! }))
        .sort((first, second) => second.score - first.score);
      for (const { exchange } of ranked) {
        const cost = estimateTokens(exchange.text);
        if (usedTokens + cost > input.budgetTokens) continue;
        selected.set(exchange.index, exchange);
        usedTokens += cost;
      }
    }
  }

  return Array.from(selected.values())
    .sort((first, second) => first.index - second.index)
    .flatMap((exchange) => exchange.messages);
}
