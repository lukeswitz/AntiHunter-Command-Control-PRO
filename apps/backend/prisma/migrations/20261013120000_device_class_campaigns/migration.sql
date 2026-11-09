-- AlterTable
ALTER TABLE "InventoryDevice" ADD COLUMN     "bleClass" TEXT;

-- CreateTable
CREATE TABLE "CampaignRun" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "siteId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "CampaignRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignRun_name_idx" ON "CampaignRun"("name");

-- CreateIndex
CREATE INDEX "CampaignRun_nodeId_endedAt_idx" ON "CampaignRun"("nodeId", "endedAt");

-- CreateIndex
CREATE INDEX "DeviceVisit_nodeId_end_idx" ON "DeviceVisit"("nodeId", "end");
