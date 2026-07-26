import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveWorkspaceRequest, workspaceRequestError } from "@/modules/workspace/workspace-request";
import {
  EMPTY_WORKSPACE_EMBEDDINGS_VIEW,
  getWorkspaceSettings,
  upsertWorkspaceSettings,
} from "@/modules/workspace/workspace-settings.service";
import { DEFAULT_RETRY_ATTEMPTS, getMaxOutputTokenCapDefaultFromEnv, MAX_OUTPUT_TOKEN_CAP_OPTIONS, RETRY_ATTEMPT_OPTIONS } from "@/modules/llm/llm-defaults";
import { getRetrievalTopKFromEnv, TOP_K_MAX, TOP_K_MIN } from "@/modules/rag/retrieval-config";
import {
  EMBEDDING_DEFAULT_LOCAL_DTYPE,
  EMBEDDING_DEFAULT_MODELS,
  EMBEDDING_LOCAL_DTYPE_OPTIONS,
  EMBEDDING_LOCAL_DTYPE_SIZES,
  EMBEDDING_PROVIDER_OPTIONS,
  getEmbeddingConfigFromEnv,
} from "@/modules/rag/embedding-provider";
import {
  defaultReviewBaselines,
  defaultWorkflowBaselines,
  PUBLISH_WORKFLOW_TYPES,
  workflowLabels,
  workflowTypeValues,
} from "@/modules/analytics/analytics-config";

export const runtime = "nodejs";

/**
 * Workspace-wide settings (owner/admin only): retrieval breadth (top-K) and the
 * LLM max output token cap. A null value means "inherit the deployment default".
 * Members get 403, so the client card hides for them. All access is keyed by the
 * server-resolved workspace.
 */
const allowedCaps = MAX_OUTPUT_TOKEN_CAP_OPTIONS as readonly number[];
const allowedRetries = RETRY_ATTEMPT_OPTIONS as readonly number[];

// Partial per-workflow map of minutes; null clears all overrides (inherit defaults).
const baselineMapSchema = z
  .record(z.enum(workflowTypeValues), z.number().int().min(0).max(100_000))
  .nullable()
  .optional();

// Every field is nullable: null clears the workspace override so the setting falls
// back to the EMBEDDINGS_* deployment default. An omitted apiKey keeps the stored
// key; an empty string is normalized to null (clear) rather than saving a blank key.
const embeddingsSchema = z
  .object({
    provider: z.enum(EMBEDDING_PROVIDER_OPTIONS).nullable().optional(),
    model: z.string().trim().max(200).nullable().optional(),
    baseUrl: z.string().trim().url().max(500).nullable().optional(),
    localDtype: z.enum(EMBEDDING_LOCAL_DTYPE_OPTIONS as readonly [string, ...string[]]).nullable().optional(),
    apiKey: z.string().trim().max(500).nullable().optional(),
  })
  .optional();

const Schema = z
  .object({
    embeddings: embeddingsSchema,
    retrievalTopK: z.number().int().min(TOP_K_MIN).max(TOP_K_MAX).nullable().optional(),
    maxOutputTokenCap: z
      .number()
      .int()
      .refine((value) => allowedCaps.includes(value), {
        message: `LLM output cap must be one of ${MAX_OUTPUT_TOKEN_CAP_OPTIONS.join(", ")}.`,
      })
      .nullable()
      .optional(),
    llmRetryAttempts: z
      .number()
      .int()
      .refine((value) => allowedRetries.includes(value), {
        message: `LLM retry attempts must be one of ${RETRY_ATTEMPT_OPTIONS.join(", ")}.`,
      })
      .nullable()
      .optional(),
    manualBaselineMinutes: baselineMapSchema,
    reviewBaselineMinutes: baselineMapSchema,
  })
  .refine(
    (value) =>
      value.retrievalTopK !== undefined ||
      value.maxOutputTokenCap !== undefined ||
      value.llmRetryAttempts !== undefined ||
      value.manualBaselineMinutes !== undefined ||
      value.reviewBaselineMinutes !== undefined ||
      value.embeddings !== undefined,
    { message: "Provide a setting to update." },
  );

