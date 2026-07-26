"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect } from "@/components/ui/native-select"
import { apiErrorMessage } from "@/shared/lib/api-error-message"
import { OwnerOnlyNotice } from "./owner-only-notice"
import { Field, SecretField, SectionCard, StatusBadge } from "./section-card"

type EmbeddingsProvider = "off" | "local" | "ollama" | "openai" | "gemini"

type EmbeddingsSettings = {
  provider: string | null
  model: string | null
  baseUrl: string | null
  localDtype: string | null
  hasApiKey: boolean
}

type EmbeddingsDefaults = {
  provider: string
  model: string | null
  baseUrl: string | null
  localDtype: string
  hasApiKey: boolean
  providerOptions: readonly string[]
  localDtypeOptions: readonly string[]
  localDtypeSizes: Record<string, string>
  providerModelDefaults: Record<string, string>
}

type WorkspaceSettingsResponse = {
  settings: { embeddings: EmbeddingsSettings }
  defaults: { embeddingsDefaults: EmbeddingsDefaults }
}

const PROVIDER_LABELS: Record<EmbeddingsProvider, string> = {
  local: "Local (in-process) — recommended, zero setup",
  off: "Off — full-text and trigram search only",
  ollama: "Ollama (local server)",
  openai: "OpenAI-compatible",
  gemini: "Gemini",
}

const BASE_URL_PLACEHOLDERS: Partial<Record<EmbeddingsProvider, string>> = {
  ollama: "http://127.0.0.1:11434",
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
}

/** Cloud providers always need a key; OpenAI-compatible local servers do not. */
function needsApiKey(provider: EmbeddingsProvider, baseUrl: string) {
  if (provider === "gemini") return true
  if (provider === "openai") return !baseUrl.trim()
  return false
}

/**
 * Workspace-wide semantic search backend. Owner/admin only, so members see a
 * notice instead. Overrides the EMBEDDINGS_* deployment defaults; clearing a
 * field falls back to whatever the environment configures.
 */
