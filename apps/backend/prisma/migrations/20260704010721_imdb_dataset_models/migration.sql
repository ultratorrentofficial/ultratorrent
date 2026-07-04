-- CreateTable
CREATE TABLE "imdb_titles" (
    "id" TEXT NOT NULL,
    "tconst" TEXT NOT NULL,
    "titleType" TEXT NOT NULL,
    "primaryTitle" TEXT NOT NULL,
    "originalTitle" TEXT NOT NULL,
    "isAdult" BOOLEAN NOT NULL DEFAULT false,
    "startYear" INTEGER,
    "endYear" INTEGER,
    "runtimeMinutes" INTEGER,
    "genres" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "imdb_titles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imdb_akas" (
    "id" TEXT NOT NULL,
    "titleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "region" TEXT,
    "language" TEXT,
    "types" TEXT,
    "attributes" TEXT,
    "isOriginalTitle" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "imdb_akas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imdb_crew" (
    "id" TEXT NOT NULL,
    "titleId" TEXT NOT NULL,
    "directors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "writers" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "imdb_crew_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imdb_episodes" (
    "id" TEXT NOT NULL,
    "episodeTitleId" TEXT NOT NULL,
    "parentTitleId" TEXT NOT NULL,
    "seasonNumber" INTEGER,
    "episodeNumber" INTEGER,

    CONSTRAINT "imdb_episodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imdb_principals" (
    "id" TEXT NOT NULL,
    "titleId" TEXT NOT NULL,
    "ordering" INTEGER NOT NULL,
    "personId" TEXT NOT NULL,
    "category" TEXT,
    "job" TEXT,
    "characters" TEXT,

    CONSTRAINT "imdb_principals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imdb_persons" (
    "id" TEXT NOT NULL,
    "nconst" TEXT NOT NULL,
    "primaryName" TEXT NOT NULL,
    "birthYear" INTEGER,
    "deathYear" INTEGER,
    "primaryProfession" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "knownForTitles" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "imdb_persons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imdb_ratings" (
    "id" TEXT NOT NULL,
    "titleId" TEXT NOT NULL,
    "averageRating" DOUBLE PRECISION NOT NULL,
    "numVotes" INTEGER NOT NULL,

    CONSTRAINT "imdb_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imdb_dataset_imports" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sourcePath" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "filesImported" JSONB NOT NULL DEFAULT '[]',
    "recordsImported" INTEGER NOT NULL DEFAULT 0,
    "datasetDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "imdb_dataset_imports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "imdb_titles_tconst_key" ON "imdb_titles"("tconst");

-- CreateIndex
CREATE INDEX "imdb_titles_primaryTitle_idx" ON "imdb_titles"("primaryTitle");

-- CreateIndex
CREATE INDEX "imdb_titles_originalTitle_idx" ON "imdb_titles"("originalTitle");

-- CreateIndex
CREATE INDEX "imdb_titles_startYear_idx" ON "imdb_titles"("startYear");

-- CreateIndex
CREATE INDEX "imdb_titles_titleType_idx" ON "imdb_titles"("titleType");

-- CreateIndex
CREATE INDEX "imdb_akas_titleId_idx" ON "imdb_akas"("titleId");

-- CreateIndex
CREATE UNIQUE INDEX "imdb_crew_titleId_key" ON "imdb_crew"("titleId");

-- CreateIndex
CREATE UNIQUE INDEX "imdb_episodes_episodeTitleId_key" ON "imdb_episodes"("episodeTitleId");

-- CreateIndex
CREATE INDEX "imdb_episodes_parentTitleId_idx" ON "imdb_episodes"("parentTitleId");

-- CreateIndex
CREATE INDEX "imdb_episodes_parentTitleId_seasonNumber_episodeNumber_idx" ON "imdb_episodes"("parentTitleId", "seasonNumber", "episodeNumber");

-- CreateIndex
CREATE INDEX "imdb_principals_titleId_idx" ON "imdb_principals"("titleId");

-- CreateIndex
CREATE INDEX "imdb_principals_personId_idx" ON "imdb_principals"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "imdb_persons_nconst_key" ON "imdb_persons"("nconst");

-- CreateIndex
CREATE INDEX "imdb_persons_primaryName_idx" ON "imdb_persons"("primaryName");

-- CreateIndex
CREATE UNIQUE INDEX "imdb_ratings_titleId_key" ON "imdb_ratings"("titleId");

-- CreateIndex
CREATE INDEX "imdb_ratings_averageRating_idx" ON "imdb_ratings"("averageRating");

-- CreateIndex
CREATE INDEX "imdb_ratings_numVotes_idx" ON "imdb_ratings"("numVotes");
