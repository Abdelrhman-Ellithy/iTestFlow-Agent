/* eslint-disable camelcase */

/**
 * Adds a human-entered expected answer to each collected benchmark question, so
 * retrieval-benchmark-runner.service.ts can score the REAL retrieval path against
 * REAL collected questions instead of only the hand-written fixtures in
 * embedding-retrieval.quality.db.test.ts.
 *
 * Flat columns match this table's existing style: a case carries at most one
 * current label (the latest admin edit wins), not a label history.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE project_knowledge_benchmark_cases
      ADD COLUMN IF NOT EXISTS expected_work_item_id text,
      ADD COLUMN IF NOT EXISTS expected_answer_snippet text,
      ADD COLUMN IF NOT EXISTS labeled_at text,
      ADD COLUMN IF NOT EXISTS labeled_by text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE project_knowledge_benchmark_cases
      DROP COLUMN IF EXISTS expected_work_item_id,
      DROP COLUMN IF EXISTS expected_answer_snippet,
      DROP COLUMN IF EXISTS labeled_at,
      DROP COLUMN IF EXISTS labeled_by;
  `);
};
