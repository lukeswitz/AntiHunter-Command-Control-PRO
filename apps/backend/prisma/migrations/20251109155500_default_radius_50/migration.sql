-- Ensure columns exist before altering defaults (older DBs might miss them)
ALTER TABLE "AppConfig"
ADD COLUMN IF NOT EXISTS "defaultRadiusM" INTEGER;

ALTER TABLE "Site"
ADD COLUMN IF NOT EXISTS "defaultRadiusM" INTEGER;

-- Update existing values to the new defaults when they still hold the previous value
UPDATE "AppConfig"
SET "defaultRadiusM" = 50
WHERE "defaultRadiusM" IS NULL OR "defaultRadiusM" IN (0, 100);

UPDATE "Site"
SET "defaultRadiusM" = 50
WHERE "defaultRadiusM" IS NULL OR "defaultRadiusM" IN (0, 100);

-- Enforce the new default going forward
ALTER TABLE "AppConfig"
ALTER COLUMN "defaultRadiusM" SET DEFAULT 50;

ALTER TABLE "Site"
ALTER COLUMN "defaultRadiusM" SET DEFAULT 50;
