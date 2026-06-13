# EventForm Scale-to-Zero (wake-on-visit + idle auto-stop)

**Date:** 2026-06-13
**Status:** Design — pending review

## Overview

Run the EventForm backend on a metered **AWS EC2** instance that is **stopped
when idle and started on the first real visit**, so we pay for compute only
while someone is actually using the app. A stopped instance bills ~EBS only
(~$3.65/mo for 40 GB gp3 in ap-south-1); compute and the public IPv4 charge
accrue only while running.

This is viable for EventForm specifically because two pieces are already in
place:

- The **frontend is on Cloudflare Pages** (always up), so the site shell and the
  `ApiHealthGate` reconnect screen render even while the box is off.
- The **pipeline already survives abrupt stop/start.** EBS persists Postgres
  data, the Redpanda log, and the Debezium replication slot across a stop/start,
  and the worker's at-least-once + idempotent design tolerates being killed
  mid-flight. Boot simply runs `docker compose up` and the pipeline resumes.

## Goal & success criteria

- A stopped box costs ~EBS only; no compute, no IPv4 charge.
- A visitor hitting a backend-dependent route when the box is off triggers a
  start automatically (no manual action), sees the existing "waking up" screen,
  and lands in the app once it's ready (~2–4 min cold start).
- The box stops itself **30 minutes after the last real request**, so a visitor
  who browses for a while resets the timer and eats the cold start at most once.
- No new always-in-path dependency on the healthy request path; no change to the
  API proxy chain or the rate-limiter's `TRUST_PROXY` hop count.

## Non-goals

- Reducing the cold-start floor below ~2 min (Kafka/Debezium/Postgres boot is
  the limiting factor; out of scope — accepted via the hybrid 30-min idle policy).
- Serverless rearchitecture (Cloud Run / Neon / push events) — explicitly
  rejected earlier; it would replace the self-hosted CDC pipeline that is the
  point of the project.
- Multi-instance / autoscaling. This is a single box, zero-or-one.

## Assumptions

- The backend runs on a single **EC2** instance (ap-south-1, `t4g.medium` or
  similar Graviton), in a public subnet with auto-assigned public IPv4 (only
  billed while running; no Elastic IP — the tunnel needs no stable IP).
- Ingress is the existing **Cloudflare Tunnel** (`cloudflared` dials out); when
  the box is off the tunnel is down and the API hostname returns an origin error.
- Docker Compose prod stack as today (Postgres, Redpanda, Debezium, LocalStack,
  api, worker, caddy, cloudflared, backup).

## Architecture

Three cooperating pieces: **wake** (start), **boot** (come up), **idle-stop**
(power down).

### 1. Wake — W2 (SPA-driven) + C1 (scoped IAM key)

- **`ApiHealthGate` (existing, extended):** when it transitions to `down`, in
  addition to showing the reconnect page it fires **one** fire-and-forget POST to
  the wake endpoint per down-episode (client-side debounce so the 8-s poll loop
  doesn't re-fire it).
- **Wake Worker (new):** a standalone Cloudflare Worker at a dedicated hostname
  (`wake.eventform.murugappan.dev`), CORS-allowing the Pages origin. On request:
  1. `DescribeInstances` → read instance state.
  2. If `stopped`/`stopping`, call `StartInstances`; otherwise no-op.
  3. Return `{ state }`.
  - **Debounce:** a Workers KV key (`wake:lastfired`, ~60 s TTL) prevents repeat
    `StartInstances` calls during the boot window.
  - **Rate-limit:** per-IP limit on the Worker to cap abuse (worst case is a
    running box, bounded by idle-stop — not a breach).
  - AWS calls signed with `aws4fetch` using the scoped IAM key (Worker secret).
- **IAM user (C1):** policy allows only `ec2:StartInstances` and
  `ec2:DescribeInstances` on the single instance ARN. Access key + secret stored
  as Worker secrets. Provisioned via **CDK** (new `ScaleToZeroStack`, consistent
  with the existing IaC), which outputs the access key for one-time entry into
  the Worker.
- The cold-start UX is unchanged: the existing gate polls `/health` every 8 s and
  passes through once it returns 200. The email fallback remains for the case
  where the box never comes up.

### 2. Boot — self-starting stack

- A **systemd unit** (`eventform.service`, oneshot, `WantedBy=multi-user.target`)
  runs `docker compose -f /opt/eventform/infra/compose/docker-compose.prod.yml up -d`
  on every boot, so a started instance brings the whole stack up with no SSH.
- `cloudflared` reconnects outbound → tunnel back up → `/health` returns 200.
- Durable EBS volumes mean Postgres/Redpanda/Debezium resume with state intact;
  the retry scheduler fires any deliveries that came due while stopped.

### 3. Idle-stop — S1 (request-activity, on-box)

- A **systemd timer** (`eventform-idle.timer`, every 5 min) runs
  `infra/prod/idle-check.sh`.
- The script reads the **Caddy access log**, finds the most recent request
  **excluding `/health`** (health probes must not count as activity, or the box
  never idles), and if `now − last_real_request > 30 min`, runs `shutdown`.
- **Conservative failure mode:** if the log is unreadable/empty or the timestamp
  can't be parsed, **do not** shut down (never kill a possibly-active box on a
  read error).
