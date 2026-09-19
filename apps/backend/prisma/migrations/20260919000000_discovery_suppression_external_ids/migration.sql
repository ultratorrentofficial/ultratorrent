-- A suppression is an identity, not a string.
--
-- `dedupeKey` holds whichever id was STRONGEST when the title was removed, and a
-- later sync is not obliged to report that id again. Observed live: a series
-- suppressed as `imdb:tt33539520` returned nine days later reported by TMDB
-- alone, keyed `tmdb:tv:273207`. It matched neither the stored key nor any
-- alternate — a record that never saw the IMDb id cannot list it as one — so it
-- was re-created as a brand-new discovery while its whole first season sat on
-- disk.
--
-- Existing rows default to '{}'. Their ids are not recoverable, because
-- suppression deletes the row they came from, and the stored key still matches
-- on its own — so an empty object is the truthful value rather than a guessed
-- one.
ALTER TABLE "discovery_suppressions"
  ADD COLUMN "externalIds" JSONB NOT NULL DEFAULT '{}';
