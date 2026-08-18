-- Clearing a history item's downloaded flag could never lead to a re-download:
-- `processFeed` skips any feed item it already holds history for, regardless of
-- the flag. This marker is what the poll consults, so only items an operator
-- explicitly cleared are reconsidered.
ALTER TABLE "rss_history" ADD COLUMN "regrabRequestedAt" TIMESTAMP(3);
