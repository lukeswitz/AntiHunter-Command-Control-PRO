-- AlterTable
ALTER TABLE "Target" ADD COLUMN     "trackingConfidence" DOUBLE PRECISION,
ADD COLUMN     "trackingUncertainty" DOUBLE PRECISION,
ADD COLUMN     "triangulationMethod" TEXT;
