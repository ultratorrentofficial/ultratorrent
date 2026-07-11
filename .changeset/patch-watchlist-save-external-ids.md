---
"ultratorrent": patch
---

Watchlist: editing an item and saving an IMDb id had no effect — the edit dialog sent it and the API accepted it, but the update never wrote `externalIds` to the database, so the id was silently dropped and the show stayed unmonitorable for missing-episode scans. The update now persists it, merging the submitted ids over the stored ones so an imdb-only edit can't wipe a `tvdb`/`tmdb` id the form never showed; clearing the field clears just that provider.
