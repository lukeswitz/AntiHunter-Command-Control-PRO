-- Add originSiteId column to Node table and index for lookup.
ALTER TABLE "Node"
ADD COLUMN "originSiteId" TEXT;

CREATE INDEX "Node_originSiteId_idx" ON "Node"("originSiteId");
