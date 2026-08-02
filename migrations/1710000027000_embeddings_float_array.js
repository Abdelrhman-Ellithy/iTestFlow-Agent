/* eslint-disable camelcase */

/**
 * Stores embedding vectors as a native `real[]` instead of JSON text.
 *
 * Measured on real data before this change: each 768-dimension vector occupied
 * ~16.2 KB as JSON text, so a semantic query over 400 chunks transferred 6.18 MB and
 * took ~121 ms — almost all of it `JSON.parse`. Extrapolated to 10,000 chunks that is
 * ~155 MB and ~3 s per query, and a single chat message runs two semantic searches.
 *
 * `real[]` stores 4 bytes per dimension (~3 KB per vector, ~5x smaller) and the pg
 * driver decodes it directly into a JS number array, removing JSON parsing from the
 * per-query hot path entirely.
 *
 * The backfill converts existing vectors in place, so no re-embedding is needed.
 * Rows whose vector_json is absent or malformed are left NULL and will be re-embedded
 * by the next sync (the pending-chunks query already treats a missing vector as work
 * to do).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS vector real[];`);
  // A malformed value must not abort the migration. `vector_json::jsonb` inside a
  // WHERE qualifier is NOT a safe guard: Postgres may evaluate the cast before the
  // condition that was meant to protect it, so one bad row raises and rolls back the
  // whole migration. Convert through a function that returns NULL on invalid input
  // instead, leaving such rows with a NULL vector for the next sync to re-embed.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION pg_temp.safe_jsonb(value text) RETURNS jsonb AS $$
    BEGIN
      RETURN value::jsonb;
    EXCEPTION WHEN others THEN
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql IMMUTABLE;
  `);
  pgm.sql(`
    UPDATE embeddings
    SET vector = ARRAY(
      SELECT value::real
      FROM jsonb_array_elements_text(pg_temp.safe_jsonb(vector_json)) AS value
    )
    WHERE vector IS NULL
      AND vector_json IS NOT NULL
      AND jsonb_typeof(pg_temp.safe_jsonb(vector_json)) = 'array';
  `);
  pgm.sql(`ALTER TABLE embeddings DROP COLUMN IF EXISTS vector_json;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS vector_json text;`);
  pgm.sql(`
    UPDATE embeddings
    SET vector_json = to_jsonb(vector)::text
    WHERE vector_json IS NULL
      AND vector IS NOT NULL;
  `);
  pgm.sql(`ALTER TABLE embeddings DROP COLUMN IF EXISTS vector;`);
};
