-- Year, so an episode pushed to Trakt by show title + season/number can carry a
-- year and disambiguate same-titled shows (the "The Librarians" collision).
ALTER TABLE "media_user_watches" ADD COLUMN "year" INTEGER;
