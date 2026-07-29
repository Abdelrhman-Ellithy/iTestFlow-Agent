/* eslint-disable camelcase */

/**
 * Adds chunk_recipe_version to azure_devops_work_items to track which chunking
 * algorithm produced the current chunks. When the CHUNK_RECIPE_VERSION constant
 * changes (e.g., to implement field-aware chunking), items with a mismatched version
 * are re-chunked on the next incremental sync.
 *
 * Without this, an incremental sync on unchanged content would skip re-chunking
 * (content_hash match), leaving items on stale chunking indefinitely.
 *
 * Nullable: old rows have no version, new rows get the current CHUNK_RECIPE_VERSION.
 * Incremental sync compares existing?.chunk_recipe_version to CURRENT_CHUNK_TEXT_RECIPE_VERSION
 * and re-chunks on mismatch or null.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE azure_devops_work_items
      ADD COLUMN IF NOT EXISTS chunk_recipe_version text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE azure_devops_work_items
      DROP COLUMN IF EXISTS chunk_recipe_version;
  `);
};
