-- `timezone` defaulted to 'UTC', which made "no choice" indistinguishable from
-- "chose UTC". The containers run UTC while the hosts do not, so a newsletter
-- set to 12:00 was scheduled for 08:00 local and looked correct.
--
-- NULL now means "use the app-wide default" (`app.timezone`, the operator's own
-- zone). Rows that still say 'UTC' are left as they are: this cannot tell an
-- operator who genuinely wanted UTC from one who never chose, and moving
-- someone's live schedule by four hours on a guess is the worse error.
ALTER TABLE "media_server_newsletters"
  ALTER COLUMN "timezone" DROP NOT NULL,
  ALTER COLUMN "timezone" DROP DEFAULT;
