---
id: database-schema
title: Esquema de la base de datos
sidebar_position: 5
description: Cada modelo de Prisma, sus columnas y relaciones, como diagramas entidad-relación.
keywords: [database, schema, prisma, postgres, models, er diagram, migrations]
---

# Esquema de la base de datos

:::info Generado automáticamente
Esta página se genera desde `apps/backend/prisma/schema.prisma` durante el build. **No la edites a mano** — cambia la fuente y reconstruye. Esto garantiza que la referencia siempre coincida con el código que se publica.
:::

UltraTorrent guarda todo en **PostgreSQL**, gestionado por **Prisma**. Hay
**110 modelos**. Un solo diagrama ER de todos sería ilegible, así que están
agrupados por dominio más abajo.

:::tip Nunca edites la base de datos a mano
Los cambios de esquema pasan por una migración de Prisma para que cada instalación converja
en la misma forma. Ver [Base de datos y Prisma](/develop/database).
:::

## Automatización

_2 modelos._

```mermaid
erDiagram
  AutomationRule ||--o{ AutomationLog : "logs"
  AutomationLog }o--|| AutomationRule : "rule"
```

### `AutomationRule`

Tabla: `automation_rules`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `name` | `String` |
| `description` | `String?` |
| `trigger` | `String` |
| `conditions` | `Json` |
| `actions` | `Json` |
| `isEnabled` | `Boolean` |
| `priority` | `Int` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `AutomationLog`

Tabla: `automation_logs`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `ruleId` | `String` |
| `status` | `String` |
| `context` | `Json` |
| `message` | `String?` |
| `createdAt` | `DateTime` |

## Catálogo de IMDb

_8 modelos._

```mermaid
erDiagram
```

### `IMDbTitle`

Tabla: `imdb_titles`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `tconst` | `String` |
| `titleType` | `String` |
| `primaryTitle` | `String` |
| `originalTitle` | `String` |
| `isAdult` | `Boolean` |
| `startYear` | `Int?` |
| `endYear` | `Int?` |
| `runtimeMinutes` | `Int?` |
| `genres` | `String[]` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `IMDbAka`

Tabla: `imdb_akas`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `titleId` | `String` |
| `title` | `String` |
| `region` | `String?` |
| `language` | `String?` |
| `types` | `String?` |
| `attributes` | `String?` |
| `ordering` | `Int?` |
| `isOriginalTitle` | `Boolean` |

### `IMDbCrew`

Tabla: `imdb_crew`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `titleId` | `String` |
| `directors` | `String[]` |
| `writers` | `String[]` |

### `IMDbEpisode`

Tabla: `imdb_episodes`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `episodeTitleId` | `String` |
| `parentTitleId` | `String` |
| `seasonNumber` | `Int?` |
| `episodeNumber` | `Int?` |

### `IMDbPrincipal`

Tabla: `imdb_principals`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `titleId` | `String` |
| `ordering` | `Int` |
| `personId` | `String` |
| `category` | `String?` |
| `job` | `String?` |
| `characters` | `String?` |

### `IMDbPerson`

Tabla: `imdb_persons`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `nconst` | `String` |
| `primaryName` | `String` |
| `birthYear` | `Int?` |
| `deathYear` | `Int?` |
| `primaryProfession` | `String[]` |
| `knownForTitles` | `String[]` |

### `IMDbRating`

Tabla: `imdb_ratings`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `titleId` | `String` |
| `averageRating` | `Float` |
| `numVotes` | `Int` |

### `IMDbDatasetImport`

Tabla: `imdb_dataset_imports`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `status` | `String` |
| `sourcePath` | `String` |
| `startedAt` | `DateTime?` |
| `completedAt` | `DateTime?` |
| `failedAt` | `DateTime?` |
| `errorMessage` | `String?` |
| `filesImported` | `Json` |
| `recordsImported` | `Int` |
| `stats` | `Json?` |
| `strategy` | `String?` |
| `datasetDate` | `DateTime?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

## Identidad y auditoría

_6 modelos._

```mermaid
erDiagram
  User ||--o{ UserRole : "roles"
  User ||--o{ ApiKey : "apiKeys"
  User ||--o{ AuditLog : "auditLogs"
  Role ||--o{ UserRole : "users"
  Role ||--o{ RolePermission : "permissions"
  UserRole }o--|| User : "user"
  UserRole }o--|| Role : "role"
  RolePermission }o--|| Role : "role"
  ApiKey }o--|| User : "user"
  AuditLog }o--|| User : "user"
```

### `User`

Tabla: `users`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `username` | `String` |
| `email` | `String` |
| `displayName` | `String?` |
| `passwordHash` | `String` |
| `isActive` | `Boolean` |
| `isSystem` | `Boolean` |
| `lastLoginAt` | `DateTime?` |
| `failedLoginAttempts` | `Int` |
| `lockedUntil` | `DateTime?` |
| `totpSecret` | `String?` |
| `totpEnabled` | `Boolean` |
| `recoveryCodes` | `String[]` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `Role`

Tabla: `roles`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `name` | `String` |
| `description` | `String?` |
| `isSystem` | `Boolean` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `UserRole`

Tabla: `user_roles`

| Column | Type |
| --- | --- |
| `userId` | `String` |
| `roleId` | `String` |

### `RolePermission`

Tabla: `role_permissions`

| Column | Type |
| --- | --- |
| `roleId` | `String` |
| `permissionId` | `String` |

### `ApiKey`

Tabla: `api_keys`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `userId` | `String` |
| `name` | `String` |
| `prefix` | `String` |
| `keyHash` | `String` |
| `scopes` | `String[]` |
| `lastUsedAt` | `DateTime?` |
| `expiresAt` | `DateTime?` |
| `revokedAt` | `DateTime?` |
| `createdAt` | `DateTime` |

### `AuditLog`

Tabla: `audit_logs`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `userId` | `String?` |
| `action` | `String` |
| `objectType` | `String?` |
| `objectId` | `String?` |
| `result` | `String` |
| `ipAddress` | `String?` |
| `userAgent` | `String?` |
| `metadata` | `Json?` |
| `createdAt` | `DateTime` |

## Indexadores

_1 modelo._

```mermaid
erDiagram
```

### `Indexer`

Tabla: `indexers`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `name` | `String` |
| `implementation` | `String` |
| `protocol` | `String` |
| `baseUrl` | `String` |
| `config` | `Json` |
| `enabled` | `Boolean` |
| `priority` | `Int` |
| `categories` | `Int[]` |
| `capabilities` | `Json?` |
| `minSeeders` | `Int?` |
| `timeoutMs` | `Int` |
| `status` | `String` |
| `statusMessage` | `String?` |
| `lastTestedAt` | `DateTime?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

## Gestor de Medios

_35 modelos._

