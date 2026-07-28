import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { writeAuditLog } from "@/modules/audit/audit.service";
import type { RagChunk, VectorStore } from "./rag-types";

export function chunkText(input: {
  projectId: string;
  azureProjectId: string;
  sourceId: string;
  sourceType: RagChunk["sourceType"];
  title: string;
  text: string;
  chunkSize?: number;
  chunkOverlap?: number;
}): RagChunk[] {
  const size = input.chunkSize ?? 2000;
  // Consecutive chunks share an overlap window so a sentence straddling a chunk
  // boundary stays intact in at least one chunk. Default: 10% of the chunk size,
  // capped at 200 chars; always at least 1 char smaller than the chunk so the
  // window advances.
  const requestedOverlap = input.chunkOverlap ?? Math.min(200, Math.floor(size * 0.1));
  const overlap = Math.min(Math.max(Math.trunc(requestedOverlap), 0), size - 1);
  const chunks: RagChunk[] = [];
  let index = 0;
  while (index < input.text.length) {
    const hardEnd = index + size;
    // Prefer to end a chunk on a natural boundary. A blind character cut splits words
    // in half, which damages both retrieval signals at once: the fragments become
    // junk tokens for full-text search, and the embedding is computed over text no
    // human would write, pulling the chunk's vector away from its real meaning.
    const end = hardEnd >= input.text.length ? input.text.length : findBreakPoint(input.text, index, hardEnd);
    chunks.push({
      id: `${input.sourceId}-${chunks.length}`,
      projectId: input.projectId,
      azureProjectId: input.azureProjectId,
      sourceId: input.sourceId,
      sourceType: input.sourceType,
      title: input.title,
      content: input.text.slice(index, end).trim(),
      metadata: { chunkIndex: chunks.length },
    });
    // Once a chunk reaches the end of the text, stop: a further step would emit a
    // trailing chunk that is a pure subset of this one.
    if (end >= input.text.length) break;
    // Advance relative to the actual break, so shortening a chunk to a clean boundary
    // never drops the text between the break and where a fixed stride would have gone.
    index = Math.max(index + 1, end - overlap);
  }
  return chunks;
}

// How far back from the hard limit a natural boundary may be found before giving up
// and cutting exactly at the limit. Bounded so one long unbroken run of characters
// (a base64 blob, a minified payload) cannot collapse chunks to a tiny size.
const MAX_BREAK_LOOKBACK_RATIO = 0.2;

/**
 * Finds the best place to end a chunk at or before `hardEnd`: the last paragraph
 * break, else sentence end, else whitespace, within a bounded look-back window.
 * Falls back to `hardEnd` when the window contains no boundary at all.
 */
function findBreakPoint(text: string, start: number, hardEnd: number): number {
  const minEnd = Math.max(start + 1, hardEnd - Math.floor((hardEnd - start) * MAX_BREAK_LOOKBACK_RATIO));
  const window = text.slice(minEnd, hardEnd);

  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph !== -1) return minEnd + paragraph + 2;

  // Sentence end: terminator followed by whitespace.
  const sentence = window.search(/[.!?](?=\s)(?![\s\S]*[.!?](?=\s))/);
  if (sentence !== -1) return minEnd + sentence + 1;

  const newline = window.lastIndexOf("\n");
  if (newline !== -1) return minEnd + newline + 1;

  const space = window.lastIndexOf(" ");
  if (space !== -1) return minEnd + space + 1;

  return hardEnd;
}

export async function indexProjectContext(input: {
  scope: ProjectScope;
  actor: string;
  vectorStore: VectorStore;
  chunks: RagChunk[];
}) {
  const scope = assertProjectScope(input.scope);
  const invalid = input.chunks.find((chunk) => chunk.projectId !== scope.projectId || chunk.azureProjectId !== scope.azureProjectId);
  if (invalid) throw new Error("Cannot index chunks outside the selected Azure DevOps project.");

  await input.vectorStore.upsert(input.chunks);
  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    actor: input.actor,
    action: "rag.index_project_context",
    status: "Success",
    message: `Indexed ${input.chunks.length} project-scoped chunks.`,
  });
}

export async function retrieveProjectContext(input: {
  scope: ProjectScope;
  vectorStore: VectorStore;
  query: string;
  topK?: number;
}) {
  const scope = assertProjectScope(input.scope);
  return input.vectorStore.search({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    query: input.query,
    topK: input.topK ?? 8,
  });
}
