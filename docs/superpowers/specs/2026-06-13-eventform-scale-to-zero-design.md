# EventForm Scale-to-Zero (wake-on-visit + idle auto-stop)

**Date:** 2026-06-13 (revised 2026-06-14 to match the shipped architecture)
**Status:** Implemented

## Overview

Run the EventForm backend on an **EC2 Auto Scaling Group (min 0 / max 1)** that
**scales to 0 when idle and back to 1 on the first authenticated visit**, so we
pay for compute (and the public IPv4) only while someone is using the app. At
desired 0 there is no instance at all — ~$0 (no EBS either, since the volume is
`deleteOnTermination`).

This is viable because the box is now **stateless**:

- **Postgres is on Neon** (managed) and the Redpanda log + Debezium offset file
  are disposable. Terminating the instance loses nothing the pipeline needs.
- The **frontend is on Cloudflare Pages** (always up), so the site shell and the
  `ApiHealthGate` reconnect screen render while the box is gone.
- A fresh ASG instance's **userdata already boots the whole stack**
  (`docker compose up`), so "boot" needs no extra machinery.

> This supersedes the original draft (Cloudflare Worker + static IAM keys for
> wake; on-box `shutdown` reading the Caddy log for idle). Those assumed a single
> stop/start instance with persistent EBS and an in-compose Postgres — all of
> which changed (ASG, Neon, no Caddy, no LocalStack).

## Architecture — three pieces

### 1. Scale-up — wake (API Gateway + Cognito + Lambda)

- **`ApiHealthGate` (FE, extended):** when it transitions to `down`, it fires
  **one** fire-and-forget `POST` to the wake endpoint per down-episode (the 8-s
  `/health` poll loop does not re-fire it), then keeps polling until 200.
