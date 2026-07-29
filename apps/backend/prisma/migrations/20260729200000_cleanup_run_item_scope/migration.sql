-- Item ids a cleanup run was narrowed to, on top of the policy's own scope.
-- NULL is an ordinary library-wide sweep, so every existing run is unchanged.
ALTER TABLE "media_cleanup_runs" ADD COLUMN "scopeItemIds" JSONB;