- **Instance config (critical):** `InstanceInitiatedShutdownBehavior = stop`
  (not `terminate`) so `shutdown` stops the box and preserves the EBS volumes.
  Set in CDK / at launch.
- Shutdown is graceful: host shutdown stops the containers (SIGTERM → the
  worker's `consumer.disconnect()` drains in-flight work, as already built);
  durability covers the abrupt case regardless.

## Data flow (happy path)

1. Visitor loads the SPA from Pages (always up); landing renders.
2. They open a gated route (`/login`, `/forms/:slug`, `/app`). `ApiHealthGate`
   probes `/health`.
3. Box is off → gate shows "Waking up the backend" **and** POSTs the wake
   endpoint once.
4. Wake Worker: `DescribeInstances` → stopped → `StartInstances` (debounced).
5. EC2 boots (~2–4 min): `eventform.service` runs `docker compose up`; tunnel
   reconnects.
6. Gate keeps polling `/health`; first 200 → passes through to the app.
7. Each real request is logged by Caddy, resetting the idle clock.
8. 30 min after the last real request, `idle-check.sh` runs `shutdown` → stopped.

## Cost model

- **Stopped:** ~$3.65/mo (40 GB gp3 EBS) + $0 compute + $0 IPv4.
- **Running:** `t4g.medium` $0.0224/hr + IPv4 $0.005/hr, prorated by uptime.
- **Example (~2 hr/day active):** ~$5/mo all-in — undercuts the €8 flat VPS.
- **Crossover:** heavier/steadier traffic pushes uptime up; past ~10–12 hr/day
  the flat VPS becomes cheaper again. This suits a bursty recruiter-portfolio
  profile, not a steadily-trafficked app.
- **Non-dollar cost:** the first visitor in each idle window waits ~2–4 min.

## Error handling

| Case | Behavior |
|---|---|
| Wake Worker can't reach AWS / `StartInstances` fails | Return 503; gate keeps polling + showing reconnect; email fallback stands; logged in Worker observability |
| `StartInstances` while already pending/running | No-op; KV debounce prevents repeat calls |
| Boot fails (compose error) | Box up but `/health` never 200 → gate reconnects indefinitely → email fallback (same as a failed deploy) |
| Idle script can't read/parse log | Do **not** shut down (conservative) |
| Wake endpoint abuse | Per-IP rate-limit + KV debounce; worst case is a running box, capped by idle-stop; scoped IAM = no breach |

## Security

- IAM user scoped to `ec2:StartInstances` + `ec2:DescribeInstances` on **one**
  instance ARN; credentials live only as Worker secrets.
- Wake Worker rate-limited and debounced.
- `InstanceInitiatedShutdownBehavior=stop` protects against accidental
  termination / data loss.
- No new credentials on the box; no change to the API auth or proxy chain.

## Testing

- **Wake Worker:** unit-test the decision logic (instance state → action) with a
  mocked AWS fetch; verify debounce and CORS. (LocalStack EC2 support is
  unreliable, so AWS calls are mocked rather than integration-tested.)
- **`idle-check.sh`:** unit-test against fixture access logs — last-real-request
  parsing, `/health` exclusion, the 30-min threshold, and the empty/unparseable
  → no-shutdown safety case.
- **systemd units:** manual verification — `stop` → `start` → `/health` 200
  within the expected window; idle 30 min → instance `stopped`.
- **End-to-end (manual, on the box):** stop instance → load SPA → confirm wake
  fires, box boots, app loads → idle 30 min → confirm auto-stop.

## Component / file layout

| Path | Purpose |
|---|---|
| `infra/wake-worker/` | Cloudflare Worker (`wrangler.toml`, `src/index.ts`, tests); `aws4fetch` |
| `infra/systemd/eventform.service` | Boot: `docker compose up -d` |
| `infra/systemd/eventform-idle.{service,timer}` | 5-min idle check |
| `infra/prod/idle-check.sh` | Last-real-request detection + `shutdown` |
| `apps/web/src/lib/api.ts` | `requestWake()` — POST to wake endpoint |
| `apps/web/src/components/api-health-gate.tsx` | Fire wake once on `down` (debounced) |
| `infra/cdk/lib/stacks/scale-to-zero-stack.ts` | IAM user + scoped policy (IaC) |
| `docs/DEPLOYMENT.md` | Scale-to-zero setup: IAM, Worker deploy, systemd install, shutdown-behavior |

## Manual / dashboard steps (can't be scripted from here)

- Deploy the Wake Worker (`wrangler deploy`) and set its secrets (IAM key,
  instance ID, region); bind `wake.eventform.murugappan.dev`.
- Set the EC2 instance's shutdown behavior to `stop` (CDK if the instance is
  managed there; otherwise `aws ec2 modify-instance-attribute`).
- Install the systemd units on the box (the deploy flow / cloud-init copies them).

## Open questions / risks

1. **Cold-start length** is inherent (~2–4 min). Accepted via the hybrid policy;
   if it proves too long in practice, a pre-baked AMI with images pre-pulled is a
   follow-up, not part of this design.
2. **Is the EC2 instance managed in CDK?** Today the box is provisioned manually
   (cloud-init). The IAM user is CDK; the instance itself may stay manual. The
   shutdown-behavior step adapts accordingly.
3. **Wake endpoint hostname:** dedicated `wake.eventform.murugappan.dev` to avoid
   Pages/Worker route conflicts on the apex; `*.workers.dev` is the fallback.
