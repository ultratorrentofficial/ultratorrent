-- Add the re-execution input column for retry/rerun/resume.
ALTER TABLE "platform_jobs" ADD COLUMN "inputData" JSONB;
