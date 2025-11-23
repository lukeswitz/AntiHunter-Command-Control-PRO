-- AlterTable
ALTER TABLE "Target" ADD COLUMN     "coordinatingNode" TEXT,
ADD COLUMN     "trackingConfidence" DOUBLE PRECISION,
ADD COLUMN     "uncertainty" DOUBLE PRECISION;
