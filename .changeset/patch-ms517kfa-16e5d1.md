---
"ultratorrent": patch
---

Drop three unusable indexes on imdb_titles: the primaryTitle/originalTitle btrees, which cannot serve the case-insensitive (ILIKE) lookups the code actually issues and were superseded by the runtime GIN trigram indexes, and the titleType index, a redundant prefix of the (titleType, startYear) composite. Reclaims ~645 MB on a full catalogue with no query losing an access path.