```mermaid
erDiagram
  MediaLibrary ||--o{ MediaItem : "items"
  MediaLibrary ||--o{ MediaShow : "shows"
  MediaShow }o--|| MediaLibrary : "library"
  MediaItem }o--|| MediaLibrary : "library"
  MediaItem ||--o{ MediaFile : "files"
  MediaItem }o--|| MediaMetadata : "metadata"
  MediaItem ||--o{ MediaArtwork : "artwork"
  MediaItem ||--o{ MediaSubtitle : "subtitles"
  MediaItem ||--o{ MediaExternalId : "externalIds"
  MediaItem ||--o{ MediaNfoFile : "nfoFiles"
  MediaItem ||--o{ MediaCollectionItem : "collections"
  MediaItem }o--|| MediaDuplicateGroup : "duplicateGroup"
  MediaItem ||--o{ MediaDuplicateCandidate : "duplicateCandidates"
  MediaItem }o--|| MediaPlaybackAggregate : "playbackAggregate"
  MediaFile }o--|| MediaItem : "item"
  MediaMetadata }o--|| MediaItem : "item"
  MediaArtwork }o--|| MediaItem : "item"
  MediaSubtitle }o--|| MediaItem : "item"
  MediaExternalId }o--|| MediaItem : "item"
  MediaCollection ||--o{ MediaCollectionItem : "items"
  MediaCollectionItem }o--|| MediaCollection : "collection"
  MediaCollectionItem }o--|| MediaItem : "item"
  MediaDuplicateGroup ||--o{ MediaItem : "items"
  MediaDuplicateGroup ||--o{ MediaDuplicateCandidate : "candidates"
  MediaDuplicateGroup ||--o{ MediaDuplicateResolution : "resolutions"
  MediaDuplicateCandidate }o--|| MediaDuplicateGroup : "group"
  MediaDuplicateCandidate }o--|| MediaItem : "item"
  MediaDuplicateResolution }o--|| MediaDuplicateGroup : "group"
  MediaDuplicateResolution ||--o{ MediaDuplicateResolutionAction : "actions"
  MediaDuplicateResolutionAction }o--|| MediaDuplicateResolution : "resolution"
  MediaAnalyticsImportSource ||--o{ MediaAnalyticsImportJob : "jobs"
  MediaAnalyticsImportJob }o--|| MediaAnalyticsImportSource : "source"
  MediaNfoFile }o--|| MediaItem : "item"
  MediaRenameJob ||--o{ MediaRenameFile : "files"
  MediaRenameFile }o--|| MediaRenameJob : "job"
  MediaCleanupPolicy ||--o{ MediaCleanupPolicyVersion : "versions"
  MediaCleanupPolicy ||--o{ MediaCleanupRun : "runs"
  MediaCleanupPolicyVersion }o--|| MediaCleanupPolicy : "policy"
  MediaCleanupPolicyVersion ||--o{ MediaCleanupRun : "runs"
  MediaCleanupRun }o--|| MediaCleanupPolicy : "policy"
  MediaCleanupRun }o--|| MediaCleanupPolicyVersion : "version"
  MediaCleanupRun ||--o{ MediaCleanupCandidate : "candidates"
  MediaCleanupRun ||--o{ MediaCleanupPlan : "plans"
  MediaCleanupCandidate }o--|| MediaCleanupRun : "run"
  MediaCleanupPlan }o--|| MediaCleanupRun : "run"
  MediaCleanupPlan ||--o{ MediaCleanupAction : "actions"
  MediaCleanupAction }o--|| MediaCleanupPlan : "plan"
  MediaPlaybackAggregate }o--|| MediaItem : "item"
```

### `MediaUserWatch`

Tabla: `media_user_watches`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `userId` | `String` |
| `key` | `String` |
| `mediaType` | `String` |
| `imdbId` | `String?` |
| `tmdbId` | `String?` |
| `tvdbId` | `String?` |
| `showTitle` | `String?` |
| `title` | `String?` |
| `year` | `Int?` |
| `season` | `Int?` |
| `episode` | `Int?` |
| `watchedAt` | `DateTime` |
| `source` | `String` |
| `syncedAt` | `DateTime?` |
| `createdAt` | `DateTime` |

### `MediaUserRating`

Tabla: `media_user_ratings`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `userId` | `String` |
| `key` | `String` |
| `mediaType` | `String` |
| `imdbId` | `String?` |
| `tmdbId` | `String?` |
| `tvdbId` | `String?` |
| `showTitle` | `String?` |
| `title` | `String?` |
| `season` | `Int?` |
| `episode` | `Int?` |
| `rating` | `Int` |
| `ratedAt` | `DateTime` |
| `source` | `String` |
| `syncedAt` | `DateTime?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaLibrary`

Tabla: `media_libraries`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `name` | `String` |
| `kind` | `String` |
| `path` | `String` |
| `preset` | `String` |
| `template` | `String?` |
| `mode` | `String` |
| `isEnabled` | `Boolean` |
| `scanIntervalMinutes` | `Int?` |
| `lastScanAt` | `DateTime?` |
| `nfoEnabled` | `Boolean` |
| `artworkEnabled` | `Boolean` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaShow`

Tabla: `media_shows`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `libraryId` | `String` |
| `mediaType` | `String` |
| `title` | `String` |
| `year` | `Int?` |
| `path` | `String` |
| `imdbId` | `String?` |
| `canonicalKey` | `String` |
| `episodeCount` | `Int` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaItem`

Tabla: `media_items`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `libraryId` | `String` |
| `mediaType` | `String` |
| `title` | `String` |
| `sortTitle` | `String?` |
| `year` | `Int?` |
| `season` | `Int?` |
| `episode` | `Int?` |
| `episodeEnd` | `Int?` |
| `matchStatus` | `String` |
| `confidence` | `Float` |
| `locked` | `Boolean` |
| `path` | `String` |
| `duplicateGroupId` | `String?` |
| `seriesImdbId` | `String?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaFile`

Tabla: `media_files`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `itemId` | `String` |
| `path` | `String` |
| `size` | `BigInt` |
| `container` | `String?` |
| `videoCodec` | `String?` |
| `audioCodec` | `String?` |
| `resolution` | `String?` |
| `hdr` | `String?` |
| `language` | `String?` |
| `releaseGroup` | `String?` |
| `quality` | `String?` |
| `width` | `Int?` |
| `height` | `Int?` |
| `bitrateKbps` | `Int?` |
| `durationSec` | `Int?` |
| `audioChannels` | `Int?` |
| `frameRate` | `Float?` |
| `videoBitDepth` | `Int?` |
| `chromaSubsampling` | `String?` |
| `colorPrimaries` | `String?` |
| `colorTransfer` | `String?` |
| `colorSpace` | `String?` |
| `hdrFormat` | `String?` |
| `techSource` | `String?` |
| `probedAt` | `DateTime?` |
| `probeError` | `String?` |
| `probeAttempts` | `Int` |
| `createdAt` | `DateTime` |

### `MediaMetadata`

Tabla: `media_metadata`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `itemId` | `String` |
| `title` | `String?` |
| `originalTitle` | `String?` |
| `sortTitle` | `String?` |
| `overview` | `String?` |
| `releaseDate` | `DateTime?` |
| `year` | `Int?` |
| `runtime` | `Int?` |
| `genres` | `Json` |
| `studios` | `Json` |
| `cast` | `Json` |
| `crew` | `Json` |
| `directors` | `Json` |
| `writers` | `Json` |
| `rating` | `Float?` |
| `certification` | `String?` |
| `tags` | `Json` |
| `providerName` | `String?` |
| `fieldSources` | `Json?` |
| `updatedAt` | `DateTime` |

### `MediaArtwork`

Tabla: `media_artwork`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `itemId` | `String` |
| `type` | `String` |
| `url` | `String?` |
| `localPath` | `String?` |
| `source` | `String?` |
| `selected` | `Boolean` |
| `width` | `Int?` |
| `height` | `Int?` |
| `seasonNumber` | `Int?` |
| `createdAt` | `DateTime` |

### `MediaSubtitle`

