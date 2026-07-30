/**
 * Repairs a project context index that has drifted out of a searchable state.
 *
 * Two independent conditions leave indexed content unreachable, and both are
 * recoverable from data already stored locally — no Azure DevOps round trip, no
 * credentials, no re-fetch:
 *
 * 1. **Work items wrongly marked inactive.** Incremental sync used to retire every
 *    previously indexed item that was not in the current fetch. With a capped fetch
 *    that retired everything outside the pagination window, and all retrieval filters
 *    on `sync_status = 'active'`. The cause is fixed, but rows already marked inactive
 *    stay that way until a run happens to fetch them again.
 *
 * 2. **Stale search structures.** The full-text/trigram mirror is rebuilt from active
 *    items only, so it shrinks with them. Embeddings are keyed by a vector reference
 *    that includes the embedded-text recipe, so a recipe change leaves every stored
 *    vector unreadable until re-embedded.
 *
 * Safe to re-run: every step is idempotent. An item that genuinely left scope is
 * re-retired by the next sync that sees the complete matching set, so reactivating
 * errs toward content being searchable — the direction that fails safely.
 *
 * Run:  npm run context:repair -- <projectId>
 *       npm run context:repair -- --all
 * Env:  DATABASE_URL
 */
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { nowIso, sqlAll, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { refreshProjectContextSearchIndex } from "@/modules/rag/context-chatbot-retrieval.service";
import { createEmbeddingProvider } from "@/modules/rag/embedding-provider";
import { syncProjectChunkEmbeddings } from "@/modules/rag/embedding-store.service";

type ProjectRow = {
  id: string;
  azure_project_id: string;
  azure_project_name: string;
  azure_organization_url: string;
};

async function loadProjects(projectId?: string): Promise<ProjectRow[]> {
  return sqlAll<ProjectRow>(
    `SELECT id, azure_project_id, azure_project_name, azure_organization_url
       FROM projects
      WHERE (@projectId::text IS NULL OR id = @projectId)
      ORDER BY id`,
    { projectId: projectId ?? null },
  );
}

/**
 * Reactivates items that were retired despite still having indexed chunks — the exact
 * signature of the pagination bug. An item with no chunks is left alone: there is
 * nothing to make searchable, and it may have been retired for a real reason.
 */
async function reactivateIndexedItems(scope: ProjectScope): Promise<number> {
  const now = nowIso();
  return sqlRun(
    `UPDATE azure_devops_work_items wi
        SET sync_status = 'active', updated_at = @now
      WHERE wi.project_id = @projectId
        AND wi.azure_project_id = @azureProjectId
        AND wi.sync_status = 'inactive'
        AND EXISTS (
          SELECT 1 FROM document_chunks dc
           WHERE dc.project_id = wi.project_id
             AND dc.azure_project_id = wi.azure_project_id
             AND dc.azure_work_item_id = wi.azure_work_item_id
        )`,
    { projectId: scope.projectId, azureProjectId: scope.azureProjectId, now },
  );
}

async function countChunks(scope: ProjectScope, table: "document_chunks" | "document_chunks_fts") {
  const [row] = await sqlAll<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table}
      WHERE project_id = @projectId AND azure_project_id = @azureProjectId`,
    { projectId: scope.projectId, azureProjectId: scope.azureProjectId },
  );
  return Number(row?.n ?? 0);
}

async function repairProject(project: ProjectRow) {
  const scope = assertProjectScope({
    projectId: project.id,
    azureProjectId: project.azure_project_id,
    azureProjectName: project.azure_project_name,
    azureOrganizationUrl: project.azure_organization_url,
  });
  console.log(`\n${project.azure_project_name} (${project.id})`);

  const reactivated = await reactivateIndexedItems(scope);
  console.log(`  reactivated work items      : ${reactivated}`);

  // Must follow reactivation: the mirror is rebuilt from active items only, so
  // rebuilding first would simply re-create the shrunken index.
  await refreshProjectContextSearchIndex({ scope });
  const stored = await countChunks(scope, "document_chunks");
  const indexed = await countChunks(scope, "document_chunks_fts");
  console.log(`  full-text/trigram index     : ${indexed} of ${stored} chunks`);

  // Embeds only what is missing at the current recipe, so a re-run costs nothing.
  const embedding = await syncProjectChunkEmbeddings({ scope, provider: createEmbeddingProvider() });
  console.log(`  embedded chunks             : ${embedding.embeddedChunkCount} (removed orphans: ${embedding.removedEmbeddingCount})`);
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: npm run context:repair -- <projectId>   (or --all)");
    process.exitCode = 1;
    return;
  }

  const projects = await loadProjects(target === "--all" ? undefined : target);
  if (!projects.length) {
    console.error(target === "--all" ? "No projects found." : `No project found with id ${target}.`);
    process.exitCode = 1;
    return;
  }

  // Embedding is single-threaded local inference: measured ~380ms per chunk, so a
  // recipe bump on a 1,155-chunk project took ~7 minutes. Scales linearly, so say so
  // rather than letting an operator think a stalled run is normal.
  console.log(
    `Repairing ${projects.length} project(s). Embedding runs locally at roughly 400ms per chunk, `
    + `so a few thousand chunks can take several minutes.`,
  );
  for (const project of projects) await repairProject(project);
  console.log("\nDone. Retrieval should now see the full indexed corpus.");
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