- **Wake endpoint:** an **HTTP API Gateway** route `POST /wake` behind a
  **Cognito JWT authorizer** (same pool the API verifies). CORS-allows the Pages
  origin. The SPA sends the logged-in user's access token as `Authorization:
  Bearer`.
- **Wake Lambda:** `DescribeAutoScalingGroups` → if desired < 1, `SetDesiredCapacity(1)`.
  Idempotent (1-when-already-1 is a no-op). **Keyless** — a Lambda execution role
  scoped to `SetDesiredCapacity` on the one ASG; no static credentials anywhere.
- **Cognito-only by design:** anonymous visitors (landing, public form) can't
  wake the box. Login goes through Cognito directly (not the box), so a user can
  sign in while it's off and their session wakes it. Accepted trade-off for a
  recruiter-login demo.

### 2. Boot — self-starting stack (unchanged)

A fresh ASG instance's userdata clones the repo, materializes `.env` from SSM,
and runs `docker compose -f docker-compose.prod.yml up -d`. `cloudflared`
reconnects outbound → tunnel up → `/health` returns 200 → the gate passes through.

### 3. Scale-down — on-box idle-stop (no CloudWatch, $0)

CloudWatch *custom* metrics cost money and `NetworkOut` is too noisy (the tunnel
keepalive + the `/health` probe never go quiet), so idle detection is on-box and free:

- The **API stamps a last-activity file** (`/state/last-activity`, epoch seconds)
  on startup and on every **real (non-`/health`) request**, throttled to once/10s.
  Excluding `/health` is essential — the compose healthcheck hits it every 10s.
- A **systemd timer** (`eventform-idle.timer`, every 5 min, after a 10-min
  post-boot grace) runs `idle-check.sh`: if `now − last_activity > 30 min`, it
  resolves its own ASG (IMDSv2 + `DescribeAutoScalingInstances`) and calls
  **`SetDesiredCapacity(0)`** — the ASG terminates the box.
- **Conservative on every failure** (missing/unreadable activity file, no IMDS,
  no ASG → do nothing): never kill a possibly-active box on a read error.
- The instance role is scoped to `SetDesiredCapacity` on its own ASG (by name
  pattern, to avoid an ASG↔launch-template↔role dependency cycle) + the describes.

## Data flow (happy path)

1. Visitor loads the SPA from Pages (always up); landing renders.
2. They open a gated route; `ApiHealthGate` probes `/health`.
3. Box is off → gate shows "Waking up the backend" **and** `POST`s `/wake` once
   (with their Cognito token).
4. API Gateway validates the JWT → Lambda → `SetDesiredCapacity(1)`.
5. ASG launches an instance (~2–4 min): userdata `docker compose up`; tunnel reconnects.
6. Gate's poll sees the first `/health` 200 → passes through to the app.
7. Each real request re-stamps the activity file, resetting the idle clock.
8. 30 min after the last real request, `idle-check.sh` → `SetDesiredCapacity(0)` → terminated.

## Cost model

- **Idle (desired 0):** ~$0 — no compute, no IPv4, no EBS.
- **Running:** `t4g.small` (ap-south-1) $0.0112/hr + IPv4 $0.005/hr, prorated by uptime.
- **Non-dollar cost:** the first authenticated visitor per idle window waits ~2–4 min (cold start).

## Security

- Wake is **authenticated** (Cognito JWT authorizer) — no open AWS surface.
- Wake Lambda + instance role are least-privilege: `SetDesiredCapacity` on the
  one ASG only; describes have no resource-level scoping (`*`), as AWS requires.
- No static AWS credentials anywhere (Lambda exec role + instance role).

## Testing

- **Wake decision** (`infra/cdk/lambda/wake/decide.mjs`): vitest unit tests for
  desired-0→start, already-up→running/pending, and missing-fields→start
  (`infra/cdk/test/wake-decide.test.ts`).
- **`idle-check.sh`**: a shell test (`infra/prod/idle-check.test.sh`) with stubbed
  `aws`/`curl` — asserts scale-down fires only past the threshold, and the
  conservative no-op cases (missing/garbage/empty activity file, near-threshold).
- **End-to-end (manual):** scale to 0 → load SPA, sign in → confirm wake fires,
  box boots, app loads → idle 30 min → confirm auto scale-to-0.

## Component / file layout

| Path | Purpose |
|---|---|
| `infra/cdk/lambda/wake/{index,decide}.mjs` | Wake Lambda (decision split out for tests) |
| `infra/cdk/lib/compute-stack.ts` | Wake Lambda + HTTP API + Cognito authorizer + ASG perms; idle systemd install in userdata |
| `apps/api/src/activity.ts` + `activity.interceptor.ts` | Last-activity stamp (startup + per real request) |
| `infra/compose/docker-compose.prod.yml` | `/state` volume + `ACTIVITY_FILE` for the api service |
| `infra/prod/idle-check.sh` (+ `.test.sh`) | Idle detection → `SetDesiredCapacity(0)` |
| `infra/systemd/eventform-idle.{service,timer}` | 5-min idle check (installed by userdata) |
| `apps/web/src/lib/api.ts` + `components/api-health-gate.tsx` | `requestWake()` + gate wiring; `VITE_WAKE_URL` |

## Operator steps

- Deploy ComputeStack with the Cognito config so the wake endpoint is provisioned:
  `-c cognitoIssuer=<issuer> -c cognitoClientId=<clientId>`.
- For the branded wake URL `api-gateway-ind.murugappan.dev/eventform/wake`: create
  a REGIONAL ACM cert (ap-south-1) for that host, DNS-validate it in Cloudflare,
  pass `-c wakeCertArn=<arn>`, then add `CNAME api-gateway-ind -> WakeDomainTarget`
  (DNS-only). Without the cert ARN the default execute-api `WakeUrl` is used.
- Set the SPA's **`VITE_WAKE_URL`** (Cloudflare Pages env) to the stack's
  `WakeUrl` output, then redeploy the SPA.
- The idle timer and state dir are installed automatically by the instance userdata.

## Open questions / risks

1. **Cold start (~2–4 min)** is inherent (Redpanda/Debezium/api boot + image
   pulls). A pre-baked AMI with images pre-pulled is a possible follow-up.
2. **Anonymous wake** is intentionally unsupported (Cognito-only). If public-form
   traffic needs to wake the box, add a separate rate-limited unauthenticated route.
