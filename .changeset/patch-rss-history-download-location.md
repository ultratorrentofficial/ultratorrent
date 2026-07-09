---
"ultratorrent": patch
---

RSS feed history: downloading an item now prompts for the save location. The "Download" action on a history row opened the grab straight into the engine's default directory with no way to choose where it lands. It now opens a dialog with a directory `PathPicker` (remembered across grabs in the session); the chosen path is passed through `POST /rss/history/:id/download` → `downloadHistoryItem(savePath)` → `addToEngine(link, savePath)`. Leaving it blank keeps the previous behaviour (engine default). en-US + es-PR i18n.
