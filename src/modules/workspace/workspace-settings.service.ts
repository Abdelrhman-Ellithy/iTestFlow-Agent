import "server-only";

import {
  defaultReviewBaselines,
  defaultWorkflowBaselines,
  isPerItemReview,
  workflowTypeValues,
  type WorkflowType,
} from "@/modules/analytics/analytics-config";
import { decryptSecret, encryptSecret } from "@/modules/security/encryption.service";
import { nowIso, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";

/**
 * Per-workspace overrides for retrieval breadth (top-K), the LLM max output token
 * cap, retry attempts, the value-metrics baselines (manual effort + review
 * effort per workflow), and the semantic-search (embeddings) backend. A null field
 * means "inherit the deployment default" — consumers (retrieval-config,
 * scoped-resolution, analytics, embedding-provider) apply their own fallback. One
 * row per workspace, keyed directly by workspace_id. All persistence is keyed by
 * the server-resolved workspace id, never client input.
 */
export type WorkflowBaselineMap = Partial<Record<WorkflowType, number>>;

/**
 * Non-secret view of the workspace embeddings override. The API key is never
 * returned — only whether one is stored, so the UI can show a "saved" state.
 */
export type WorkspaceEmbeddingsView = {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  localDtype: string | null;
  hasApiKey: boolean;
};

export type WorkspaceSettingsView = {
  retrievalTopK: number | null;
  maxOutputTokenCap: number | null;
  llmRetryAttempts: number | null;
  manualBaselineMinutes: WorkflowBaselineMap | null;
  reviewBaselineMinutes: WorkflowBaselineMap | null;
  embeddings: WorkspaceEmbeddingsView;
};

type WorkspaceSettingsRow = {
  retrieval_top_k: number | null;
  max_output_token_cap: number | null;
  llm_retry_attempts: number | null;
  manual_baseline_minutes: unknown;
  review_baseline_minutes: unknown;
  embeddings_provider: string | null;
  embeddings_model: string | null;
  embeddings_base_url: string | null;
  embeddings_local_dtype: string | null;
  embeddings_api_key_ciphertext: string | null;
  embeddings_api_key_iv: string | null;
  embeddings_api_key_tag: string | null;
  embeddings_api_key_version: number | null;
};

const SETTINGS_COLUMNS = `retrieval_top_k, max_output_token_cap, llm_retry_attempts,
            manual_baseline_minutes, review_baseline_minutes,
            embeddings_provider, embeddings_model, embeddings_base_url, embeddings_local_dtype,
            embeddings_api_key_ciphertext, embeddings_api_key_iv,
            embeddings_api_key_tag, embeddings_api_key_version`;

function readSettingsRow(workspaceId: string) {
  return sqlGet<WorkspaceSettingsRow>(
    `SELECT ${SETTINGS_COLUMNS}
       FROM workspace_settings
      WHERE workspace_id = @workspaceId
      LIMIT 1`,
    { workspaceId },
  );
}

/** True only when every part of the AES-GCM envelope is present. */
function hasStoredApiKey(row: WorkspaceSettingsRow) {
  return Boolean(row.embeddings_api_key_ciphertext && row.embeddings_api_key_iv && row.embeddings_api_key_tag);
}

// jsonb is auto-parsed to an object by the pg driver, but tolerate a raw JSON
// string defensively. Keep only known workflow keys with finite, non-negative
// minutes so a malformed/stale override can never poison a calculation.
function parseBaselineMap(value: unknown): WorkflowBaselineMap | null {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object" || raw === null) return null;
  const source = raw as Record<string, unknown>;
  const result: WorkflowBaselineMap = {};
  for (const type of workflowTypeValues) {
    const minutes = source[type];
    if (typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 0) {
      result[type] = minutes;
    }
  }
  return Object.keys(result).length ? result : null;
}

function toView(row: WorkspaceSettingsRow): WorkspaceSettingsView {
  return {
    retrievalTopK: row.retrieval_top_k,
    maxOutputTokenCap: row.max_output_token_cap,
    llmRetryAttempts: row.llm_retry_attempts,
    manualBaselineMinutes: parseBaselineMap(row.manual_baseline_minutes),
    reviewBaselineMinutes: parseBaselineMap(row.review_baseline_minutes),
    embeddings: {
      provider: row.embeddings_provider,
      model: row.embeddings_model,
      baseUrl: row.embeddings_base_url,
      localDtype: row.embeddings_local_dtype,
      hasApiKey: hasStoredApiKey(row),
    },
  };
}

export const EMPTY_WORKSPACE_EMBEDDINGS_VIEW: WorkspaceEmbeddingsView = {
  provider: null,
  model: null,
  baseUrl: null,
  localDtype: null,
  hasApiKey: false,
};

export async function getWorkspaceSettings(workspaceId: string): Promise<WorkspaceSettingsView | null> {
  const row = await readSettingsRow(workspaceId);
  return row ? toView(row) : null;
}

/**
 * Server-only resolution of the stored embeddings override, including the
 * decrypted API key. Returns null when this workspace has no override at all, so
 * the caller falls back to the EMBEDDINGS_* deployment defaults. A key that fails
 * to decrypt (rotated/missing APP_ENCRYPTION_KEY) is reported as absent rather
 * than throwing — semantic search must degrade, never break indexing or search.
 */
export async function getWorkspaceEmbeddingsConfig(workspaceId: string): Promise<{
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  localDtype: string | null;
  apiKey: string | null;
} | null> {
  const row = await readSettingsRow(workspaceId);
  if (!row) return null;
  let apiKey: string | null = null;
  if (hasStoredApiKey(row)) {
    try {
      apiKey = decryptSecret({
        ciphertext: row.embeddings_api_key_ciphertext!,
        iv: row.embeddings_api_key_iv!,
        tag: row.embeddings_api_key_tag!,
        keyVersion: row.embeddings_api_key_version ?? 1,
      });
    } catch (error) {
      console.error("Stored embeddings API key could not be decrypted; treating it as unset.", error);
    }
  }
  return {
    provider: row.embeddings_provider,
    model: row.embeddings_model,
    baseUrl: row.embeddings_base_url,
    localDtype: row.embeddings_local_dtype,
    apiKey,
  };
}

export type WorkspaceEmbeddingsUpdate = {
  provider?: string | null;
  model?: string | null;
  baseUrl?: string | null;
  localDtype?: string | null;
  /** undefined keeps the stored key, null clears it, a string replaces it. */
  apiKey?: string | null;
};

export async function upsertWorkspaceSettings(input: {
  workspaceId: string;
  retrievalTopK?: number | null;
  maxOutputTokenCap?: number | null;
  llmRetryAttempts?: number | null;
  manualBaselineMinutes?: WorkflowBaselineMap | null;
  reviewBaselineMinutes?: WorkflowBaselineMap | null;
  embeddings?: WorkspaceEmbeddingsUpdate;
  updatedByUserId: string | null;
}): Promise<WorkspaceSettingsView> {
  const now = nowIso();
  // Partial update: an omitted field (undefined) keeps the current value; an
  // explicit null clears the override (inherit the default). Read-modify-write so
  // settings split across UI tabs don't clobber each other.
  const row = await readSettingsRow(input.workspaceId);
  const existing = row ? toView(row) : null;
  const retrievalTopK = input.retrievalTopK !== undefined ? input.retrievalTopK : existing?.retrievalTopK ?? null;
  const maxOutputTokenCap =
    input.maxOutputTokenCap !== undefined ? input.maxOutputTokenCap : existing?.maxOutputTokenCap ?? null;
  const llmRetryAttempts =
    input.llmRetryAttempts !== undefined ? input.llmRetryAttempts : existing?.llmRetryAttempts ?? null;
  const manualBaselineMinutes =
    input.manualBaselineMinutes !== undefined ? input.manualBaselineMinutes : existing?.manualBaselineMinutes ?? null;
  const reviewBaselineMinutes =
    input.reviewBaselineMinutes !== undefined ? input.reviewBaselineMinutes : existing?.reviewBaselineMinutes ?? null;

  const embeddingsInput = input.embeddings;
  const pickEmbedding = (key: keyof WorkspaceEmbeddingsView & keyof WorkspaceEmbeddingsUpdate) =>
    embeddingsInput?.[key] !== undefined ? embeddingsInput[key] ?? null : (existing?.embeddings[key] as string | null) ?? null;
  const embeddingsProvider = pickEmbedding("provider");
  const embeddingsModel = pickEmbedding("model");
  const embeddingsBaseUrl = pickEmbedding("baseUrl");
  const embeddingsLocalDtype = pickEmbedding("localDtype");
  // The key is encrypted here (never stored or logged in plaintext). An omitted
  // key carries the existing envelope forward untouched.
  const nextApiKey =
    embeddingsInput?.apiKey === undefined
      ? row && hasStoredApiKey(row)
        ? {
            ciphertext: row.embeddings_api_key_ciphertext,
            iv: row.embeddings_api_key_iv,
            tag: row.embeddings_api_key_tag,
            keyVersion: row.embeddings_api_key_version,
          }
        : { ciphertext: null, iv: null, tag: null, keyVersion: null }
      : embeddingsInput.apiKey
        ? encryptSecret(embeddingsInput.apiKey)
        : { ciphertext: null, iv: null, tag: null, keyVersion: null };

  // Nullable params are ::int / ::text / ::jsonb cast so Postgres can infer the
  // column type when the value is NULL (a bare named param has no inferable type).
  await sqlRun(
    `INSERT INTO workspace_settings
       (workspace_id, retrieval_top_k, max_output_token_cap, llm_retry_attempts,
        manual_baseline_minutes, review_baseline_minutes,
        embeddings_provider, embeddings_model, embeddings_base_url, embeddings_local_dtype,
        embeddings_api_key_ciphertext, embeddings_api_key_iv,
        embeddings_api_key_tag, embeddings_api_key_version,
        updated_by_user_id, created_at, updated_at)
     VALUES
       (@workspaceId, @retrievalTopK::int, @maxOutputTokenCap::int, @llmRetryAttempts::int,
        @manualBaselineMinutes::jsonb, @reviewBaselineMinutes::jsonb,
        @embeddingsProvider::text, @embeddingsModel::text, @embeddingsBaseUrl::text, @embeddingsLocalDtype::text,
        @embeddingsApiKeyCiphertext::text, @embeddingsApiKeyIv::text,
        @embeddingsApiKeyTag::text, @embeddingsApiKeyVersion::int,
        @updatedByUserId::text, @now, @now)
     ON CONFLICT (workspace_id) DO UPDATE SET
       retrieval_top_k         = excluded.retrieval_top_k,
       max_output_token_cap    = excluded.max_output_token_cap,
       llm_retry_attempts      = excluded.llm_retry_attempts,
       manual_baseline_minutes = excluded.manual_baseline_minutes,
       review_baseline_minutes = excluded.review_baseline_minutes,
       embeddings_provider     = excluded.embeddings_provider,
       embeddings_model        = excluded.embeddings_model,
       embeddings_base_url     = excluded.embeddings_base_url,
       embeddings_local_dtype  = excluded.embeddings_local_dtype,
       embeddings_api_key_ciphertext = excluded.embeddings_api_key_ciphertext,
       embeddings_api_key_iv         = excluded.embeddings_api_key_iv,
       embeddings_api_key_tag        = excluded.embeddings_api_key_tag,
       embeddings_api_key_version    = excluded.embeddings_api_key_version,
       updated_by_user_id      = excluded.updated_by_user_id,
       updated_at              = excluded.updated_at`,
    {
      workspaceId: input.workspaceId,
      retrievalTopK,
      maxOutputTokenCap,
      llmRetryAttempts,
      manualBaselineMinutes: manualBaselineMinutes ? JSON.stringify(manualBaselineMinutes) : null,
      reviewBaselineMinutes: reviewBaselineMinutes ? JSON.stringify(reviewBaselineMinutes) : null,
      embeddingsProvider,
      embeddingsModel,
      embeddingsBaseUrl,
      embeddingsLocalDtype,
      embeddingsApiKeyCiphertext: nextApiKey.ciphertext,
      embeddingsApiKeyIv: nextApiKey.iv,
      embeddingsApiKeyTag: nextApiKey.tag,
      embeddingsApiKeyVersion: nextApiKey.keyVersion,
      updatedByUserId: input.updatedByUserId,
      now,
    },
  );
  const view = await getWorkspaceSettings(input.workspaceId);
  // Just upserted — always present; fall back to the resolved shape defensively.
  return (
    view ?? {
      retrievalTopK,
      maxOutputTokenCap,
      llmRetryAttempts,
      manualBaselineMinutes,
      reviewBaselineMinutes,
      embeddings: {
        provider: embeddingsProvider,
        model: embeddingsModel,
        baseUrl: embeddingsBaseUrl,
        localDtype: embeddingsLocalDtype,
        hasApiKey: Boolean(nextApiKey.ciphertext),
      },
    }
  );
}

/**
 * Resolve the manual-effort baseline (M, minutes) for a workflow: the workspace
 * override when present, else the deployment default. Used by analytics at run start.
 */
export async function resolveWorkflowBaseline(
  workspaceId: string | null | undefined,
  type: WorkflowType,
): Promise<number> {
  if (workspaceId) {
    const settings = await getWorkspaceSettings(workspaceId);
    const override = settings?.manualBaselineMinutes?.[type];
    if (typeof override === "number" && Number.isFinite(override) && override >= 0) return override;
  }
  return defaultWorkflowBaselines[type];
}

/**
 * Resolve the human review-effort estimate (R, minutes) for a completed run.
 * The configured/default value is interpreted as minutes-per-item for generative
 * workflows (multiplied by itemCount) and minutes-per-run otherwise.
 */
export async function resolveReviewBaseline(
  workspaceId: string | null | undefined,
  type: WorkflowType,
  itemCount: number,
): Promise<number> {
  let perUnit = defaultReviewBaselines[type];
  if (workspaceId) {
    const settings = await getWorkspaceSettings(workspaceId);
    const override = settings?.reviewBaselineMinutes?.[type];
    if (typeof override === "number" && Number.isFinite(override) && override >= 0) perUnit = override;
  }
  return isPerItemReview(type) ? perUnit * Math.max(itemCount, 0) : perUnit;
}
