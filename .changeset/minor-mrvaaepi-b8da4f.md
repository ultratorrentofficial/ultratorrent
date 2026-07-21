---
"ultratorrent": minor
---

Workflow Builder Phase 4b — visual editor (@xyflow/react). Adds the Workflows UI: a searchable/paginated list with a create dialog, and a lazy-loaded canvas editor (kept off the main bundle) with a catalog-driven node palette (grouped by category, so it always reflects the real registered triggers/actions — no drift), typed port handles per node, a node settings panel (required config, destructive-acknowledgement safeguard, delay/wait timeouts, free-form config), live debounced validation with clickable issue markers, save-draft/publish/enable/disable, read-only mode when the user lacks workflows.edit, and an accessible non-canvas graph representation. New workflows API client + full en-US/es-PR i18n namespace (parity green) + Automation-domain nav entry. Node definitions now carry a display label sourced from the automation catalog.
