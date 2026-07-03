-- UPLM module-catalog export is now an internal dev-only CLI tool; its in-app
-- HTTP endpoints + event log are removed. Drop the (dev-tool) events table.
DROP TABLE IF EXISTS "uplm_module_export_events";
