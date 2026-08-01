-- Split "how does this library place a file" from "may it be organised automatically".
--
-- `mode` carried both. Five of its six values are real filesystem verbs; the
-- sixth, `preview`, meant "do nothing" — an opt-out wearing a verb's clothes.
-- Because a library stored exactly one mode, choosing `preview` to keep the
-- background organiser away ALSO vetoed a manual, explicitly-confirmed rename
-- (apply returned "0 applied, N skipped" and reported success), and made the
-- preview compute destinations under re-rooting resolution rather than the
-- in-place resolution an execute would really use.
--
-- ORDER MATTERS. `autoOrganize` is seeded from the CURRENT mode first, so a
-- `preview` library stays opted out; only then is its mode converted to a real
-- verb. Reversing these two statements would silently enrol every preview
-- library into automatic organisation.

ALTER TABLE "media_libraries"
  ADD COLUMN "autoOrganize" BOOLEAN NOT NULL DEFAULT false;

-- Preserve today's behaviour exactly. Eligibility was
-- `ORGANIZE_MODES.includes(mode)` with ORGANIZE_MODES = [rename_in_place,
-- rename_move] — so copy/hardlink/symlink libraries were ALREADY excluded, not
-- just preview ones. Seeding on `mode <> 'preview'` would have started
-- organising three kinds of library that have never been organised.
UPDATE "media_libraries"
   SET "autoOrganize" = true
 WHERE "mode" IN ('rename_in_place', 'rename_move');

-- Now give the opted-out libraries a real verb. `rename_in_place` is the
-- conservative one: it keeps a file inside the show folder it already lives in
-- and only corrects the season subfolder and filename, so a wrong title or year
-- cannot fork a show. Every other verb resolves the full templated path.
UPDATE "media_libraries"
   SET "mode" = 'rename_in_place'
 WHERE "mode" = 'preview';
