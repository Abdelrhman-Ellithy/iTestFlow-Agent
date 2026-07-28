/* eslint-disable camelcase */

/**
 * Removes the per-workspace embeddings override added by
 * 1710000025000_workspace_settings_embeddings.
 *
 * The embedding backend is no longer configurable: one pinned local model
 * (nomic-embed-text-v1.5, in-process) is always used. Making it configurable was a
 * mistake — swapping embedding models silently invalidates every stored vector,
 * because vectors are only comparable within the model that produced them, so a
 * one-line settings change quietly broke semantic search until a full re-index that
 * nothing prompted for.
 *
 * `down` recreates the columns but cannot recover dropped values; any workspace that
 * had configured a non-default backend has to be reconfigured. That is acceptable
 * here because the feature shipped and was removed within a single unreleased change
 * set.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE workspace_settings
      DROP COLUMN IF EXISTS embeddings_provider,
      DROP COLUMN IF EXISTS embeddings_model,
      DROP COLUMN IF EXISTS embeddings_base_url,
      DROP COLUMN IF EXISTS embeddings_local_dtype,
      DROP COLUMN IF EXISTS embeddings_api_key_ciphertext,
      DROP COLUMN IF EXISTS embeddings_api_key_iv,
      DROP COLUMN IF EXISTS embeddings_api_key_tag,
      DROP COLUMN IF EXISTS embeddings_api_key_version;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE workspace_settings
      ADD COLUMN IF NOT EXISTS embeddings_provider text,
      ADD COLUMN IF NOT EXISTS embeddings_model text,
      ADD COLUMN IF NOT EXISTS embeddings_base_url text,
      ADD COLUMN IF NOT EXISTS embeddings_local_dtype text,
      ADD COLUMN IF NOT EXISTS embeddings_api_key_ciphertext text,
      ADD COLUMN IF NOT EXISTS embeddings_api_key_iv text,
      ADD COLUMN IF NOT EXISTS embeddings_api_key_tag text,
      ADD COLUMN IF NOT EXISTS embeddings_api_key_version integer;
  `);
};
