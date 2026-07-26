import "server-only";

import { getWorkspaceEmbeddingsConfig } from "@/modules/workspace/workspace-settings.service";
import {
  createEmbeddingProvider,
  getEmbeddingConfigFromEnv,
  normalizeEmbeddingConfig,
  type EmbeddingConfig,
  type EmbeddingProvider,
} from "./embedding-provider";

/**
 * Resolves the semantic-search backend for one workspace: a stored Settings
 * override wins field-by-field over the EMBEDDINGS_* deployment defaults, so a
 * workspace can change only its model (or only its provider) without having to
 * restate the rest. A workspace with no override at all -- or a call with no
 * workspace (background/system paths) -- gets the environment configuration
 * unchanged, which itself defaults to the zero-setup local backend.
 *
 * Kept out of embedding-provider.ts on purpose: that module stays pure and
 * env-only so its normalization/HTTP behavior remains unit-testable without a
 * database.
 */
export async function resolveWorkspaceEmbeddingConfig(workspaceId?: string | null): Promise<EmbeddingConfig> {
  const envConfig = getEmbeddingConfigFromEnv();
  if (!workspaceId) return envConfig;

  let stored: Awaited<ReturnType<typeof getWorkspaceEmbeddingsConfig>> = null;
  try {
    stored = await getWorkspaceEmbeddingsConfig(workspaceId);
  } catch (error) {
    // Settings are an override, not a dependency: a failed read must fall back to
    // the deployment default rather than silently disabling semantic search.
    console.error("Workspace embedding settings could not be read; using the deployment default.", error);
    return envConfig;
  }
  if (!stored) return envConfig;

  const env = process.env;
  return normalizeEmbeddingConfig({
    provider: stored.provider ?? env.EMBEDDINGS_PROVIDER,
    model: stored.model ?? env.EMBEDDINGS_MODEL,
    baseUrl: stored.baseUrl ?? env.EMBEDDINGS_BASE_URL,
    apiKey: stored.apiKey ?? env.EMBEDDINGS_API_KEY,
    localDtype: stored.localDtype ?? env.EMBEDDINGS_LOCAL_DTYPE,
  });
}

/**
 * Workspace-aware counterpart to createEmbeddingProvider. Returns null when
 * semantic search is off or a required credential is missing -- callers must
 * treat null as "semantic retrieval unavailable" and continue with full-text and
 * trigram search.
 */
export async function createWorkspaceEmbeddingProvider(
  workspaceId?: string | null,
): Promise<EmbeddingProvider | null> {
  return createEmbeddingProvider(await resolveWorkspaceEmbeddingConfig(workspaceId));
}
