# syntax=docker/dockerfile:1.7

FROM node:20-bookworm AS deps
WORKDIR /app

ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/

# Install workspace dependencies (dev deps needed for build)
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY . .

# Generate Prisma client and build the NestJS backend
RUN pnpm --filter @command-center/backend prisma:generate \
 && pnpm --filter @command-center/backend build

FROM builder AS pruner
# Strip dev dependencies to shrink the runtime image
RUN pnpm prune --prod --filter @command-center/backend...

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# Copy workspace metadata so pnpm can resolve symlinks
COPY --from=builder /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.base.json ./tsconfig.base.json

# Copy production node_modules after pruning
COPY --from=pruner /app/node_modules ./node_modules

# Copy backend artefacts
COPY --from=builder /app/apps/backend ./apps/backend

# Lightweight entrypoint handles migrations before boot
COPY docker/backend-entrypoint.sh ./backend-entrypoint.sh
RUN chmod +x ./backend-entrypoint.sh

EXPOSE 3000

CMD ["./backend-entrypoint.sh"]