Tabla: `media_subtitles`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `itemId` | `String` |
| `path` | `String` |
| `language` | `String` |
| `forced` | `Boolean` |
| `sdh` | `Boolean` |
| `source` | `String?` |
| `createdAt` | `DateTime` |

### `MediaExternalId`

Tabla: `media_external_ids`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `itemId` | `String` |
| `provider` | `String` |
| `externalId` | `String` |
| `url` | `String?` |

### `MediaCollection`

Tabla: `media_collections`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `name` | `String` |
| `overview` | `String?` |
| `artworkPath` | `String?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaCollectionItem`

Tabla: `media_collection_items`

| Column | Type |
| --- | --- |
| `collectionId` | `String` |
| `itemId` | `String` |

### `MediaRenameTemplate`

Tabla: `media_rename_templates`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `name` | `String` |
| `mediaType` | `String` |
| `template` | `String` |
| `isDefault` | `Boolean` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaProcessingJob`

Tabla: `media_processing_jobs`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `type` | `String` |
| `status` | `String` |
| `libraryId` | `String?` |
| `itemId` | `String?` |
| `payload` | `Json` |
| `result` | `Json?` |
| `error` | `String?` |
| `progress` | `Int` |
| `startedAt` | `DateTime?` |
| `finishedAt` | `DateTime?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaDuplicateGroup`

Tabla: `media_duplicate_groups`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `groupKey` | `String` |
| `groupType` | `String` |
| `reason` | `String` |
| `status` | `String` |
| `confidence` | `Int` |
| `requiresReview` | `Boolean` |
| `potentialSavingsBytes` | `BigInt` |
| `recommendedItemId` | `String?` |
| `recommendation` | `Json?` |
| `warnings` | `Json?` |
| `version` | `Int` |
| `ignoredReason` | `String?` |
| `ignoredById` | `String?` |
| `ignoredAt` | `DateTime?` |
| `resolvedById` | `String?` |
| `resolvedAt` | `DateTime?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaDuplicateScanState`

Tabla: `media_duplicate_scan_state`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `inputDigest` | `String` |
| `updatedAt` | `DateTime` |
| `createdAt` | `DateTime` |

### `MediaDuplicateCandidate`

Tabla: `media_duplicate_candidates`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `groupId` | `String` |
| `itemId` | `String` |
| `path` | `String` |
| `fileSize` | `BigInt` |
| `hash` | `String?` |
| `qualityScore` | `Int` |
| `recommendationRank` | `Int` |
| `recommendationReasons` | `Json?` |
| `selectedAction` | `String` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaDuplicateResolution`

Tabla: `media_duplicate_resolutions`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `scope` | `String` |
| `groupId` | `String?` |
| `status` | `String` |
| `keepItemId` | `String?` |
| `canonicalShowId` | `String?` |
| `inputFingerprint` | `String?` |
| `preview` | `Json?` |
| `groupVersion` | `Int` |
| `expectedSavingsBytes` | `BigInt` |
| `actualSavingsBytes` | `BigInt` |
| `errorSummary` | `String?` |
| `createdById` | `String?` |
| `startedAt` | `DateTime?` |
| `completedAt` | `DateTime?` |
| `failedAt` | `DateTime?` |
| `createdAt` | `DateTime` |

### `MediaDuplicateResolutionAction`

Tabla: `media_duplicate_resolution_actions`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `resolutionId` | `String` |
| `actionType` | `String` |
| `status` | `String` |
| `sourcePath` | `String?` |
| `destinationPath` | `String?` |
| `errorMessage` | `String?` |
| `metadata` | `Json?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaAnalyticsImportSource`

Tabla: `media_analytics_import_sources`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `name` | `String` |
| `type` | `String` |
| `baseUrl` | `String` |
| `encryptedApiKey` | `String?` |
| `enabled` | `Boolean` |
| `syncEnabled` | `Boolean` |
| `lastConnectionTestAt` | `DateTime?` |
| `lastImportAt` | `DateTime?` |
| `lastIncrementalSyncAt` | `DateTime?` |
| `importCursor` | `Json?` |
| `sourceVersion` | `String?` |
| `status` | `String?` |
| `notes` | `String?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaAnalyticsImportJob`

Tabla: `media_analytics_import_jobs`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `sourceId` | `String` |
| `status` | `String` |
| `mode` | `String` |
| `selectedSections` | `Json?` |
| `progress` | `Int` |
| `totalRecords` | `Int` |
| `processedRecords` | `Int` |
| `importedRecords` | `Int` |
| `skippedRecords` | `Int` |
| `failedRecords` | `Int` |
| `warnings` | `Json?` |
| `errors` | `Json?` |
| `startedAt` | `DateTime?` |
| `completedAt` | `DateTime?` |
| `createdById` | `String?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaNfoFile`

Tabla: `media_nfo_files`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `itemId` | `String` |
| `type` | `String` |
| `path` | `String` |
| `generatedAt` | `DateTime` |

### `MediaRenameOperation`

Tabla: `media_rename_operations`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `source` | `String` |
| `destination` | `String?` |
| `action` | `String` |
| `kind` | `String` |
| `mode` | `String` |
| `status` | `String` |
| `message` | `String?` |
| `torrentHash` | `String?` |
| `createdAt` | `DateTime` |

### `MediaRenameJob`

Tabla: `media_rename_jobs`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `torrentHash` | `String?` |
| `engineId` | `String?` |
| `status` | `String` |
| `mode` | `String` |
| `sourcePath` | `String` |
| `destinationPath` | `String?` |
| `mediaType` | `String?` |
| `parsedMetadata` | `Json?` |
| `providerMetadata` | `Json?` |
| `confidenceScore` | `Int?` |
| `dryRunResult` | `Json?` |
| `executedBy` | `String?` |
| `createdAt` | `DateTime` |
| `completedAt` | `DateTime?` |

### `MediaRenameFile`

Tabla: `media_rename_files`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `jobId` | `String` |
| `originalPath` | `String` |
| `proposedPath` | `String?` |
| `finalPath` | `String?` |
| `fileType` | `String?` |
| `action` | `String` |
| `status` | `String` |
| `errorMessage` | `String?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaNamingTemplate`

Tabla: `media_naming_templates`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `name` | `String` |
| `mediaType` | `String` |
| `serverPreset` | `String` |
| `template` | `String` |
| `enabled` | `Boolean` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaCleanupPolicy`

Tabla: `media_cleanup_policies`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `name` | `String` |
| `description` | `String?` |
| `status` | `String` |
| `enabled` | `Boolean` |
| `mode` | `String` |
| `scheduleCron` | `String?` |
| `freeSpaceTriggerPercent` | `Int?` |
| `currentDraftVersionId` | `String?` |
| `publishedVersionId` | `String?` |
| `createdById` | `String?` |
| `updatedById` | `String?` |
| `lastRunAt` | `DateTime?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |
| `archivedAt` | `DateTime?` |

### `MediaCleanupPolicyVersion`

Tabla: `media_cleanup_policy_versions`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `policyId` | `String` |
| `versionNumber` | `Int` |
| `status` | `String` |
| `document` | `Json` |
| `checksum` | `String` |
| `requiredPermissions` | `String[]` |
| `factKeys` | `String[]` |
| `changeNotes` | `String?` |
| `createdById` | `String?` |
| `createdAt` | `DateTime` |
| `publishedAt` | `DateTime?` |
| `archivedAt` | `DateTime?` |

### `MediaCleanupRun`

