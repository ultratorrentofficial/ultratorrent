---
'@ultratorrent/backend': patch
---

fix(media): one post-download library workflow at a time, not one per torrent

The post-download workflow scans the **whole** library, and it is now fired detached
from the torrent sync tick rather than awaited. Detaching removed the accidental
serialisation the `await` had been providing, and nothing else bounded it.

So a *backlog* of completions all fired at once. After a sync outage left ~166
completions unrecorded, the first healthy tick detected every one of them as a rising
edge and launched **166 concurrent full library scans** — which is what pinned a NAS at
load average 15.

A library now runs at most one post-download workflow at a time. Further completions
for that library are skipped while it is in flight, which loses nothing: a scan already
under way will see every file that landed before it walks the tree.
