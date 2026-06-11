# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
# Copy manifest files first for layer caching
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @eventform/worker...
COPY packages ./packages
COPY apps/worker ./apps/worker
# Build the full dependency tree then deploy to /out
RUN pnpm --filter @eventform/worker... build \
 && pnpm --filter @eventform/worker deploy --prod --legacy /out

FROM node:22-alpine
WORKDIR /app
COPY --from=build /out .
EXPOSE 3002
USER node
CMD ["node", "dist/main.js"]
