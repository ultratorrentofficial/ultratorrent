---
"ultratorrent": patch
---

Missing-episode auto-download sweep: a wanted episode that gets deleted mid-sweep (which happens when a library/watchlist scan runs at the same time) no longer aborts the entire sweep pass. Previously one vanished row threw a "record not found" error that stopped the whole batch, silently skipping the rest of that run's episodes; now it's skipped gracefully and the sweep continues.
