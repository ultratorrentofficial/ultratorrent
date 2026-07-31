---
"ultratorrent": patch
---

The torrent completion event now carries the save path and engine id. Media Intake subscribes to that edge and cannot act on a completion it cannot locate on disk, so with a payload of only name, hash and size its trigger reached 'completed with no path in the event; cannot stage it' for every torrent and returned. The pipeline was unreachable from the only edge that feeds it, which is why it had never imported anything on any install. The fields are additive; notification consumers still read torrentName.