function defaultsPayload() {
  // The env config is what a cleared (null) workspace override falls back to, so the
  // UI can show the real inherited value rather than a hardcoded guess.
  const envEmbeddings = getEmbeddingConfigFromEnv();
  return {
    embeddingsDefaults: {
      provider: envEmbeddings.provider,
      model: envEmbeddings.model ?? null,
      baseUrl: envEmbeddings.baseUrl ?? null,
      localDtype: envEmbeddings.localDtype ?? EMBEDDING_DEFAULT_LOCAL_DTYPE,
      hasApiKey: Boolean(envEmbeddings.apiKey),
      providerOptions: EMBEDDING_PROVIDER_OPTIONS,
      localDtypeOptions: EMBEDDING_LOCAL_DTYPE_OPTIONS,
      localDtypeSizes: EMBEDDING_LOCAL_DTYPE_SIZES,
      providerModelDefaults: EMBEDDING_DEFAULT_MODELS,
    },
    retrievalTopKDefault: getRetrievalTopKFromEnv(),
    maxOutputTokenCapDefault: getMaxOutputTokenCapDefaultFromEnv(),
    maxOutputTokenCapOptions: MAX_OUTPUT_TOKEN_CAP_OPTIONS,
    topKMin: TOP_K_MIN,
    topKMax: TOP_K_MAX,
    retryAttemptsDefault: DEFAULT_RETRY_ATTEMPTS,
    retryAttemptsOptions: RETRY_ATTEMPT_OPTIONS,
    workflowTypes: workflowTypeValues,
    workflowLabels,
    manualBaselineDefaults: defaultWorkflowBaselines,
    reviewBaselineDefaults: defaultReviewBaselines,
    perItemReviewTypes: PUBLISH_WORKFLOW_TYPES,
  };
}

export async function GET() {
  let context: Awaited<ReturnType<typeof resolveWorkspaceRequest>>;
  try {
    context = await resolveWorkspaceRequest(["owner", "admin"]);
  } catch (error) {
    const response = workspaceRequestError(error);
    if (response) return response;
    throw error;
  }

  const settings = await getWorkspaceSettings(context.workspace.id);
  return NextResponse.json(
    {
      workspaceId: context.workspace.id,
      settings: settings ?? {
        retrievalTopK: null,
        maxOutputTokenCap: null,
        llmRetryAttempts: null,
        manualBaselineMinutes: null,
        reviewBaselineMinutes: null,
        embeddings: EMPTY_WORKSPACE_EMBEDDINGS_VIEW,
      },
      defaults: defaultsPayload(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(request: Request) {
  let context: Awaited<ReturnType<typeof resolveWorkspaceRequest>>;
  try {
    context = await resolveWorkspaceRequest(["owner", "admin"]);
  } catch (error) {
    const response = workspaceRequestError(error);
    if (response) return response;
    throw error;
  }

  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid workspace settings." },
      { status: 400 },
    );
  }

  const embeddings = parsed.data.embeddings;
  const settings = await upsertWorkspaceSettings({
    workspaceId: context.workspace.id,
    retrievalTopK: parsed.data.retrievalTopK,
    maxOutputTokenCap: parsed.data.maxOutputTokenCap,
    llmRetryAttempts: parsed.data.llmRetryAttempts,
    manualBaselineMinutes: parsed.data.manualBaselineMinutes,
    reviewBaselineMinutes: parsed.data.reviewBaselineMinutes,
    ...(embeddings
      ? {
          embeddings: {
            ...embeddings,
            // A blank submitted value means "no override" / "clear the key", not a
            // stored empty string that would later be sent to the provider.
            ...(embeddings.model !== undefined ? { model: embeddings.model || null } : {}),
            ...(embeddings.baseUrl !== undefined ? { baseUrl: embeddings.baseUrl || null } : {}),
            ...(embeddings.apiKey !== undefined ? { apiKey: embeddings.apiKey || null } : {}),
          },
        }
      : {}),
    updatedByUserId: context.userId,
  });

  return NextResponse.json({ workspaceId: context.workspace.id, settings, defaults: defaultsPayload() });
}
