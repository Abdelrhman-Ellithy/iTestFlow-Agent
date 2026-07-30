/* eslint-disable camelcase */

/**
 * Workspace-wide model input-context override. NULL preserves automatic model
 * capability detection; a non-null value is validated against the supported
 * preset list at the workspace settings API boundary.
 *
 * The retired per-user value is intentionally not copied: selecting a shared
 * workspace limit must be an explicit owner/admin decision.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE workspace_settings
      ADD COLUMN IF NOT EXISTS model_input_token_limit_override integer;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE workspace_settings
      DROP COLUMN IF EXISTS model_input_token_limit_override;
  `);
};
