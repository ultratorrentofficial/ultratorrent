-- Recover the info-hash for history rows that were recorded without one.
--
-- `hashAlreadyDownloaded` is the guard that stops the same release being grabbed
-- twice, and it matches `WHERE "infoHash" = <value>`. A NULL is invisible to it,
-- so every row missing a hash is a title that can be re-downloaded — silently,
-- because nothing reports a duplicate that was never detected.
--
-- The hash was rarely absent, only unread: plenty of feeds publish no magnet but
-- put the info-hash in the .torrent URL (YTS links are literally
-- `/torrent/download/<40 hex>`), and the extractor only looked at magnets.
-- Measured on a live install: 96 of 351 downloaded rows had no hash, and one of
-- them re-downloaded 18 days later.
--
-- Fixing the extractor only helps rows recorded from now on. This recovers the
-- ones already written, from the link they still carry.
--
-- Deliberately narrow: exactly 40 hex characters, bounded by a non-hex character
-- or the end of the string. That is what a v1 info-hash is, and demanding the
-- full length keeps it from matching an id or a tracking parameter that happens
-- to be hexadecimal. A row whose link holds no such token keeps its NULL rather
-- than being given a guess.

UPDATE "rss_history"
SET "infoHash" = lower(substring(link from '(?:^|[^a-fA-F0-9])([a-fA-F0-9]{40})(?:[^a-fA-F0-9]|$)'))
WHERE "infoHash" IS NULL
  AND link IS NOT NULL
  AND link ~ '(?:^|[^a-fA-F0-9])[a-fA-F0-9]{40}(?:[^a-fA-F0-9]|$)';
