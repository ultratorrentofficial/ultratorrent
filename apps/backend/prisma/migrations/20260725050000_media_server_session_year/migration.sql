-- Release year of the playing item, so a notification can disambiguate a title
-- ("Dune (2021)"). Nullable: providers do not always report it, and an episode
-- is identified by its season and number rather than the year it aired.
ALTER TABLE "media_server_sessions" ADD COLUMN "year" INTEGER;
