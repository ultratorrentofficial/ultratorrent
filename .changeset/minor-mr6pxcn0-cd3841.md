---
"ultratorrent": minor
---

When the IMDb dataset feature is enabled, a scheduled job now downloads the official IMDb dataset files and imports them automatically. New IMDb settings — autoDownloadEnabled, datasetBaseUrl (defaults to the official https://datasets.imdbws.com/, operator-configurable), and autoUpdateIntervalHours (default 168 = weekly). An hourly ImdbDatasetScheduler tick runs the download+import at most once per interval when mode is dataset/hybrid and a dataset path is set. ImdbDatasetImporterService.downloadDataset streams the seven .tsv.gz files to disk (temp .part + atomic rename) inside the hard roots, emitting imdb.dataset.download.* WS events. New POST /api/media/providers/imdb/dataset/update-now triggers a manual download+import. The IMDb settings page replaces the unused cron field with auto-download controls (toggle, base URL, interval, Update now) with live download+import progress.
