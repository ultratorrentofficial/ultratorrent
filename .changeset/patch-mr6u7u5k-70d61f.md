---
"ultratorrent": patch
---

Fix: the IMDb dataset auto-download no longer requires a dataset path to be configured first. The path is a download destination, not a pre-existing source, so when none is set the download+import now falls back to a managed default (<storage-root>/.ultratorrent/imdb-datasets), creates it, and persists it. 'Update now' works out of the box and the scheduler no longer skips when no path is configured.
