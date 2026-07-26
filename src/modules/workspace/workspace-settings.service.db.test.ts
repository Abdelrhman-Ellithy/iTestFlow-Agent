import { afterAll, beforeAll, expect, it } from "vitest";

import { describeDb } from "@/test/db";
import { resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { ensureBootstrapOwner } from "@/modules/auth/bootstrap.service";
import {
  EMPTY_WORKSPACE_EMBEDDINGS_VIEW,
  getWorkspaceEmbeddingsConfig,
  getWorkspaceSettings,
  upsertWorkspaceSettings,
} from "@/modules/workspace/workspace-settings.service";
import {
  DEFAULT_TOP_K,
  getRetrievalTopK,
} from "@/modules/rag/retrieval-config";

const TEST_EMAIL = "owner-wssettings@itestflow.test";
const TEST_ORG = "itestflow-wssettings-test-org";
const TEST_ORG_URL = "https://dev.azure.com/itestflow-wssettings-test-org";

// DB-backed integration coverage; requires migrated PostgreSQL via DATABASE_URL.

async function cleanup(workspaceId?: string) {
  if (workspaceId) await sqlRun(`DELETE FROM workspace_settings WHERE workspace_id = @id`, { id: workspaceId });
  await sqlRun(`DELETE FROM workspaces WHERE azure_org_url = @url`, { url: TEST_ORG_URL });
  await sqlRun(`DELETE FROM users WHERE email_or_unique_name = @email`, { email: TEST_EMAIL });
}

describeDb("workspace settings (DB-backed)", () => {
  let workspaceId: string;
  const savedEmail = process.env.BOOTSTRAP_OWNER_EMAIL;
  const savedLegacyOrg = process.env.BOOTSTRAP_OWNER_AZURE_ORG;

  beforeAll(async () => {
    process.env.BOOTSTRAP_OWNER_EMAIL = TEST_EMAIL;
    process.env.BOOTSTRAP_OWNER_AZURE_ORG = TEST_ORG;
    await cleanup();
    const bootstrap = await ensureBootstrapOwner();
    workspaceId = bootstrap!.workspaceId;
  });

  afterAll(async () => {
    await cleanup(workspaceId);
    if (savedEmail === undefined) delete process.env.BOOTSTRAP_OWNER_EMAIL;
    else process.env.BOOTSTRAP_OWNER_EMAIL = savedEmail;
    if (savedLegacyOrg === undefined) delete process.env.BOOTSTRAP_OWNER_AZURE_ORG;
    else process.env.BOOTSTRAP_OWNER_AZURE_ORG = savedLegacyOrg;
    await resetDatabaseForTests();
  });

  it("returns null before any settings are stored", async () => {
    expect(await getWorkspaceSettings(workspaceId)).toBeNull();
  });

  it("getRetrievalTopK falls back to the env default when the workspace has no override", async () => {
    delete process.env.PROJECT_CONTEXT_TOP_K;
    expect(await getRetrievalTopK(workspaceId)).toBe(DEFAULT_TOP_K);
  });

  it("upserts and round-trips both fields", async () => {
    const view = await upsertWorkspaceSettings({
      workspaceId,
      retrievalTopK: 12,
      maxOutputTokenCap: 64000,
      updatedByUserId: null,
    });
    expect(view).toEqual({
      retrievalTopK: 12,
      maxOutputTokenCap: 64000,
      llmRetryAttempts: null,
      manualBaselineMinutes: null,
      reviewBaselineMinutes: null,
      embeddings: EMPTY_WORKSPACE_EMBEDDINGS_VIEW,
    });
    expect(await getRetrievalTopK(workspaceId)).toBe(12);
  });

  it("treats null fields as 'inherit' — stored null, getRetrievalTopK falls back to env", async () => {
    await upsertWorkspaceSettings({
      workspaceId,
      retrievalTopK: null,
      maxOutputTokenCap: null,
      updatedByUserId: null,
    });
    expect(await getWorkspaceSettings(workspaceId)).toEqual({
      retrievalTopK: null,
      maxOutputTokenCap: null,
      llmRetryAttempts: null,
      manualBaselineMinutes: null,
      reviewBaselineMinutes: null,
      embeddings: EMPTY_WORKSPACE_EMBEDDINGS_VIEW,
    });
    process.env.PROJECT_CONTEXT_TOP_K = "20";
    expect(await getRetrievalTopK(workspaceId)).toBe(20);
    delete process.env.PROJECT_CONTEXT_TOP_K;
  });

  it("overwrites prior values on a subsequent upsert", async () => {
    await upsertWorkspaceSettings({ workspaceId, retrievalTopK: 5, maxOutputTokenCap: 16000, updatedByUserId: null });
    expect(await getWorkspaceSettings(workspaceId)).toEqual({
      retrievalTopK: 5,
      maxOutputTokenCap: 16000,
      llmRetryAttempts: null,
      manualBaselineMinutes: null,
      reviewBaselineMinutes: null,
      embeddings: EMPTY_WORKSPACE_EMBEDDINGS_VIEW,
    });
  });

  it("applies partial updates without clobbering the omitted field", async () => {
    await upsertWorkspaceSettings({ workspaceId, retrievalTopK: 5, maxOutputTokenCap: 16000, updatedByUserId: null });
    // Update only the cap — top-K is preserved (settings live in separate UI tabs).
    await upsertWorkspaceSettings({ workspaceId, maxOutputTokenCap: 64000, updatedByUserId: null });
    expect(await getWorkspaceSettings(workspaceId)).toEqual({
      retrievalTopK: 5,
      maxOutputTokenCap: 64000,
      llmRetryAttempts: null,
      manualBaselineMinutes: null,
      reviewBaselineMinutes: null,
      embeddings: EMPTY_WORKSPACE_EMBEDDINGS_VIEW,
    });
    // Update only top-K — the cap is preserved.
    await upsertWorkspaceSettings({ workspaceId, retrievalTopK: 8, updatedByUserId: null });
    expect(await getWorkspaceSettings(workspaceId)).toEqual({
      retrievalTopK: 8,
      maxOutputTokenCap: 64000,
      llmRetryAttempts: null,
      manualBaselineMinutes: null,
      reviewBaselineMinutes: null,
      embeddings: EMPTY_WORKSPACE_EMBEDDINGS_VIEW,
    });
    // An explicit null still clears (inherit) — distinct from "omitted".
    await upsertWorkspaceSettings({ workspaceId, retrievalTopK: null, updatedByUserId: null });
    expect(await getWorkspaceSettings(workspaceId)).toEqual({
      retrievalTopK: null,
      maxOutputTokenCap: 64000,
      llmRetryAttempts: null,
      manualBaselineMinutes: null,
      reviewBaselineMinutes: null,
      embeddings: EMPTY_WORKSPACE_EMBEDDINGS_VIEW,
    });
  });

  it("round-trips embeddings settings and never exposes the api key in the view", async () => {
    process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
    await upsertWorkspaceSettings({
      workspaceId,
      embeddings: {
        provider: "openai",
        model: "text-embedding-3-large",
        baseUrl: "https://example.test/v1",
        apiKey: "sk-embeddings-secret",
      },
      updatedByUserId: null,
    });

    const view = await getWorkspaceSettings(workspaceId);
    expect(view?.embeddings).toEqual({
      provider: "openai",
      model: "text-embedding-3-large",
      baseUrl: "https://example.test/v1",
      localDtype: null,
      hasApiKey: true,
    });
    // The plaintext key must never reach the view that the API serializes.
    expect(JSON.stringify(view)).not.toContain("sk-embeddings-secret");
    // ...but the server-only resolver decrypts it for the embedding provider.
    expect((await getWorkspaceEmbeddingsConfig(workspaceId))?.apiKey).toBe("sk-embeddings-secret");
  });

  it("keeps the stored embeddings key when omitted and clears it when explicitly null", async () => {
    process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
    await upsertWorkspaceSettings({
      workspaceId,
      embeddings: { provider: "gemini", apiKey: "sk-keep-me" },
      updatedByUserId: null,
    });

    // Saving other embedding fields without an apiKey must not wipe the key.
    await upsertWorkspaceSettings({
      workspaceId,
      embeddings: { model: "gemini-embedding-001" },
      updatedByUserId: null,
    });
    expect((await getWorkspaceSettings(workspaceId))?.embeddings).toMatchObject({
      provider: "gemini",
      model: "gemini-embedding-001",
      hasApiKey: true,
    });
    expect((await getWorkspaceEmbeddingsConfig(workspaceId))?.apiKey).toBe("sk-keep-me");

    // An explicit null clears it.
    await upsertWorkspaceSettings({
      workspaceId,
      embeddings: { apiKey: null },
      updatedByUserId: null,
    });
    expect((await getWorkspaceSettings(workspaceId))?.embeddings.hasApiKey).toBe(false);
    expect((await getWorkspaceEmbeddingsConfig(workspaceId))?.apiKey).toBeNull();
  });

  it("does not disturb embeddings settings when an unrelated tab saves", async () => {
    await upsertWorkspaceSettings({
      workspaceId,
      embeddings: { provider: "local", localDtype: "fp16" },
      updatedByUserId: null,
    });
    await upsertWorkspaceSettings({ workspaceId, retrievalTopK: 9, updatedByUserId: null });

    const view = await getWorkspaceSettings(workspaceId);
    expect(view?.retrievalTopK).toBe(9);
    expect(view?.embeddings).toMatchObject({ provider: "local", localDtype: "fp16" });
  });
});
