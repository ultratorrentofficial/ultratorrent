---
"ultratorrent": patch
---

fix(media-acquisition): the profile size field now shows the real size as you type

The 'Max release size' field is in GB, and the number that comes naturally to mind is
1024 — which silently stored 1.02 TB, i.e. no cap at all. That happened on a live host:
an operator typed 1024 meaning 1 GB and left the 1080p profile effectively uncapped,
with no feedback but a byte count nobody reads.

The field now echoes the value back as a real size ('= 1.07 GB'), and warns when it
exceeds 50 GB — far larger than any single episode, so at that point it is a units slip
rather than an intent.
