-- CreateTable
CREATE TABLE "KnownMeshRadio" (
    "mac" TEXT NOT NULL,
    "radio" TEXT NOT NULL,
    "name" TEXT,
    "addedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnownMeshRadio_pkey" PRIMARY KEY ("mac")
);
