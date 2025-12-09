-- AlterTable
ALTER TABLE "Geofence" ADD COLUMN     "appliesToAdsb" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "appliesToDrones" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "appliesToTargets" BOOLEAN NOT NULL DEFAULT true;
