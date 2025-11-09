DO $migration$
BEGIN
  IF to_regclass('public."SerialConfig"') IS NULL THEN
    -- Table never existed on this database; create the singleton row from scratch
    CREATE TABLE "SerialConfig" (
      "id" TEXT NOT NULL DEFAULT 'serial',
      "devicePath" TEXT,
      "baud" INTEGER,
      "dataBits" INTEGER,
      "parity" TEXT,
      "stopBits" INTEGER,
      "delimiter" TEXT,
      "reconnectBaseMs" INTEGER,
      "reconnectMaxMs" INTEGER,
      "reconnectJitter" DOUBLE PRECISION,
      "reconnectMaxAttempts" INTEGER,
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE "SerialConfig" ADD CONSTRAINT "SerialConfig_pkey" PRIMARY KEY ("id");
    INSERT INTO "SerialConfig" ("id") VALUES ('serial') ON CONFLICT ("id") DO NOTHING;
  ELSE
    -- Collapse SerialConfig into a single-row table keyed by 'serial'
    -- Keep the most recently updated row (or any existing row if timestamps are null)
    DELETE FROM "SerialConfig"
    WHERE "ctid" NOT IN (
      SELECT ctid
      FROM (
        SELECT ctid,
               row_number() OVER (ORDER BY "updatedAt" DESC NULLS LAST, "siteId" ASC) AS rn
        FROM "SerialConfig"
      ) ranked
      WHERE rn = 1
    );

    -- Drop old foreign key/primary key and rename the column to id
    ALTER TABLE "SerialConfig" DROP CONSTRAINT IF EXISTS "SerialConfig_siteId_fkey";
    ALTER TABLE "SerialConfig" DROP CONSTRAINT IF EXISTS "SerialConfig_pkey";
    ALTER TABLE "SerialConfig" RENAME COLUMN "siteId" TO "id";

    -- Ensure the remaining row uses the singleton key value
    UPDATE "SerialConfig" SET "id" = 'serial' WHERE "id" IS NULL OR "id" <> 'serial';

    -- Apply defaults and primary key
    ALTER TABLE "SerialConfig" ALTER COLUMN "id" SET DEFAULT 'serial';
    ALTER TABLE "SerialConfig" ALTER COLUMN "id" SET NOT NULL;
    ALTER TABLE "SerialConfig" ADD CONSTRAINT "SerialConfig_pkey" PRIMARY KEY ("id");
  END IF;
END;
$migration$;