Tabla: `media_cleanup_runs`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `policyId` | `String` |
| `policyVersionId` | `String` |
| `trigger` | `String` |
| `status` | `String` |
| `simulate` | `Boolean` |
| `jobId` | `String?` |
| `inputDigest` | `String?` |
| `filesScanned` | `Int` |
| `itemsEvaluated` | `Int` |
| `candidatesMatched` | `Int` |
| `candidatesExcluded` | `Int` |
| `candidatesEligible` | `Int` |
| `estimatedReclaimBytes` | `BigInt` |
| `actualReclaimBytes` | `BigInt` |
| `exclusionBreakdown` | `Json?` |
| `errorSummary` | `String?` |
| `createdById` | `String?` |
| `startedAt` | `DateTime?` |
| `completedAt` | `DateTime?` |
| `failedAt` | `DateTime?` |
| `cancelledAt` | `DateTime?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaCleanupCandidate`

Tabla: `media_cleanup_candidates`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `runId` | `String` |
| `policyVersionId` | `String` |
| `mediaItemId` | `String?` |
| `mediaFileId` | `String?` |
| `mediaLibraryId` | `String?` |
| `path` | `String` |
| `fileSizeBytes` | `BigInt` |
| `status` | `String` |
| `exclusionReason` | `String?` |
| `fingerprint` | `String` |
| `reasonSnapshot` | `Json` |
| `rankScore` | `Float?` |
| `rankReasons` | `Json?` |
| `replacementFileId` | `String?` |
| `replacementReasons` | `Json?` |
| `protectionState` | `Json?` |
| `estimatedReclaimBytes` | `BigInt` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaCleanupPlan`

Tabla: `media_cleanup_plans`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `runId` | `String` |
| `policyVersionId` | `String` |
| `status` | `String` |
| `action` | `String` |
| `retentionDays` | `Int?` |
| `candidateCount` | `Int` |
| `estimatedReclaimBytes` | `BigInt` |
| `actualReclaimBytes` | `BigInt` |
| `executionJobId` | `String?` |
| `createdById` | `String?` |
| `approvedById` | `String?` |
| `approvedAt` | `DateTime?` |
| `rejectedById` | `String?` |
| `rejectedAt` | `DateTime?` |
| `rejectionReason` | `String?` |
| `expiresAt` | `DateTime?` |
| `executedAt` | `DateTime?` |
| `errorSummary` | `String?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaCleanupAction`

Tabla: `media_cleanup_actions`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `planId` | `String` |
| `candidateId` | `String` |
| `mediaItemId` | `String?` |
| `mediaFileId` | `String?` |
| `actionType` | `String` |
| `status` | `String` |
| `sourcePath` | `String` |
| `destinationPath` | `String?` |
| `pinnedFingerprint` | `String` |
| `fileSizeBytes` | `BigInt` |
| `reclaimedBytes` | `BigInt` |
| `skipReason` | `String?` |
| `errorCode` | `String?` |
| `errorMessage` | `String?` |
| `startedAt` | `DateTime?` |
| `completedAt` | `DateTime?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaCleanupProtection`

Tabla: `media_cleanup_protections`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `targetType` | `String` |
| `mediaItemId` | `String?` |
| `mediaFileId` | `String?` |
| `mediaShowId` | `String?` |
| `mediaLibraryId` | `String?` |
| `seasonNumber` | `Int?` |
| `episodeNumber` | `Int?` |
| `externalIdentityKey` | `String?` |
| `pathPrefix` | `String?` |
| `tagValue` | `String?` |
| `collectionId` | `String?` |
| `torrentHash` | `String?` |
| `canonicalPathSnapshot` | `String?` |
| `protectionType` | `String` |
| `conditionKind` | `String?` |
| `conditionConfig` | `Json?` |
| `reason` | `String` |
| `protectedUntil` | `DateTime?` |
| `createdByUserId` | `String` |
| `createdAt` | `DateTime` |
| `revokedAt` | `DateTime?` |
| `revokedByUserId` | `String?` |
| `revokeReason` | `String?` |

### `MediaCleanupQuarantineItem`

Tabla: `media_cleanup_quarantine_items`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `actionId` | `String?` |
| `planId` | `String?` |
| `runId` | `String?` |
| `policyVersionId` | `String?` |
| `mediaItemId` | `String?` |
| `mediaFileId` | `String?` |
| `originalPath` | `String` |
| `quarantinePath` | `String` |
| `storageRoot` | `String` |
| `fileSizeBytes` | `BigInt` |
| `fingerprint` | `String` |
| `status` | `String` |
| `restoreDeadline` | `DateTime?` |
| `quarantinedAt` | `DateTime` |
| `restoredAt` | `DateTime?` |
| `restoredById` | `String?` |
| `purgedAt` | `DateTime?` |
| `purgedById` | `String?` |

### `MediaPlaybackAggregate`

Tabla: `media_playback_aggregates`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `mediaItemId` | `String` |
| `startedPlayCount` | `Int` |
| `completedPlayCount` | `Int` |
| `uniqueViewerCount` | `Int` |
| `lastPlayedAt` | `DateTime?` |
| `maximumProgressPercent` | `Int` |
| `averageProgressPercent` | `Float` |
| `totalPlaybackSeconds` | `BigInt` |
| `completionThresholdPercent` | `Int` |
| `sourceRowCount` | `Int` |
| `resolvedSourceRowCount` | `Int` |
| `computedAt` | `DateTime` |
| `updatedAt` | `DateTime` |

## Adquisición de medios (Smart Download)

_7 modelos._

```mermaid
erDiagram
  MediaAcquisitionEvaluation ||--o{ MediaAcquisitionAction : "actions"
  MediaAcquisitionAction }o--|| MediaAcquisitionEvaluation : "evaluation"
```

### `MediaAcquisitionWatchlistItem`

Tabla: `media_acquisition_watchlist_items`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `type` | `String` |
| `title` | `String` |
| `normalizedTitle` | `String` |
| `titleAliases` | `String[]` |
| `year` | `Int?` |
| `externalIds` | `Json?` |
| `seasonNumber` | `Int?` |
| `episodeNumber` | `Int?` |
| `collectionName` | `String?` |
| `status` | `String` |
| `priority` | `Int` |
| `profileId` | `String?` |
| `rssRuleId` | `String?` |
| `targetLibraryId` | `String?` |
| `libraryShowId` | `String?` |
| `settings` | `Json?` |
| `createdBy` | `String?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `WantedEpisode`

Tabla: `wanted_episodes`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `watchlistItemId` | `String` |
| `seriesTconst` | `String` |
| `episodeTconst` | `String?` |
| `seasonNumber` | `Int` |
| `episodeNumber` | `Int` |
| `episodeTitle` | `String?` |
| `airYear` | `Int?` |
| `status` | `String` |
| `searchStatus` | `String` |
| `lastSearchedAt` | `DateTime?` |
| `grabbedAt` | `DateTime?` |
| `grabbedEvaluationId` | `String?` |
| `downloadUrl` | `String?` |
| `releaseTitle` | `String?` |
| `lastCheckedAt` | `DateTime` |
| `createdAt` | `DateTime` |

### `WantedMovie`

Tabla: `wanted_movies`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `watchlistItemId` | `String` |
| `movieTconst` | `String` |
| `title` | `String` |
| `year` | `Int?` |
| `status` | `String` |
| `searchStatus` | `String` |
| `lastSearchedAt` | `DateTime?` |
| `grabbedAt` | `DateTime?` |
| `grabbedEvaluationId` | `String?` |
| `downloadUrl` | `String?` |
| `releaseTitle` | `String?` |
| `lastCheckedAt` | `DateTime` |
| `createdAt` | `DateTime` |

