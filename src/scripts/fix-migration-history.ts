/**
 * One-time reconciliation for a database that already ran this repo's migrations under
 * their pre-rename filenames.
 *
 * Two migrations that had nothing to do with each other independently claimed the
 * timestamps 1710000022000 / 1710000023000: this fork's own `embeddings_indexes` /
 * `trigram_search`, and (once a later merge from upstream landed)
 * `workspace_external_llm_setting` / `workspace_model_input_limit_override`. The fix is
 * to renumber this fork's own two files to an unused slot (1710000021100 /
 * 1710000021200) and delete a second pair (1710000025000 / 1710000026000) that added a
 * setting and reverted it within the same branch, never shipped, and nothing references.
 *
 * node-pg-migrate matches applied migrations by exact filename, recorded in the
 * `pgmigrations` table. Renaming or deleting a file that a database already ran leaves
 * that database's history referring to a name that no longer exists on disk, and the
 * next `up` or `down` fails with "Not run migration X is preceding already run migration
 * Y" -- the same error this whole rename was meant to fix, now for a different reason.
 *
 * This updates the two renamed rows in place (preserving their existing run order) and
 * removes rows for files that no longer exist on disk: the reverted-within-branch
 * settings pair, and (on a database that migrated during this repo's own brief window of
 * renaming the wrong side of the collision before correcting it) the stray 030000/031000
 * records that window left behind. Idempotent: safe to re-run on a database that already
 * did not need it, or already had it applied.
 *
 * Run:  node --env-file=.env --conditions=react-server --import tsx src/scripts/fix-migration-history.ts
 * Env:  DATABASE_URL
 */
import { sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";

const RENAMES: Array<{ from: string; to: string }> = [
  { from: "1710000022000_embeddings_indexes", to: "1710000021100_embeddings_indexes" },
  { from: "1710000023000_trigram_search", to: "1710000021200_trigram_search" },
];

/**
 * A second, unrelated ordering problem on any database that already had this fork's own
 * later migrations (27000/28000/29000) applied *before* first merging upstream's
 * 22000/23000: node-pg-migrate orders applied history by `run_on` (actual execution
 * time), not by filename. Upstream minted the 22000/23000 timestamps in its own history
 * long ago, but this fork only executed them for the first time whenever it happened to
 * merge that upstream commit -- which, on a database already past 27000-29000, is *after*
 * them by wall-clock time despite sorting *before* them by filename. That mismatch is the
 * same "not run migration X is preceding already run migration Y" failure, for a
 * completely different reason than the renamed files above, and it is not specific to any
 * one machine -- every existing deployment upgrading past this point hits it once.
 *
 * Fixed the same way as any out-of-order backfill: back-date `run_on` to sit just after
 * the migration immediately before it in file order, so recorded run order matches file
 * order without re-running anything (both are additive `ADD COLUMN IF NOT EXISTS`, so
 * there is nothing to re-apply).
 */
const REORDER_BETWEEN: Array<{ name: string; mustFollow: string; mustPrecede: string }> = [
  {
    name: "1710000022000_workspace_external_llm_setting",
    mustFollow: "1710000021200_trigram_search",
    mustPrecede: "1710000024000_embeddings_source_type",
  },
  {
    name: "1710000023000_workspace_model_input_limit_override",
    mustFollow: "1710000022000_workspace_external_llm_setting",
    mustPrecede: "1710000024000_embeddings_source_type",
  },
];

const REMOVED = [
  "1710000025000_workspace_settings_embeddings",
  "1710000026000_drop_workspace_settings_embeddings",
  // Left behind on any database that ran migrate during this repo's own brief window of
  // renaming these to 030000/031000 before reverting to upstream's original 022000/023000
  // names. Both are additive `ADD COLUMN IF NOT EXISTS`, so running the correctly-named
  // migration afterward was harmless -- these rows are pure bookkeeping debris for files
  // that no longer exist, not a second real application of the migration.
  "1710000030000_workspace_external_llm_setting",
  "1710000031000_workspace_model_input_limit_override",
];

async function main() {
  for (const { from, to } of RENAMES) {
    const updated = await sqlRun(
      `UPDATE pgmigrations SET name = @to WHERE name = @from`,
      { from, to },
    );
    console.log(updated ? `renamed: ${from} -> ${to}` : `not present (already fixed or never run): ${from}`);
  }
  for (const name of REMOVED) {
    const removed = await sqlRun(`DELETE FROM pgmigrations WHERE name = @name`, { name });
    console.log(removed ? `removed dead migration record: ${name}` : `not present (already fixed or never run): ${name}`);
  }

  // Processed in order: the second pair's `mustFollow` is the first pair's `name`, so its
  // corrected run_on has to be visible before this step runs. Placed at the midpoint
  // between the two anchors rather than a fixed offset -- the two anchors can be
  // microseconds apart (all three ran in the same original batch), and a flat "+1 second"
  // can overshoot past mustPrecede entirely.
  for (const { name, mustFollow, mustPrecede } of REORDER_BETWEEN) {
    const row = await sqlGet<{ run_on: string }>(
      `SELECT run_on FROM pgmigrations WHERE name = @name`,
      { name },
    );
    if (!row) {
      console.log(`not present (already fixed or never run): ${name}`);
      continue;
    }
    const before = await sqlGet<{ run_on: string }>(
      `SELECT run_on FROM pgmigrations WHERE name = @mustFollow`,
      { mustFollow },
    );
    const after = await sqlGet<{ run_on: string }>(
      `SELECT run_on FROM pgmigrations WHERE name = @mustPrecede`,
      { mustPrecede },
    );
    if (!before || !after) {
      console.log(`skipped ${name}: an anchor (${mustFollow} / ${mustPrecede}) was not found`);
      continue;
    }
    if (
      new Date(before.run_on).getTime() < new Date(row.run_on).getTime()
      && new Date(row.run_on).getTime() < new Date(after.run_on).getTime()
    ) {
      console.log(`already in order: ${name}`);
      continue;
    }
    if (new Date(before.run_on).getTime() >= new Date(after.run_on).getTime()) {
      throw new Error(
        `Cannot reorder ${name}: ${mustFollow} does not actually precede ${mustPrecede} in this database's history.`,
      );
    }
    await sqlRun(
      `UPDATE pgmigrations
         SET run_on = @beforeRunOn::timestamp + ((@afterRunOn::timestamp - @beforeRunOn::timestamp) / 2)
       WHERE name = @name`,
      { name, beforeRunOn: before.run_on, afterRunOn: after.run_on },
    );
    console.log(`reordered: ${name} to run between ${mustFollow} and ${mustPrecede}`);
  }

  console.log("\nDone. `npm run db:migrate` should now report nothing pending for these.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
