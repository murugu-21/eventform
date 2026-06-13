# syntax=docker/dockerfile:1
# Caddy reverse-proxies the API to the cloudflared tunnel. The SPA is deployed
# to Cloudflare Pages (see DEPLOYMENT.md), so this image carries only the
# Caddyfile — no Vite build, no VITE_* build args.
FROM caddy:2-alpine
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
