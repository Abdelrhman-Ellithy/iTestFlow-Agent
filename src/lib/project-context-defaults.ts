export const DEFAULT_CONTEXT_WORK_ITEM_TYPES = [
  "Epic",
  "Feature",
  "User Story",
  "Product Backlog Item",
  "Requirement",
]

export const DEFAULT_CONTEXT_STATES = [
  "New",
  "Active",
  "Approved",
  "Committed",
  "Ready",
  "In Progress",
  "Resolved",
  "Done",
  "Closed",
]

// Matches the Azure DevOps adapter's own default (fetchWorkItems' `limit` falls back
// to 200) and its cap (WIQL results are bounded at 5000 per fetch).
export const DEFAULT_CONTEXT_FETCH_LIMIT = 200
export const MAX_CONTEXT_FETCH_LIMIT = 5000
export const CONTEXT_FETCH_LIMIT_OPTIONS = [200, 500, 1000, 2000, 5000]
