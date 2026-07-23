---
"ultratorrent": patch
---

Fix dead Duplicate Center bulk/quick-clean endpoints — they were shadowed by the :groupId routes. The static routes (duplicates/bulk/preview, duplicates/bulk/resolve, duplicates/quick-clean/candidates, duplicates/trash/history) were declared AFTER duplicates/:groupId/preview etc., and Nest matches in declaration order, so POST duplicates/bulk/preview was captured by duplicates/:groupId/preview with groupId='bulk' and rejected with 400 'property groupIds should not exist'. The UI's Quick Clean button hit exactly this. All literal duplicate routes are now declared before the parameterized :groupId routes; a route-ordering regression test introspects the controller metadata so a literal route can never again be declared behind a parameter route that would capture it. Verified live: POST duplicates/bulk/preview now reaches its handler (201 with succeeded/failed/results) instead of the whitelist 400.
