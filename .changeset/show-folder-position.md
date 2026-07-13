---
'@ultratorrent/backend': patch
---

fix(media): a release subfolder is no longer mistaken for a show of its own

`reconcileShows` derived a show's folder with `showFolderRoot()`, which climbs only
one level past a `Season NN` container. For the very common real layout

    TV Shows/Billions (2016)/Billions.S07E02.WEB.x264-TGx/Billions.S07E02.mkv

it stopped at the torrent's own release folder and recorded *that* as a show.

Run against a real 707-folder library it produced **15 bogus duplicate-show families**
— each pairing a show with a subdirectory of itself (`Billions (2016)` vs
`Billions (2016)/Billions.S07E02.WEB-TGx`) — and, worse, would have let a monitored
show bind its download path to a single torrent's folder.

A show folder is defined by its **position**: the direct child of the library root.
Everything below it — season containers, release/torrent dirs, `Extras`,
complete-season packs — is *inside* a show, however it is named. New `showFolderOf()`
replaces the climb, and every file beneath a show folder now counts toward it.

Of the 18 families the old logic reported on that library, only 3 were real.