### `MediaAcquisitionProfile`

Tabla: `media_acquisition_profiles`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `name` | `String` |
| `description` | `String?` |
| `mediaType` | `String` |
| `minimumScore` | `Int` |
| `approvalScore` | `Int` |
| `minimumResolution` | `String?` |
| `preferredResolution` | `String?` |
| `preferredSource` | `String?` |
| `preferredCodec` | `String?` |
| `preferredAudio` | `String?` |
| `preferredHdr` | `String?` |
| `preferredLanguages` | `Json?` |
| `requiredTerms` | `Json?` |
| `excludedTerms` | `Json?` |
| `preferredGroups` | `Json?` |
| `minSizeBytes` | `BigInt?` |
| `maxSizeBytes` | `BigInt?` |
| `qualityRules` | `Json?` |
| `duplicateRules` | `Json?` |
| `storageRules` | `Json?` |
| `automationRules` | `Json?` |
| `enabled` | `Boolean` |
| `createdBy` | `String?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaAcquisitionEvaluation`

Tabla: `media_acquisition_evaluations`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `sourceType` | `String` |
| `sourceId` | `String?` |
| `releaseName` | `String` |
| `parsedMetadata` | `Json?` |
| `watchlistItemId` | `String?` |
| `profileId` | `String?` |
| `libraryMatch` | `Json?` |
| `releaseScore` | `Json?` |
| `duplicateRisk` | `Json?` |
| `qualityGap` | `Json?` |
| `storageCheck` | `Json?` |
| `serverSelection` | `Json?` |
| `decision` | `String` |
| `decisionReason` | `String?` |
| `priority` | `Int` |
| `confidence` | `Int` |
| `requiresApproval` | `Boolean` |
| `approvalStatus` | `String` |
| `actionTaken` | `String?` |
| `torrentHash` | `String?` |
| `trace` | `Json?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaAcquisitionAction`

Tabla: `media_acquisition_actions`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `evaluationId` | `String` |
| `actionType` | `String` |
| `status` | `String` |
| `payload` | `Json?` |
| `result` | `Json?` |
| `createdBy` | `String?` |
| `createdAt` | `DateTime` |
| `completedAt` | `DateTime?` |
| `errorMessage` | `String?` |

### `MediaAcquisitionHistory`

Tabla: `media_acquisition_history`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `watchlistItemId` | `String?` |
| `evaluationId` | `String?` |
| `eventType` | `String` |
| `message` | `String` |
| `metadata` | `Json?` |
| `createdAt` | `DateTime` |

## Analíticas del servidor de medios

_9 modelos._

```mermaid
erDiagram
  MediaServerNewsletter ||--o{ MediaServerNewsletterDelivery : "deliveries"
  MediaServerNewsletterDelivery }o--|| MediaServerNewsletter : "newsletter"
```

### `MediaServerIntegration`

Tabla: `media_server_integrations`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `name` | `String` |
| `kind` | `String` |
| `config` | `Json` |
| `isEnabled` | `Boolean` |
| `lastRefreshAt` | `DateTime?` |
| `isDefault` | `Boolean` |
| `status` | `String?` |
| `serverVersion` | `String?` |
| `platform` | `String?` |
| `capabilities` | `Json?` |
| `lastHealthCheckAt` | `DateTime?` |
| `notes` | `String?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaServerSession`

Tabla: `media_server_sessions`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `connectionId` | `String` |
| `providerSessionId` | `String` |
| `providerUserId` | `String?` |
| `userName` | `String?` |
| `title` | `String` |
| `showTitle` | `String?` |
| `seasonNumber` | `Int?` |
| `episodeNumber` | `Int?` |
| `year` | `Int?` |
| `externalIds` | `Json?` |
| `mediaType` | `String?` |
| `libraryName` | `String?` |
| `device` | `String?` |
| `client` | `String?` |
| `ipAddress` | `String?` |
| `playbackState` | `String?` |
| `progressPercent` | `Int?` |
| `playbackMethod` | `String?` |
| `videoCodec` | `String?` |
| `audioCodec` | `String?` |
| `resolution` | `String?` |
| `container` | `String?` |
| `bitrateKbps` | `Int?` |
| `artPath` | `String?` |
| `startedAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaServerWatchHistory`

Tabla: `media_server_watch_history`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `connectionId` | `String?` |
| `importSourceId` | `String?` |
| `providerHistoryId` | `String?` |
| `providerUserId` | `String?` |
| `userName` | `String?` |
| `title` | `String` |
| `mediaType` | `String?` |
| `libraryName` | `String?` |
| `device` | `String?` |
| `client` | `String?` |
| `ipAddress` | `String?` |
| `startedAt` | `DateTime` |
| `stoppedAt` | `DateTime?` |
| `watchedSeconds` | `Int?` |
| `percentComplete` | `Int?` |
| `playbackMethod` | `String?` |
| `resolution` | `String?` |
| `videoCodec` | `String?` |
| `audioCodec` | `String?` |
| `container` | `String?` |
| `bitrateKbps` | `Int?` |
| `importSource` | `String?` |
| `importedAt` | `DateTime?` |
| `createdAt` | `DateTime` |

### `MediaServerLibrary`

Tabla: `media_server_libraries`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `connectionId` | `String` |
| `providerLibraryId` | `String` |
| `name` | `String` |
| `type` | `String` |
| `itemCount` | `Int?` |
| `lastSyncedAt` | `DateTime` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaServerUser`

Tabla: `media_server_users`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `connectionId` | `String?` |
| `providerUserId` | `String?` |
| `userName` | `String` |
| `email` | `String?` |
| `plays` | `Int` |
| `lastSeenAt` | `DateTime?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaProviderSyncRun`

Tabla: `media_provider_sync_runs`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `connectionId` | `String?` |
| `type` | `String` |
| `status` | `String` |
| `librariesSynced` | `Int` |
| `usersSynced` | `Int` |
| `message` | `String?` |
| `startedAt` | `DateTime` |
| `finishedAt` | `DateTime?` |

### `MediaServerNewsletter`

Tabla: `media_server_newsletters`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `name` | `String` |
| `enabled` | `Boolean` |
| `frequency` | `String` |
| `recipientEmails` | `Json` |
| `contentSections` | `Json` |
| `subjectTemplate` | `String?` |
| `dateRangeMode` | `String` |
| `lastDays` | `Int` |
| `startDate` | `DateTime?` |
| `lastSuccessfulSendAt` | `DateTime?` |
| `nextRunAt` | `DateTime?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `MediaServerNewsletterDelivery`

Tabla: `media_server_newsletter_deliveries`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `newsletterId` | `String` |
| `recipientEmail` | `String` |
| `status` | `String` |
| `subject` | `String?` |
| `sentAt` | `DateTime?` |
| `errorMessage` | `String?` |
| `createdAt` | `DateTime` |

### `MediaServerConfig`

Tabla: `media_server_configs`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `provider` | `String` |
| `name` | `String` |
| `baseUrl` | `String` |
| `encryptedConfig` | `String` |
| `enabled` | `Boolean` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

## Plataforma

_29 modelos._

