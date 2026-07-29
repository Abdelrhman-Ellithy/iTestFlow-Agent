/* eslint-disable camelcase */

/**
 * Workspace-wide control for the manual External LLM copy/paste workflow.
 * Existing rows receive the backwards-compatible enabled default; workspaces
 * without a settings row continue to be treated as enabled by the service/API.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE workspace_settings
      ADD COLUMN IF NOT EXISTS external_llm_enabled boolean NOT NULL DEFAULT true;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE workspace_settings
      DROP COLUMN IF EXISTS external_llm_enabled;
  `);
};
