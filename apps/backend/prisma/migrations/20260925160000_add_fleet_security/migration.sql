CREATE TABLE "FleetIdentity" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "notes" TEXT,
    CONSTRAINT "FleetIdentity_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FleetIdentity_label_key" ON "FleetIdentity"("label");
CREATE UNIQUE INDEX "FleetIdentity_publicKey_key" ON "FleetIdentity"("publicKey");
CREATE UNIQUE INDEX "FleetIdentity_fingerprint_key" ON "FleetIdentity"("fingerprint");
CREATE INDEX "FleetIdentity_role_idx" ON "FleetIdentity"("role");

CREATE TABLE "FleetNodeTrust" (
    "nodeNum" BIGINT NOT NULL,
    "adminKeyFps" JSONB NOT NULL DEFAULT '[]',
    "isManaged" BOOLEAN NOT NULL DEFAULT false,
    "lastVerifiedAt" TIMESTAMP(3),
    "lastVerifyMethod" TEXT,
    "lastDriftCheckAt" TIMESTAMP(3),
    "driftStatus" TEXT NOT NULL DEFAULT 'unknown',
    "currentPskFp" TEXT,
    "previousPskFp" TEXT,
    "strandedSince" TIMESTAMP(3),
    "recoveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastRecoveryAt" TIMESTAMP(3),
    "lastRecoveryError" TEXT,
    "notes" TEXT,
    CONSTRAINT "FleetNodeTrust_pkey" PRIMARY KEY ("nodeNum")
);
CREATE INDEX "FleetNodeTrust_driftStatus_idx" ON "FleetNodeTrust"("driftStatus");
CREATE INDEX "FleetNodeTrust_strandedSince_idx" ON "FleetNodeTrust"("strandedSince");

CREATE TABLE "FleetChannel" (
    "channelIndex" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "pskFingerprint" TEXT,
    "pskLength" INTEGER,
    "lastRotatedAt" TIMESTAMP(3),
    "lastRotatedBy" TEXT,
    "lastRotationId" TEXT,
    CONSTRAINT "FleetChannel_pkey" PRIMARY KEY ("channelIndex")
);

CREATE TABLE "FleetRotation" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "channelIndex" INTEGER,
    "stagingChannelIndex" INTEGER,
    "piLocalPhase" TEXT NOT NULL DEFAULT 'pending',
    "startedBy" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "targets" JSONB NOT NULL,
    "newPskFp" TEXT,
    "newPsk" BYTEA,
    "notes" TEXT,
    CONSTRAINT "FleetRotation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FleetRotation_startedAt_idx" ON "FleetRotation"("startedAt");
CREATE INDEX "FleetRotation_kind_idx" ON "FleetRotation"("kind");

CREATE TABLE "FleetPolicy" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "expectedAdminKeyFps" JSONB NOT NULL DEFAULT '[]',
    "expectedIsManaged" BOOLEAN NOT NULL DEFAULT false,
    "expectedChannels" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,
    CONSTRAINT "FleetPolicy_pkey" PRIMARY KEY ("id")
);
INSERT INTO "FleetPolicy" ("id") VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE "FleetJob" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "rotationId" TEXT,
    "targetNodeNum" BIGINT,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "enqueuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "workerId" TEXT,
    CONSTRAINT "FleetJob_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FleetJob_state_enqueuedAt_idx" ON "FleetJob"("state", "enqueuedAt");
CREATE INDEX "FleetJob_rotationId_idx" ON "FleetJob"("rotationId");
ALTER TABLE "FleetJob" ADD CONSTRAINT "FleetJob_rotationId_fkey" FOREIGN KEY ("rotationId") REFERENCES "FleetRotation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FleetRecoveryPsk" (
    "slot" INTEGER NOT NULL,
    "fp" TEXT NOT NULL,
    "rawPsk" BYTEA NOT NULL,
    "pskHash" INTEGER NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotationId" TEXT,
    CONSTRAINT "FleetRecoveryPsk_pkey" PRIMARY KEY ("slot")
);
CREATE UNIQUE INDEX "FleetRecoveryPsk_fp_key" ON "FleetRecoveryPsk"("fp");
