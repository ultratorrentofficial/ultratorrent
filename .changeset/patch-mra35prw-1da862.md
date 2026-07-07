---
"ultratorrent": patch
---

TV renames use unpadded season folders ('Season 8', not 'Season 08') and fetch metadata before renaming, feeding the identified series title into the rename so a bare filename (e.g. S01E01.mkv) resolves its show, episode title, and year instead of landing under 'Unknown'.
