ALTER TABLE "AppConfig" ADD COLUMN "statusBroadcastEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AppConfig" ADD COLUMN "statusBroadcastIntervalSec" INTEGER NOT NULL DEFAULT 600;
ALTER TABLE "AppConfig" ADD COLUMN "statusBroadcastGps" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AppConfig" ADD COLUMN "statusReplyEnabled" BOOLEAN NOT NULL DEFAULT false;