export function SemanticSearchSection() {
  const [forbidden, setForbidden] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [defaults, setDefaults] = useState<EmbeddingsDefaults | null>(null)
  const [savedHasApiKey, setSavedHasApiKey] = useState(false)

  const [provider, setProvider] = useState<EmbeddingsProvider>("local")
  const [model, setModel] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [localDtype, setLocalDtype] = useState("")
  const [apiKey, setApiKey] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch("/api/workspace/settings", { cache: "no-store" })
      if (response.status === 401 || response.status === 403) {
        setForbidden(true)
        return
      }
      if (!response.ok) {
        toast.error("Could not load the semantic search settings.")
        return
      }
      const data = (await response.json()) as WorkspaceSettingsResponse
      const stored = data.settings.embeddings
      const inherited = data.defaults.embeddingsDefaults
      setDefaults(inherited)
      setProvider((stored.provider ?? inherited.provider ?? "local") as EmbeddingsProvider)
      setModel(stored.model ?? "")
      setBaseUrl(stored.baseUrl ?? "")
      setLocalDtype(stored.localDtype ?? "")
      setSavedHasApiKey(stored.hasApiKey)
    } catch {
      toast.error("Could not load the semantic search settings.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function onSave() {
    setSaving(true)
    try {
      const response = await fetch("/api/workspace/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          embeddings: {
            provider,
            model: model.trim() || null,
            baseUrl: baseUrl.trim() || null,
            localDtype: localDtype || null,
            // Omitted entirely when untouched, so the stored key survives a save.
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          },
        }),
      })
      const data = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        toast.error(apiErrorMessage(data, "Could not save the semantic search settings."))
        return
      }
      toast.success("Semantic search settings saved.")
      setApiKey("")
      await load()
    } finally {
      setSaving(false)
    }
  }

  const isLocal = provider === "local"
  const isServerBacked = provider === "ollama" || provider === "openai" || provider === "gemini"
  const providerOptions = (defaults?.providerOptions ?? ["off", "local", "ollama", "openai", "gemini"]) as EmbeddingsProvider[]
  const dtypeOptions = defaults?.localDtypeOptions ?? ["q8", "fp16", "fp32", "q4"]
  const dtypeSizes = defaults?.localDtypeSizes ?? {}
  const effectiveDtype = localDtype || defaults?.localDtype || "q8"
  const modelPlaceholder =
    provider !== "off" ? defaults?.providerModelDefaults?.[provider] ?? "Provider default" : "Provider default"

  return (
    <SectionCard
      title="Semantic Search (Embeddings)"
      description="Powers meaning-based retrieval for the Business Owner Assistant and workflow auto-context, alongside full-text and trigram search. Shared by everyone in this workspace."
      action={
        <StatusBadge
          tone={provider === "off" ? "muted" : "success"}
          label={provider === "off" ? "Off" : isLocal ? "Local" : "Configured"}
        />
      }
    >
      {forbidden ? (
        <OwnerOnlyNotice />
      ) : (
        <div className="space-y-4">
          <Field
            label="Embedding backend"
            htmlFor="embeddings-provider"
            description={
              isLocal
                ? `Default. Runs in-process — no server to install, no API key, nothing to configure. The model (${dtypeSizes[effectiveDtype] ?? "~131 MB"}) downloads itself on first use and then runs locally.`
                : provider === "off"
                  ? "Semantic search is disabled. Retrieval still uses full-text and trigram search, which stay fast but only match on wording rather than meaning."
                  : "Any embedding failure falls back to full-text and trigram search — it never breaks retrieval."
            }
          >
            <NativeSelect
              id="embeddings-provider"
              value={provider}
              disabled={loading}
              onChange={(event) => setProvider(event.target.value as EmbeddingsProvider)}
            >
              {providerOptions.map((option) => (
                <option key={option} value={option}>
                  {PROVIDER_LABELS[option] ?? option}
                </option>
              ))}
            </NativeSelect>
          </Field>

          {isLocal ? (
            <Field
              label="Local model precision"
              htmlFor="embeddings-local-dtype"
              description="Lower precision downloads less and runs faster; higher precision is more accurate. Changing this re-embeds indexed content on the next sync."
            >
              <NativeSelect
                id="embeddings-local-dtype"
                value={localDtype}
                disabled={loading}
                onChange={(event) => setLocalDtype(event.target.value)}
              >
                <option value="">
                  Default — {defaults?.localDtype ?? "q8"} ({dtypeSizes[defaults?.localDtype ?? "q8"] ?? "~131 MB"})
                </option>
                {dtypeOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                    {dtypeSizes[option] ? ` (${dtypeSizes[option]})` : ""}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          ) : null}

          {provider !== "off" ? (
            <Field
              label="Embedding model (optional)"
              htmlFor="embeddings-model"
              description="Leave blank to use this backend's default model."
            >
              <Input
                id="embeddings-model"
                className="h-8 border-input bg-card text-foreground"
                value={model}
                disabled={loading}
                onChange={(event) => setModel(event.target.value)}
                placeholder={modelPlaceholder}
              />
            </Field>
          ) : null}

          {isServerBacked ? (
            <>
              <Field
                label="Base URL (optional)"
                htmlFor="embeddings-base-url"
                description={
                  provider === "openai"
                    ? "Point this at a local OpenAI-compatible server (LM Studio, llama.cpp, vLLM) to run without a cloud key."
                    : "Leave blank to use this backend's default endpoint."
                }
              >
                <Input
                  id="embeddings-base-url"
                  className="h-8 border-input bg-card text-foreground"
                  value={baseUrl}
                  disabled={loading}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder={BASE_URL_PLACEHOLDERS[provider] ?? ""}
                />
              </Field>

              <SecretField
                id="embeddings-api-key"
                label={`Embeddings API key${needsApiKey(provider, baseUrl) ? "" : " (optional)"}`}
                value={apiKey}
                onChange={setApiKey}
                placeholder="Enter embeddings API key"
                hasSaved={savedHasApiKey}
                description={
                  provider === "ollama"
                    ? "Ollama runs locally and needs no key."
                    : "Encrypted server-side and never returned to the browser. Leave the saved key in place to keep it."
                }
              />
            </>
          ) : null}

          <Button type="button" onClick={() => void onSave()} disabled={saving || loading}>
            {saving ? (
              <>
                <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
                Saving…
              </>
            ) : (
              "Save semantic search"
            )}
          </Button>
        </div>
      )}
    </SectionCard>
  )
}
