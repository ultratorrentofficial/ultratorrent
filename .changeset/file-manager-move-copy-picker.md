---
'@ultratorrent/frontend': minor
---

File Manager: pick the Move/Copy destination by browsing, instead of typing a path

The Move and Copy dialogs asked the user to type a destination path into a free-text
box, with `/movies` as the only hint about what a valid value even looked like. They now
use the same `DirectoryPicker` the rest of the app already uses for save paths and library
roots: the destination field is read-only and a **Browse** button opens the root-confined
folder tree.

Two supporting fixes fell out of this:

- **`DirectoryPicker` gained a `valueMode` prop.** It has always emitted an *absolute*
  path, but the file API's `destination` is *root-relative* — the backend re-bases a
  leading slash onto the root, so feeding it an absolute path would resolve
  `/downloads` + `/downloads/movies` → `/downloads/downloads/movies` and fail. Move/Copy
  pass `valueMode="relative"`; every existing caller keeps the absolute default.

- **Escape now closes only the topmost dialog.** Every `Dialog` listens for Escape on
  `window`, so a picker opened from inside a form dialog closed *both* on a single
  keypress — discarding the form. This already affected the Add Torrent dialog and the
  RSS rule editor, not just Move/Copy.
