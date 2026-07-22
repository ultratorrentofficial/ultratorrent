-- AlterTable
ALTER TABLE "media_files" ADD COLUMN     "chromaSubsampling" TEXT,
ADD COLUMN     "colorPrimaries" TEXT,
ADD COLUMN     "colorSpace" TEXT,
ADD COLUMN     "colorTransfer" TEXT,
ADD COLUMN     "hdrFormat" TEXT,
ADD COLUMN     "videoBitDepth" INTEGER;

