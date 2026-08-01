/**
 * Reports whether a project's context index is in a state retrieval can actually use.
 *
 * Read-only. Written because the two ways an index silently goes dark are both
 * invisible from the UI — retrieval keeps returning results, just worse ones:
 *
 * 1. **Stale vectors.** Embeddings are keyed by a vector reference that includes the
 *    embedded-text recipe. Bump the recipe and every stored vector stops matching, so
 *    semantic search returns nothing and hybrid search quietly degrades to full-text
 *    plus trigram. Nothing errors.
 *
 * 2. **Stale chunks.** Work items only re-chunk when their content changes, so a
 *    chunking-algorithm change reaches new and edited items and leaves everything else
 *    on the old shape indefinitely. `chunk_recipe_version` is what makes that visible.
 *
 * `npm run context:repair` fixes (1) from local data alone. Fixing (2) needs a real
 * sync, because re-chunking reads the work item from the provider.
 *
 * Run:  npm run context:verify -- <projectId>
 *       npm run context:verify -- --all
 * Env:  DATABASE_URL
 */
import { sqlAll } from "@/modules/shared/infrastructure/database/db";
import { createEmbeddingProvider } from "@/modules/rag/embedding-provider";
import { chunkVectorReference } from "@/modules/rag/embedding-store.service";
import { CURRENT_CHUNK_TEXT_RECIPE_VERSION } from "@/modules/rag/project-context-store.service";

type ProjectRow = {
  id: string;
  azure_project_id: string;
  azure_project_name: string;
};

async function loadProjects(projectId?: string): Promise<ProjectRow[]> {
  return sqlAll<ProjectRow>(
    `SELECT id, azure_project_id, azure_project_name
       FROM projects
      WHERE (@projectId::text IS NULL OR id = @projectId)
      ORDER BY id`,
    { projectId: projectId ?? null },
  );
}

type Counts = {
  active_items: string;
  items_on_current_recipe: string;
  items_stale_recipe: string;
  core_chunks: string;
  ac_chunks: string;
  unlabelled_chunks: string;
  embeddings_current: string;
  embeddings_stale: string;
};

async function countsFor(project: ProjectRow, expectedVectorReference: string): Promise<Counts> {
  const [row] = await sqlAll<Counts>(
    `
      SELECT
        (SELECT count(*)::text FROM azure_devops_work_items
          WHERE project_id = @projectId AND azure_project_id = @azureProjectId
            AND coalesce(sync_status, 'active') = 'active')                       AS active_items,
        (SELECT count(*)::text FROM azure_devops_work_items
          WHERE project_id = @projectId AND azure_project_id = @azureProjectId
            AND coalesce(sync_status, 'active') = 'active'
            AND chunk_recipe_version = @chunkRecipe)                              AS items_on_current_recipe,
        -- Retired items are excluded deliberately: sync no longer touches them, so they
        -- can never be re-chunked and would report a stale shape forever with no action
        -- that could ever clear it.
        (SELECT count(*)::text FROM azure_devops_work_items
          WHERE project_id = @projectId AND azure_project_id = @azureProjectId
            AND coalesce(sync_status, 'active') = 'active'
            AND chunk_recipe_version IS DISTINCT FROM @chunkRecipe)               AS items_stale_recipe,
        (SELECT count(*)::text FROM document_chunks
          WHERE project_id = @projectId AND azure_project_id = @azureProjectId
            AND source_type = 'azure_work_item'
            AND (metadata_json::jsonb ->> 'field') = 'core')                      AS core_chunks,
        (SELECT count(*)::text FROM document_chunks
          WHERE project_id = @projectId AND azure_project_id = @azureProjectId
            AND source_type = 'azure_work_item'
            AND (metadata_json::jsonb ->> 'field') = 'acceptance_criteria')       AS ac_chunks,
        (SELECT count(*)::text FROM document_chunks
          WHERE project_id = @projectId AND azure_project_id = @azureProjectId
            AND source_type = 'azure_work_item'
            AND (metadata_json::jsonb ->> 'field') IS NULL)                       AS unlabelled_chunks,
        (SELECT count(*)::text FROM embeddings
          WHERE project_id = @projectId AND azure_project_id = @azureProjectId
            AND source_type = 'azure_work_item_chunk'
            AND vector_reference = @vectorReference)                              AS embeddings_current,
        (SELECT count(*)::text FROM embeddings
          WHERE project_id = @projectId AND azure_project_id = @azureProjectId
            AND source_type = 'azure_work_item_chunk'
            AND vector_reference IS DISTINCT FROM @vectorReference)               AS embeddings_stale
    `,
    {
      projectId: project.id,
      azureProjectId: project.azure_project_id,
      chunkRecipe: CURRENT_CHUNK_TEXT_RECIPE_VERSION,
      vectorReference: expectedVectorReference,
    },
  );
  return row;
}

function report(project: ProjectRow, counts: Counts): boolean {
  const staleItems = Number(counts.items_stale_recipe);
  const staleVectors = Number(counts.embeddings_stale);
  const currentVectors = Number(counts.embeddings_current);
  const unlabelled = Number(counts.unlabelled_chunks);

  console.log(`\n${project.azure_project_name} (${project.id})`);
  console.log(`  active work items           : ${counts.active_items}`);
  console.log(`  chunks by field             : ${counts.core_chunks} core, ${counts.ac_chunks} acceptance-criteria, ${unlabelled} unlabelled`);
  console.log(`  vectors at current recipe   : ${currentVectors}`);

  let healthy = true;
  // A project with nothing indexed is not broken, it is empty. Reporting it unhealthy
  // would make this exit non-zero for any org holding one never-synced project, which
  // turns a deploy gate into a permanent false alarm.
  const indexedItems = Number(counts.active_items);
  if (!indexedItems) {
    console.log("  not indexed yet             : nothing to verify (run a sync to populate it).");
    return true;
  }
  if (staleVectors > 0 || currentVectors === 0) {
    healthy = false;
    console.log(`  SEMANTIC SEARCH IS DARK     : ${staleVectors} vector(s) at an old recipe, ${currentVectors} usable.`);
    console.log(`                                Fix: npm run context:repair -- ${project.id}`);
  }
  if (staleItems > 0) {
    healthy = false;
    console.log(`  chunks on an old shape      : ${staleItems} item(s) never re-chunked.`);
    console.log(`                                Fix: run a sync for this project (Load Project Index -> Index Now).`);
  }
  if (healthy) console.log("  OK: retrieval sees the full corpus at the current recipe.");
  return healthy;
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: npm run context:verify -- <projectId>   (or --all)");
    process.exitCode = 1;
    return;
  }

  const projects = await loadProjects(target === "--all" ? undefined : target);
  if (!projects.length) {
    console.error(target === "--all" ? "No projects found." : `No project found with id ${target}.`);
    process.exitCode = 1;
    return;
  }

  const expectedVectorReference = chunkVectorReference(createEmbeddingProvider());
  console.log(`Chunk recipe: ${CURRENT_CHUNK_TEXT_RECIPE_VERSION}`);
  console.log(`Vector reference: ${expectedVectorReference}`);

  let allHealthy = true;
  for (const project of projects) {
    const counts = await countsFor(project, expectedVectorReference);
    if (!report(project, counts)) allHealthy = false;
  }

  // Non-zero exit so this can gate a deploy step rather than only inform a human.
  if (!allHealthy) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
