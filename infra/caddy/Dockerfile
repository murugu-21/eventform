# syntax=docker/dockerfile:1
# Stage 1: Build the Vite SPA
FROM node:22-alpine AS web-build
RUN corepack enable
WORKDIR /repo
# Build args for baking VITE_* env vars at image build time
ARG VITE_API_URL=https://eventform-api.murugappan.dev
ARG VITE_AUTH_MODE=cognito
ARG VITE_COGNITO_DOMAIN=https://auth.murugappan.dev
ARG VITE_COGNITO_CLIENT_ID=2lg7gav69pb2k0qnkt2md4kaio
ARG VITE_REDIRECT_URI=https://eventform.murugappan.dev/auth/callback

# Copy manifest files first for layer caching
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @eventform/web...

COPY apps/web ./apps/web
# Expose ARGs as env vars for Vite at build time
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_AUTH_MODE=${VITE_AUTH_MODE}
ENV VITE_COGNITO_DOMAIN=${VITE_COGNITO_DOMAIN}
ENV VITE_COGNITO_CLIENT_ID=${VITE_COGNITO_CLIENT_ID}
ENV VITE_REDIRECT_URI=${VITE_REDIRECT_URI}
RUN pnpm --filter @eventform/web build

# Stage 2: Caddy serves the static files + proxies the API
FROM caddy:2-alpine
COPY --from=web-build /repo/apps/web/dist /srv/web
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
