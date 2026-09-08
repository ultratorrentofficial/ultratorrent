-- An explicit switch for whether a template may create monitoring on its own.
--
-- Off means everything it would have auto-monitored lands in review instead,
-- with the reason saying so. A switch rather than "clear the auto-monitor
-- categories": the categories record what you are LOOKING FOR, and emptying them
-- to stop automation throws that away too.
--
-- Defaults to true so existing templates behave exactly as before.
ALTER TABLE "discovery_templates"
  ADD COLUMN "autoMonitorEnabled" BOOLEAN NOT NULL DEFAULT true;

-- Re-decide under the new column rather than keeping verdicts reached without it.
UPDATE "discovery_templates" SET "policyVersion" = "policyVersion" + 1;
DELETE FROM "discovery_evaluations";