```mermaid
erDiagram
  SubtitleDownload }o--|| SubtitleValidation : "validation"
  SubtitleDownload ||--o{ SubtitleSynchronization : "synchronizations"
  SubtitleValidation }o--|| SubtitleDownload : "download"
  SubtitleSynchronization }o--|| SubtitleDownload : "download"
  PlatformJob }o--|| PlatformJob : "parent"
  PlatformJob ||--o{ PlatformJob : "children"
  PlatformJob ||--o{ PlatformJobEvent : "events"
  PlatformJobEvent }o--|| PlatformJob : "job"
  Workflow ||--o{ WorkflowVersion : "versions"
  Workflow ||--o{ WorkflowExecution : "executions"
  WorkflowVersion }o--|| Workflow : "workflow"
  WorkflowVersion ||--o{ WorkflowExecution : "executions"
  WorkflowExecution }o--|| Workflow : "workflow"
  WorkflowExecution }o--|| WorkflowVersion : "version"
  WorkflowExecution ||--o{ WorkflowNodeExecution : "nodes"
  WorkflowExecution ||--o{ WorkflowApproval : "approvals"
  WorkflowNodeExecution }o--|| WorkflowExecution : "execution"
  WorkflowApproval }o--|| WorkflowExecution : "execution"
```

### `TraktAccount`

Tabla: `trakt_accounts`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `userId` | `String` |
| `username` | `String?` |
| `slug` | `String?` |
| `accessToken` | `String` |
| `refreshToken` | `String` |
| `expiresAt` | `DateTime` |
| `scope` | `String?` |
| `syncCollection` | `Boolean` |
| `syncWatched` | `Boolean` |
| `syncRatings` | `Boolean` |
| `syncWatchlist` | `Boolean` |
| `scrobbleEnabled` | `Boolean` |
| `mediaServerUserName` | `String?` |
| `lastCollectionSyncAt` | `DateTime?` |
| `lastWatchedSyncAt` | `DateTime?` |
| `lastRatingsSyncAt` | `DateTime?` |
| `lastWatchlistSyncAt` | `DateTime?` |
| `lastError` | `String?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `Permission`

Tabla: `permissions`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `key` | `String` |
| `description` | `String?` |

### `RefreshToken`

Tabla: `refresh_tokens`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `userId` | `String` |
| `tokenHash` | `String` |
| `family` | `String` |
| `userAgent` | `String?` |
| `ipAddress` | `String?` |
| `expiresAt` | `DateTime` |
| `revokedAt` | `DateTime?` |
| `createdAt` | `DateTime` |

### `ParkedTorrent`

Tabla: `parked_torrents`

| Column | Type |
| --- | --- |
| `hash` | `String` |
| `engineId` | `String` |
| `name` | `String` |
| `reason` | `String` |
| `parkedAt` | `DateTime` |
| `probingSince` | `DateTime?` |
| `lastProbedAt` | `DateTime?` |
| `probeCount` | `Int` |
| `lastSeeders` | `Int` |
| `updatedAt` | `DateTime` |

### `DownloadPath`

Tabla: `download_paths`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `label` | `String` |
| `path` | `String` |
| `isDefault` | `Boolean` |
| `createdAt` | `DateTime` |

### `Setting`

Tabla: `settings`

| Column | Type |
| --- | --- |
| `key` | `String` |
| `value` | `Json` |
| `updatedAt` | `DateTime` |

### `SystemEvent`

Tabla: `system_events`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `type` | `String` |
| `severity` | `String` |
| `payload` | `Json` |
| `createdAt` | `DateTime` |

### `ModuleState`

Tabla: `module_states`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `moduleId` | `String` |
| `enabled` | `Boolean` |
| `status` | `String` |
| `tier` | `String` |
| `reason` | `String?` |
| `metadata` | `Json?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `ModuleEvent`

Tabla: `module_events`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `moduleId` | `String` |
| `eventType` | `String` |
| `message` | `String` |
| `metadata` | `Json?` |
| `userId` | `String?` |
| `createdAt` | `DateTime` |

### `TrashItem`

Tabla: `trash_items`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `originalPath` | `String` |
| `name` | `String` |
| `trashPath` | `String` |
| `storageRoot` | `String` |
| `isDirectory` | `Boolean` |
| `size` | `BigInt` |
| `deletedById` | `String?` |
| `deletedAt` | `DateTime` |

### `AcquisitionMatchCandidate`

Tabla: `acquisition_match_candidates`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `priorityOrder` | `Int` |
| `name` | `String` |
| `description` | `String?` |
| `enabled` | `Boolean` |
| `matchType` | `String` |
| `pattern` | `String?` |
| `requiredTerms` | `Json` |
| `excludedTerms` | `Json` |
| `qualityRules` | `Json` |
| `sizeRules` | `Json` |
| `lastMatchedAt` | `DateTime?` |
| `matchCount` | `Int` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `SubtitleProviderConfig`

Tabla: `subtitle_provider_configs`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `provider` | `String` |
| `isEnabled` | `Boolean` |
| `priority` | `Int` |
| `config` | `Json` |
| `healthy` | `Boolean?` |
| `lastCheckedAt` | `DateTime?` |
| `lastError` | `String?` |
| `quotaRemaining` | `Int?` |
| `quotaResetAt` | `DateTime?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `SubtitleFingerprint`

Tabla: `subtitle_fingerprints`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `itemId` | `String` |
| `fileId` | `String?` |
| `movieHash` | `String?` |
| `sha256` | `String?` |
| `fileSize` | `BigInt` |
| `runtimeSec` | `Int?` |
| `frameRate` | `Float?` |
| `resolution` | `String?` |
| `videoCodec` | `String?` |
| `audioCodec` | `String?` |
| `audioLanguage` | `String?` |
| `container` | `String?` |
| `source` | `String?` |
| `releaseGroup` | `String?` |
| `hdr` | `String?` |
| `edition` | `String?` |
| `season` | `Int?` |
| `episode` | `Int?` |
| `imdbId` | `String?` |
| `tmdbId` | `String?` |
| `tvdbId` | `String?` |
| `mediaType` | `String?` |
| `computedAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `SubtitleCandidate`

Tabla: `subtitle_candidates`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `itemId` | `String` |
| `provider` | `String` |
| `providerFileId` | `String?` |
| `language` | `String` |
| `releaseName` | `String?` |
| `filename` | `String?` |
| `movieHash` | `String?` |
| `imdbId` | `String?` |
| `tmdbId` | `String?` |
| `tvdbId` | `String?` |
| `season` | `Int?` |
| `episode` | `Int?` |
| `runtimeSec` | `Int?` |
| `downloads` | `Int?` |
| `uploader` | `String?` |
| `rating` | `Float?` |
| `trustedUploader` | `Boolean` |
| `machineTranslated` | `Boolean` |
| `hearingImpaired` | `Boolean` |
| `forced` | `Boolean` |
| `fileSize` | `BigInt?` |
| `downloadUrl` | `String?` |
| `matchLevel` | `Int?` |
| `score` | `Int` |
| `scoreTier` | `String?` |
| `scoreBreakdown` | `Json?` |
| `rawMetadata` | `Json?` |
| `createdAt` | `DateTime` |

### `SubtitleDownload`

