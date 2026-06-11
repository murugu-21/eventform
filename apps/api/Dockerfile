# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
# Copy manifest files first for layer caching
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @eventform/api...
COPY packages ./packages
COPY apps/api ./apps/api
# Build the full dependency tree then deploy to /out
RUN pnpm --filter @eventform/api... build \
 && pnpm --filter @eventform/api deploy --prod --legacy /out

FROM node:22-alpine
WORKDIR /app
COPY --from=build /out .
EXPOSE 3001
USER node
CMD ["node", "dist/main.js"]
