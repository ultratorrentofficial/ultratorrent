-- CreateTable
CREATE TABLE "trash_items" (
    "id" TEXT NOT NULL,
    "originalPath" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trashPath" TEXT NOT NULL,
    "storageRoot" TEXT NOT NULL,
    "isDirectory" BOOLEAN NOT NULL DEFAULT false,
    "size" BIGINT NOT NULL DEFAULT 0,
    "deletedById" TEXT,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trash_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trash_items_trashPath_key" ON "trash_items"("trashPath");

-- CreateIndex
CREATE INDEX "trash_items_deletedAt_idx" ON "trash_items"("deletedAt");