Tabla: `subtitle_downloads`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `itemId` | `String` |
| `provider` | `String` |
| `language` | `String` |
| `forced` | `Boolean` |
| `hearingImpaired` | `Boolean` |
| `path` | `String` |
| `releaseName` | `String?` |
| `score` | `Int` |
| `scoreTier` | `String?` |
| `matchLevel` | `Int?` |
| `fileSize` | `BigInt` |
| `status` | `String` |
| `validationId` | `String?` |
| `providerFileId` | `String?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `SubtitleValidation`

Tabla: `subtitle_validations`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `format` | `String?` |
| `valid` | `Boolean` |
| `cueCount` | `Int` |
| `startMs` | `Int?` |
| `endMs` | `Int?` |
| `issues` | `Json` |
| `runtimeDeltaSec` | `Int?` |
| `method` | `String?` |
| `createdAt` | `DateTime` |

### `SubtitleLanguageSetting`

Tabla: `subtitle_language_settings`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `libraryId` | `String` |
| `requiredLanguages` | `Json` |
| `preferredLanguages` | `Json` |
| `forcedLanguages` | `Json` |
| `hearingImpaired` | `Boolean` |
| `machineTranslation` | `Boolean` |
| `preferredProviders` | `Json` |
| `synchronizationRequired` | `Boolean` |
| `minimumScore` | `Int` |
| `automaticReplacement` | `Boolean` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `SubtitleHistory`

Tabla: `subtitle_history`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `itemId` | `String?` |
| `action` | `String` |
| `provider` | `String?` |
| `language` | `String?` |
| `score` | `Int?` |
| `message` | `String?` |
| `metadata` | `Json?` |
| `createdAt` | `DateTime` |

### `SubtitleJob`

Tabla: `subtitle_jobs`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `type` | `String` |
| `status` | `String` |
| `libraryId` | `String?` |
| `itemId` | `String?` |
| `provider` | `String?` |
| `language` | `String?` |
| `payload` | `Json` |
| `result` | `Json?` |
| `error` | `String?` |
| `progress` | `Int` |
| `startedAt` | `DateTime?` |
| `finishedAt` | `DateTime?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `SubtitleSynchronization`

Tabla: `subtitle_synchronizations`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `downloadId` | `String` |
| `provider` | `String` |
| `method` | `String` |
| `version` | `String?` |
| `offsetMs` | `Int` |
| `driftFactor` | `Float` |
| `confidence` | `Float?` |
| `matchedRegions` | `Json?` |
| `originalPath` | `String` |
| `syncedPath` | `String` |
| `status` | `String` |
| `message` | `String?` |
| `createdAt` | `DateTime` |

### `PlatformJob`

Tabla: `platform_jobs`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `type` | `String` |
| `name` | `String?` |
| `description` | `String?` |
| `moduleKey` | `String` |
| `workspaceKey` | `String?` |
| `sourceType` | `String` |
| `sourceId` | `String?` |
| `correlationId` | `String?` |
| `parentJobId` | `String?` |
| `rootJobId` | `String?` |
| `scheduleId` | `String?` |
| `workflowExecutionId` | `String?` |
| `resourceType` | `String?` |
| `resourceId` | `String?` |
| `libraryId` | `String?` |
| `mediaItemId` | `String?` |
| `status` | `String` |
| `phase` | `String?` |
| `progressPercent` | `Int` |
| `progressCurrent` | `Int?` |
| `progressTotal` | `Int?` |
| `progressUnit` | `String?` |
| `statusMessageKey` | `String?` |
| `statusMessageParams` | `Json?` |
| `queuedAt` | `DateTime` |
| `scheduledFor` | `DateTime?` |
| `startedAt` | `DateTime?` |
| `heartbeatAt` | `DateTime?` |
| `completedAt` | `DateTime?` |
| `failedAt` | `DateTime?` |
| `cancelledAt` | `DateTime?` |
| `pausedAt` | `DateTime?` |
| `resumedAt` | `DateTime?` |
| `expiresAt` | `DateTime?` |
| `priority` | `Int` |
| `queueName` | `String?` |
| `workerId` | `String?` |
| `attempt` | `Int` |
| `maxAttempts` | `Int` |

### `PlatformJobEvent`

Tabla: `platform_job_events`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `jobId` | `String` |
| `sequence` | `Int` |
| `level` | `String` |
| `eventType` | `String` |
| `messageKey` | `String?` |
| `messageParams` | `Json?` |
| `sanitizedMessage` | `String?` |
| `progress` | `Int?` |
| `metadata` | `Json?` |
| `createdAt` | `DateTime` |

### `Workflow`

Tabla: `workflows`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `name` | `String` |
| `description` | `String?` |
| `workspaceKey` | `String?` |
| `enabled` | `Boolean` |
| `status` | `String` |
| `tags` | `String[]` |
| `currentDraftVersionId` | `String?` |
| `publishedVersionId` | `String?` |
| `createdById` | `String?` |
| `updatedById` | `String?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |
| `archivedAt` | `DateTime?` |

### `WorkflowVersion`

Tabla: `workflow_versions`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `workflowId` | `String` |
| `versionNumber` | `Int` |
| `status` | `String` |
| `graph` | `Json` |
| `triggerSummary` | `Json?` |
| `requiredPermissions` | `String[]` |
| `checksum` | `String` |
| `changeNotes` | `String?` |
| `createdById` | `String?` |
| `createdAt` | `DateTime` |
| `publishedAt` | `DateTime?` |
| `archivedAt` | `DateTime?` |

### `WorkflowExecution`

Tabla: `workflow_executions`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `workflowId` | `String` |
| `workflowVersionId` | `String` |
| `triggerType` | `String?` |
| `triggerEventId` | `String?` |
| `triggerSource` | `String?` |
| `correlationId` | `String?` |
| `traceId` | `String?` |
| `status` | `String` |
| `inputContext` | `Json?` |
| `outputSummary` | `Json?` |
| `currentNodeIds` | `String[]` |
| `jobId` | `String?` |
| `executionIdentityUserId` | `String?` |
| `resumeAt` | `DateTime?` |
| `expiresAt` | `DateTime?` |
| `heartbeatAt` | `DateTime?` |
| `parentExecutionId` | `String?` |
| `depth` | `Int` |
| `startedAt` | `DateTime?` |
| `completedAt` | `DateTime?` |
| `failedAt` | `DateTime?` |
| `cancelledAt` | `DateTime?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `WorkflowNodeExecution`

Tabla: `workflow_node_executions`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `workflowExecutionId` | `String` |
| `nodeId` | `String` |
| `nodeType` | `String` |
| `status` | `String` |
| `attempt` | `Int` |
| `maxAttempts` | `Int` |
| `inputSummary` | `Json?` |
| `outputSummary` | `Json?` |
| `jobId` | `String?` |
| `errorCode` | `String?` |
| `errorMessage` | `String?` |
| `warnings` | `Json?` |
| `startedAt` | `DateTime?` |
| `completedAt` | `DateTime?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `WorkflowApproval`

Tabla: `workflow_approvals`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `workflowExecutionId` | `String` |
| `nodeExecutionId` | `String?` |
| `status` | `String` |
| `requestedFromUserId` | `String?` |
| `requestedFromRoleId` | `String?` |
| `requiredPermission` | `String?` |
| `riskLevel` | `String?` |
| `requestedAt` | `DateTime` |
| `respondedAt` | `DateTime?` |
| `respondedById` | `String?` |
| `comment` | `String?` |
| `expiresAt` | `DateTime?` |

### `WorkflowVariable`

Tabla: `workflow_variables`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `scope` | `String` |
| `workflowId` | `String?` |
| `key` | `String` |
| `valueType` | `String` |
| `encryptedValue` | `String?` |
| `plainValue` | `Json?` |
| `description` | `String?` |
| `createdById` | `String?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `WorkflowTemplate`

