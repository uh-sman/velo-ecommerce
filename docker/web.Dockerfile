# Production image for a Next.js app (storefront or admin).
#
#   docker build -f docker/web.Dockerfile --build-arg APP=storefront -t velo-storefront:local .
#   docker build -f docker/web.Dockerfile --build-arg APP=admin      -t velo-admin:local .

ARG APP=storefront

# ─── Dependencies ──────────────────────────────────────────────────────────
FROM node:24-alpine AS deps
RUN corepack enable
WORKDIR /repo

# Manifests only, so the install layer survives application changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/storefront/package.json apps/storefront/
COPY apps/admin/package.json apps/admin/
COPY packages/config/package.json packages/config/
COPY packages/api-client/package.json packages/api-client/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ─── Builder ───────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder
ARG APP
RUN corepack enable
WORKDIR /repo

COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/storefront/node_modules ./apps/storefront/node_modules
COPY --from=deps /repo/apps/admin/node_modules ./apps/admin/node_modules
# pnpm links each workspace package's own dependencies into its own folder:
# the build lints through @velo/config's plugins and imports api-client's.
COPY --from=deps /repo/packages/config/node_modules ./packages/config/node_modules
COPY --from=deps /repo/packages/api-client/node_modules ./packages/api-client/node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT_STANDALONE=1
RUN pnpm --filter "@velo/${APP}" build

# ─── Runtime ───────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
ARG APP
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 -G nodejs nextjs

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

# Standalone output: the server plus only the dependencies it actually reached.
COPY --from=builder --chown=nextjs:nodejs /repo/apps/${APP}/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/apps/${APP}/.next/static ./apps/${APP}/.next/static
COPY --from=builder --chown=nextjs:nodejs /repo/apps/${APP}/public ./apps/${APP}/public

# Carried into the runtime environment so the entrypoint can reach it — an ARG
# is a build-time value and is not visible to CMD.
ENV APP_NAME=${APP}

USER nextjs
EXPOSE 3000

CMD ["sh", "-c", "node apps/${APP_NAME}/server.js"]
