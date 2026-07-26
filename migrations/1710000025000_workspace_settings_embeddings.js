/* eslint-disable camelcase */

/**
 * Adds per-workspace semantic-search (embeddings) configuration to
 * workspace_settings, so owners/admins can manage it from Settings instead of
 * only through EMBEDDINGS_* environment variables.
 *
 * Every column is nullable and NULL means "inherit the deployment default"
 * (the EMBEDDINGS_* env vars, which themselves default to the zero-setup local
 * backend) — matching the existing null-means-inherit convention of this table.
 *
 * The API key is stored with the same AES-256-GCM envelope the credentials
 * tables use (ciphertext + iv + tag + key version as separate columns), never
 * as plaintext.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
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

exports.down = (pgm) => {
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
