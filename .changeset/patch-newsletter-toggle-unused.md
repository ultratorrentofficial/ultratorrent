---
"ultratorrent": patch
---

Fix frontend production build (tsc noUnusedLocals) broken by the newsletter content-type toggle: the ContentTypeToggle chip computed an `active` flag but styled off `value.includes(key)` inline, leaving `active` unused. The highlight now uses `active` (so an unscoped newsletter shows every type as on, dimmed), which is also the correct behavior. No functional change beyond the empty-selection visual.