Tabla: `workflow_templates`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `key` | `String` |
| `nameKey` | `String` |
| `descriptionKey` | `String?` |
| `category` | `String` |
| `graph` | `Json` |
| `requiredModules` | `String[]` |
| `requiredPermissions` | `String[]` |
| `defaultEnabled` | `Boolean` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

## RSS

_8 modelos._

```mermaid
erDiagram
  RssFeed ||--o{ RssRule : "rules"
  RssFeed ||--o{ RssHistory : "history"
  RssRule }o--|| RssFeed : "feed"
  RssRule ||--o{ RssRuleMatchCandidate : "matchCandidates"
  RssRule ||--o{ RssRuleMatchEvaluation : "matchEvaluations"
  RssRule ||--o{ RssSmartMatchTemplate : "smartTemplates"
  RssRule ||--o{ RssAcquisition : "acquisitions"
  RssAcquisition }o--|| RssRule : "rule"
  RssSmartMatchTemplate }o--|| RssRule : "rule"
  RssRuleMatchCandidate }o--|| RssRule : "rule"
  RssRuleMatchEvaluation }o--|| RssRule : "rule"
  RssHistory }o--|| RssFeed : "feed"
```

### `RssFeed`

Tabla: `rss_feeds`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `name` | `String` |
| `url` | `String` |
| `refreshInterval` | `Int` |
| `isEnabled` | `Boolean` |
| `lastFetchedAt` | `DateTime?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `RssRule`

Tabla: `rss_rules`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `feedId` | `String` |
| `name` | `String` |
| `includeRegex` | `String?` |
| `excludeRegex` | `String?` |
| `categoryId` | `String?` |
| `savePath` | `String?` |
| `autoDownload` | `Boolean` |
| `isEnabled` | `Boolean` |
| `createdAt` | `DateTime` |
| `mediaType` | `String?` |
| `showStatus` | `String?` |
| `showStatusProvider` | `String?` |
| `showStatusProviderId` | `String?` |
| `showStatusCheckedAt` | `DateTime?` |
| `showStatusRecommendation` | `String?` |
| `showFirstAirDate` | `DateTime?` |
| `showLastAirDate` | `DateTime?` |
| `showNextEpisodeAirDate` | `DateTime?` |
| `showStatusWarnings` | `Json` |
| `allowInactiveShowMonitoring` | `Boolean` |

### `TvShowStatus`

Tabla: `tv_show_status`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `provider` | `String` |
| `providerShowId` | `String` |
| `title` | `String` |
| `normalizedTitle` | `String` |
| `originalStatus` | `String?` |
| `normalizedStatus` | `String` |
| `recommendation` | `String` |
| `confidence` | `Float` |
| `firstAirDate` | `DateTime?` |
| `lastAirDate` | `DateTime?` |
| `nextEpisodeAirDate` | `DateTime?` |
| `lastEpisodeTitle` | `String?` |
| `nextEpisodeTitle` | `String?` |
| `totalSeasons` | `Int?` |
| `totalEpisodes` | `Int?` |
| `overview` | `String?` |
| `posterUrl` | `String?` |
| `warnings` | `Json` |
| `checkedAt` | `DateTime` |

### `RssAcquisition`

Tabla: `rss_acquisitions`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `rssRuleId` | `String` |
| `identity` | `String` |
| `priorityOrder` | `Int` |
| `releaseTitle` | `String` |
| `torrentHash` | `String?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `RssSmartMatchTemplate`

Tabla: `rss_smart_match_templates`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `rssRuleId` | `String` |
| `sourceName` | `String` |
| `parsedMetadata` | `Json` |
| `generatedCandidates` | `Json` |
| `confidenceScore` | `Int` |
| `userEdited` | `Boolean` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `RssRuleMatchCandidate`

Tabla: `rss_rule_match_candidates`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `rssRuleId` | `String` |
| `priorityOrder` | `Int` |
| `name` | `String` |
| `description` | `String?` |
| `enabled` | `Boolean` |
| `matchType` | `String` |
| `pattern` | `String?` |
| `requiredTerms` | `Json` |
| `excludedTerms` | `Json` |
| `qualityRules` | `Json` |
| `sizeRules` | `Json` |
| `feedScope` | `Json` |
| `lastMatchedAt` | `DateTime?` |
| `matchCount` | `Int` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `RssRuleMatchEvaluation`

Tabla: `rss_rule_match_evaluations`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `rssRuleId` | `String` |
| `rssItemId` | `String` |
| `matchedCandidateId` | `String?` |
| `matchedCandidatePriority` | `Int?` |
| `result` | `String` |
| `evaluationTrace` | `Json` |
| `actionTaken` | `String?` |
| `torrentHash` | `String?` |
| `createdAt` | `DateTime` |

### `RssHistory`

Tabla: `rss_history`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `feedId` | `String` |
| `itemGuid` | `String` |
| `title` | `String` |
| `link` | `String` |
| `magnet` | `String?` |
| `infoHash` | `String?` |
| `matched` | `Boolean` |
| `downloaded` | `Boolean` |
| `createdAt` | `DateTime` |

## Torrents

_5 modelos._

```mermaid
erDiagram
  TorrentEngine ||--o{ TorrentSnapshot : "snapshots"
  TorrentSnapshot }o--|| TorrentEngine : "engine"
  TorrentSnapshot }o--|| TorrentCategory : "category"
  TorrentSnapshot ||--o{ TorrentTagLink : "tags"
  TorrentCategory ||--o{ TorrentSnapshot : "snapshots"
  TorrentTag ||--o{ TorrentTagLink : "links"
  TorrentTagLink }o--|| TorrentSnapshot : "snapshot"
  TorrentTagLink }o--|| TorrentTag : "tag"
```

### `TorrentEngine`

Tabla: `torrent_engines`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `name` | `String` |
| `kind` | `String` |
| `config` | `Json` |
| `isDefault` | `Boolean` |
| `isEnabled` | `Boolean` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |

### `TorrentSnapshot`

Tabla: `torrent_snapshots`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `engineId` | `String` |
| `hash` | `String` |
| `name` | `String` |
| `state` | `String` |
| `progress` | `Float` |
| `size` | `BigInt` |
| `downloaded` | `BigInt` |
| `uploaded` | `BigInt` |
| `ratio` | `Float` |
| `downloadRate` | `Int` |
| `uploadRate` | `Int` |
| `savePath` | `String` |
| `label` | `String?` |
| `categoryId` | `String?` |
| `addedAt` | `DateTime?` |
| `completedAt` | `DateTime?` |
| `capturedAt` | `DateTime` |

### `TorrentCategory`

Tabla: `torrent_categories`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `name` | `String` |
| `color` | `String?` |
| `savePath` | `String?` |
| `createdAt` | `DateTime` |

### `TorrentTag`

Tabla: `torrent_tags`

| Column | Type |
| --- | --- |
| `id` | `String` |
| `name` | `String` |
| `color` | `String?` |
| `createdAt` | `DateTime` |

### `TorrentTagLink`

Tabla: `torrent_tag_links`

| Column | Type |
| --- | --- |
| `snapshotId` | `String` |
| `tagId` | `String` |

## Ver también

- [Copias de seguridad y restauración](/operate/backup) — vuelca y restaura esta base de datos de forma segura
- [Base de datos y Prisma para desarrolladores](/develop/database)
