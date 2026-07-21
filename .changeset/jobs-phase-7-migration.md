---
'@ultratorrent/backend': minor
'@ultratorrent/frontend': patch
---

Unified Jobs Center Phase 7 — producer migration (adapters). MediaProcessingQueueService
and SubtitleQueueService are now thin adapters over PlatformJobService: real media/subtitle
work populates platform_jobs and appears in the Jobs Center, with zero producer changes and
no behavioural change (full backend suite green). Their public API and exported types are
preserved, and the legacy media_manager.job.*/subtitle_intelligence.job.* WS events still
fire (existing progress UIs untouched). The /api/jobs aggregator now reads platform_jobs for
media & subtitle; the dead `rename` subsystem was dropped.
