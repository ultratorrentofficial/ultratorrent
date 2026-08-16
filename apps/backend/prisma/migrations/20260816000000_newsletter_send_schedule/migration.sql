-- A weekly newsletter had no weekday and no time: `nextRunAt` was stamped as
-- "now + 7 days" when a send finished, so the slot was inherited from whenever
-- someone first pressed Send and drifted later every week. These columns let
-- the schedule be stated instead of inherited.
--
-- `sendWeekday` stays NULL for existing rows on purpose: that preserves their
-- current cadence until an operator picks a day, rather than silently moving
-- every live newsletter to a new one.
ALTER TABLE "media_server_newsletters"
  ADD COLUMN "sendWeekday" INTEGER,
  ADD COLUMN "sendHour"    INTEGER NOT NULL DEFAULT 9,
  ADD COLUMN "sendMinute"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "timezone"    TEXT    NOT NULL DEFAULT 'UTC';
