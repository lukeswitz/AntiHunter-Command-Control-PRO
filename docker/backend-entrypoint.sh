#!/bin/sh
set -euo pipefail

cd /app/apps/backend

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "Running database migrations..."
  npx prisma migrate deploy
fi

echo "Starting backend..."
exec node dist/main.js
