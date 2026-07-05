---
"ultratorrent": minor
---

Smart Download execution engine (Phase 1): acquisition decisions now actually download — a new SmartDownloadExecutorService turns a download/upgrade decision into a real torrent add (and removes the superseded torrent on an upgrade), wired into evaluate/approve/override; closes the gap where a 'download' decision recorded a pending action that nothing executed
