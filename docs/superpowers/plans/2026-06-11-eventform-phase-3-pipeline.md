# Eventform Phase 3 — CDC Pipeline & Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the event loop: Debezium captures `outbox` inserts from the Postgres WAL, routes them through Kafka, and a NestJS worker delivers HMAC-signed webhooks idempotently with automatic backoff retries — so a public form submission ends as a signed HTTP POST at the tenant's endpoint with zero dual-write risk.

**Architecture:** Single-node Kafka (KRaft, 256 MB heap) + Kafka Connect/Debezium (pgoutput, outbox EventRouter SMT → topic `eventform.events`, key = `aggregate_id` for per-delivery ordering, `snapshot.mode=no_data`). `apps/worker` (NestJS, port 3002) consumes with manual offset commits (at-least-once): each message runs ONE DB transaction — claim `processed_events` (idempotency), `SELECT ... FOR UPDATE` the delivery, decrypt the endpoint secret via KMS (≤5-min cache), POST with HMAC headers, record the attempt, advance the status machine (`delivered` | `retrying`+backoff | `failed` after 3). A 5-second scheduler claims due retries with `FOR UPDATE SKIP LOCKED` and re-emits them through the outbox (same path as manual retry). A cleanup job prunes captured outbox rows. The worker connects as `app_worker` (BYPASSRLS — trusted internal). Branch: `feat/phase-3-pipeline`.

**Tech Stack:** apache/kafka 3.9 (KRaft), quay.io/debezium/connect 3.0, kafkajs ^2.2, NestJS 11 (same vitest+SWC setup as apps/api), `@eventform/db` + `@eventform/shared`.

**Spec:** `docs/superpowers/specs/2026-06-11-eventform-design.md` (§Event flow, §Consumer, §Retries)
**Prereqs:** Phase 2 complete (94 tests green).

**Design decisions locked here:**
- Backoff: attempt 1 fails → +5 s; attempt 2 fails → +30 s; attempt 3 fails → `failed` (manual retry resets the budget). `attemptNo = delivery.attempt_count + 1` is derived from the DB row under lock, never trusted from the payload.
- Poison pills: a message that fails `submissionReceivedSchema.parse` is logged and ACKED (skipped) — a malformed event must not crash-loop the consumer. Real processing errors (DB down) are NOT acked → redelivery.
- Endpoint `active=false` does not block delivery of EXISTING deliveries (submission-time filtering already skips inactive endpoints; manual retries are explicit human actions).
- Debezium connects as the `eventform` superuser (demo simplification — REPLICATION privilege; a dedicated replication role is a prod nicety noted for Phase 5).
- Worker consumer group `eventform-worker` starts from LATEST (`fromBeginning: false`): backlog produced while the worker was down in dev/test is not replayed onto third-party URLs.
- Webhook timeout configurable (`WEBHOOK_TIMEOUT_MS`, default 10000; tests use ~1000).

## File structure

```
infra/compose/docker-compose.yml      + kafka, connect services
infra/compose/connect/eventform-outbox.json    Debezium connector config
infra/compose/connect/register-connector.sh    idempotent PUT to /connectors
apps/worker/
  package.json, tsconfig.json, nest-cli.json, vitest.config.ts
  src/main.ts                          bootstrap, port 3002
  src/app.module.ts
  src/config.ts                        env access (worker variant)
  src/health.controller.ts
  src/db.module.ts                     WORKER_POOL + SECRET_CIPHER providers
  src/webhook/webhook-sender.service.ts   HMAC POST + timeout; SecretCache
  src/processor/delivery-processor.service.ts  idempotent event processing (the core)
  src/processor/backoff.ts             nextRetryDelayMs(attemptNo)
  src/kafka/kafka-consumer.service.ts  kafkajs wiring, manual commits
  src/scheduler/retry-scheduler.service.ts     SKIP LOCKED claim + outbox re-emit
  src/scheduler/outbox-cleanup.service.ts      prune captured rows
  test/test-server.ts                  local HTTP receiver (capture + fail-mode)
  test/backoff.test.ts
  test/webhook-sender.test.ts
  test/delivery-processor.test.ts      against real DB + local server (no Kafka needed)
  test/retry-scheduler.test.ts
  test/pipeline.e2e.test.ts            outbox insert → Kafka → webhook received
```

---

### Task 1: Kafka + Connect in docker-compose

**Files:**
- Modify: `infra/compose/docker-compose.yml`
- Modify: `.env.example`

- [ ] **Step 1: Add the two services to `infra/compose/docker-compose.yml`**

```yaml
  kafka:
    image: apache/kafka:3.9.0
    restart: unless-stopped
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093
      KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093,EXTERNAL://:29092
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092,EXTERNAL://localhost:29092
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT,EXTERNAL:PLAINTEXT
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: "true"
      KAFKA_LOG_RETENTION_HOURS: 24
      KAFKA_HEAP_OPTS: -Xmx256m -Xms128m
    ports:
      - "127.0.0.1:29092:29092"
    healthcheck:
      test: ["CMD-SHELL", "/opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server localhost:9092 > /dev/null 2>&1"]
      interval: 10s
      timeout: 10s
      retries: 12
      start_period: 20s

  connect:
    image: quay.io/debezium/connect:3.0
    restart: unless-stopped
    depends_on:
      kafka:
        condition: service_healthy
      postgres:
        condition: service_healthy
    environment:
      BOOTSTRAP_SERVERS: kafka:9092
      GROUP_ID: eventform-connect
      CONFIG_STORAGE_TOPIC: connect_configs
      OFFSET_STORAGE_TOPIC: connect_offsets
      STATUS_STORAGE_TOPIC: connect_statuses
      CONNECT_KEY_CONVERTER_SCHEMAS_ENABLE: "false"
      CONNECT_VALUE_CONVERTER_SCHEMAS_ENABLE: "false"
      KAFKA_HEAP_OPTS: -Xmx384m -Xms256m
    ports:
      - "127.0.0.1:8083:8083"
    healthcheck:
      test: ["CMD-SHELL", "curl -fs http://localhost:8083/connectors > /dev/null"]
      interval: 10s
      timeout: 5s
      retries: 18
      start_period: 30s
```

- [ ] **Step 2: Add to `.env.example`** (under a `# pipeline` header): `KAFKA_BROKERS=localhost:29092`, `CONNECT_URL=http://localhost:8083`, `WORKER_PORT=3002`, `WEBHOOK_TIMEOUT_MS=10000`.

- [ ] **Step 3: Boot and verify** — `pnpm db:up && docker compose -f infra/compose/docker-compose.yml ps` → all four services `(healthy)` (kafka and connect take ~30–60 s; poll).

- [ ] **Step 4: Commit** — `git add infra/compose .env.example && git commit -m "chore: add kafka and debezium connect compose services"`

---

### Task 2: Debezium outbox connector

**Files:**
- Create: `infra/compose/connect/eventform-outbox.json`
- Create: `infra/compose/connect/register-connector.sh`
- Modify: root `package.json` (script `connect:register`)

- [ ] **Step 1: Write `infra/compose/connect/eventform-outbox.json`**

```json
{
  "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
  "database.hostname": "postgres",
  "database.port": "5432",
  "database.user": "eventform",
  "database.password": "eventform",
  "database.dbname": "eventform",
  "topic.prefix": "eventform",
  "plugin.name": "pgoutput",
  "slot.name": "eventform_outbox",
  "publication.name": "eventform_outbox_pub",
  "publication.autocreate.mode": "filtered",
  "snapshot.mode": "no_data",
  "table.include.list": "public.outbox",
  "tombstones.on.delete": "false",
  "transforms": "outbox",
  "transforms.outbox.type": "io.debezium.transforms.outbox.EventRouter",
  "transforms.outbox.table.field.event.id": "id",
  "transforms.outbox.table.field.event.key": "aggregate_id",
  "transforms.outbox.table.field.event.payload": "payload",
  "transforms.outbox.table.expand.json.payload": "true",
  "transforms.outbox.route.by.field": "aggregate_type",
  "transforms.outbox.route.topic.replacement": "eventform.events",
  "key.converter": "org.apache.kafka.connect.storage.StringConverter",
  "value.converter": "org.apache.kafka.connect.json.JsonConverter",
  "value.converter.schemas.enable": "false"
}
```

- [ ] **Step 2: Write `infra/compose/connect/register-connector.sh`** (executable)

```bash
#!/bin/bash
# Idempotent: PUT to /connectors/<name>/config creates or updates.
set -euo pipefail
CONNECT_URL="${CONNECT_URL:-http://localhost:8083}"
DIR="$(cd "$(dirname "$0")" && pwd)"

curl -fsS -X PUT \
  -H "Content-Type: application/json" \
  --data @"$DIR/eventform-outbox.json" \
  "$CONNECT_URL/connectors/eventform-outbox/config" > /dev/null

echo "connector registered; status:"
curl -fsS "$CONNECT_URL/connectors/eventform-outbox/status"
echo
```

- [ ] **Step 3: Root script** — add `"connect:register": "infra/compose/connect/register-connector.sh"` to root package.json scripts.

- [ ] **Step 4: Register and verify end-to-end capture**

```bash
pnpm connect:register   # expect status RUNNING (task may take a few seconds; re-check)
# insert a probe outbox row and watch the topic:
docker compose -f infra/compose/docker-compose.yml exec postgres psql -U eventform -d eventform -c \
  "INSERT INTO outbox (tenant_id, aggregate_type, aggregate_id, event_type, payload) VALUES (gen_random_uuid(), 'delivery', gen_random_uuid(), 'probe', '{\"hello\":\"world\"}'::jsonb);"
docker compose -f infra/compose/docker-compose.yml exec kafka \
  /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 \
  --topic eventform.events --from-beginning --max-messages 1 --timeout-ms 30000
```
Expected: one message whose value contains `"hello":"world"` (payload expanded, envelope stripped). Delete the probe row after:
`... psql -c "DELETE FROM outbox WHERE event_type = 'probe';"`

- [ ] **Step 5: Commit** — `git add infra/compose package.json && git commit -m "feat(pipeline): add debezium outbox connector with event router"`

---

### Task 3: Worker app scaffold

**Files:**
- Create: `apps/worker/package.json`, `tsconfig.json`, `nest-cli.json`, `vitest.config.ts`
- Create: `apps/worker/src/main.ts`, `app.module.ts`, `config.ts`, `health.controller.ts`, `db.module.ts`
- Test: `apps/worker/test/health.e2e.test.ts`

- [ ] **Step 1: `apps/worker/package.json`**

```json
{
  "name": "@eventform/worker",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "build": "nest build",
    "start": "node dist/main.js",
    "start:dev": "nest start --watch",
    "test": "vitest run"
  },
  "dependencies": {
    "@eventform/db": "workspace:*",
    "@eventform/shared": "workspace:*",
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "drizzle-orm": "^0.44.0",
    "kafkajs": "^2.2.0",
    "pg": "^8.16.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.0"
  },
  "devDependencies": {
    "@nestjs/cli": "^11.0.0",
    "@nestjs/testing": "^11.0.0",
    "@swc/core": "^1.10.0",
    "@types/express": "^5.0.0",
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0",
    "@types/supertest": "^6.0.0",
    "supertest": "^7.0.0",
    "typescript": "^5.8.0",
    "unplugin-swc": "^1.5.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: `tsconfig.json`, `nest-cli.json`, `vitest.config.ts`** — identical content to the apps/api versions (copy them; the vitest SWC decorator config is load-bearing). vitest config: same flags (`fileParallelism: false`, `testTimeout: 20000`, `passWithNoTests: true`) plus include pattern `test/**/*.test.ts`.

- [ ] **Step 3: `apps/worker/src/config.ts`**

```ts
export interface WorkerConfig {
  port: number;
  databaseUrlWorker: string;
  databaseUrlAdmin: string;
  kafkaBrokers: string[];
  kmsKeyId: string;
  awsEndpointUrl: string;
  awsRegion: string;
  webhookTimeoutMs: number;
  retryPollMs: number;
  outboxRetentionHours: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    port: Number(env.WORKER_PORT ?? 3002),
    databaseUrlWorker:
      env.DATABASE_URL_WORKER ?? "postgres://app_worker:app_worker_dev@localhost:5432/eventform",
    databaseUrlAdmin:
      env.DATABASE_URL ?? "postgres://eventform:eventform@localhost:5432/eventform",
    kafkaBrokers: (env.KAFKA_BROKERS ?? "localhost:29092").split(","),
    kmsKeyId: env.KMS_KEY_ID ?? "alias/eventform-endpoint-secrets",
    // LocalStack KMS in dev AND prod (EC2: http://localstack:4566 via Phase 5 compose).
    awsEndpointUrl: env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
    awsRegion: env.AWS_REGION ?? "us-east-1",
    webhookTimeoutMs: Number(env.WEBHOOK_TIMEOUT_MS ?? 10000),
    retryPollMs: Number(env.RETRY_POLL_MS ?? 5000),
    outboxRetentionHours: Number(env.OUTBOX_RETENTION_HOURS ?? 24),
  };
}
```

- [ ] **Step 4: `apps/worker/src/db.module.ts`**

```ts
import { Global, Inject, Module, OnApplicationShutdown } from "@nestjs/common";
import { Pool } from "pg";
import { createPool } from "@eventform/db";
import { SecretCipher } from "@eventform/shared";
import { loadConfig } from "./config";

export const WORKER_POOL = "WORKER_POOL";
export const SECRET_CIPHER = "SECRET_CIPHER";

@Global()
@Module({
  providers: [
    {
      provide: WORKER_POOL,
      useFactory: (): Pool => createPool(loadConfig().databaseUrlWorker),
    },
    {
      provide: SECRET_CIPHER,
      useFactory: (): SecretCipher => {
        const cfg = loadConfig();
        return new SecretCipher({
          keyId: cfg.kmsKeyId,
          endpoint: cfg.awsEndpointUrl,
          region: cfg.awsRegion,
        });
      },
    },
  ],
  exports: [WORKER_POOL, SECRET_CIPHER],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(WORKER_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
```

- [ ] **Step 5: `health.controller.ts`** (no auth in the worker — it exposes ONLY /health):

```ts
import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  @Get()
  health() {
    return { status: "ok" };
  }
}
```

- [ ] **Step 6: `app.module.ts`** (minimal: DbModule + HealthController; later tasks extend) and `main.ts` (mirror apps/api main.ts but `loadConfig().port` from worker config).

```ts
// app.module.ts
import { Module } from "@nestjs/common";
import { DbModule } from "./db.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [DbModule],
  controllers: [HealthController],
})
export class AppModule {}
```

```ts
// main.ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadConfig } from "./config";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(loadConfig().port);
}

void bootstrap();
```

- [ ] **Step 7: e2e `apps/worker/test/health.e2e.test.ts`** — same shape as the api health e2e (Test.createTestingModule → GET /health → `{status:"ok"}`).

- [ ] **Step 8:** `pnpm install && pnpm --filter @eventform/worker test` (1 green) && `pnpm --filter @eventform/worker build`. Commit: `git add apps/worker pnpm-lock.yaml && git commit -m "feat(worker): scaffold nestjs worker app"`

---

### Task 4: Backoff + webhook sender with secret cache (TDD)

**Files:**
- Create: `apps/worker/src/processor/backoff.ts`
- Create: `apps/worker/src/webhook/webhook-sender.service.ts`
- Create: `apps/worker/test/test-server.ts`
- Test: `apps/worker/test/backoff.test.ts`, `apps/worker/test/webhook-sender.test.ts`

- [ ] **Step 1: Failing tests.** `backoff.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, nextRetryDelayMs } from "../src/processor/backoff";

describe("backoff", () => {
  it("is 5s after the first failed attempt", () => {
    expect(nextRetryDelayMs(1)).toBe(5_000);
  });
  it("is 30s after the second failed attempt", () => {
    expect(nextRetryDelayMs(2)).toBe(30_000);
  });
  it("is null at the attempt cap (terminal)", () => {
    expect(nextRetryDelayMs(3)).toBeNull();
    expect(MAX_ATTEMPTS).toBe(3);
  });
});
```

`test-server.ts` (shared by sender/processor/pipeline tests — NOT a test file):

```ts
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

export interface ReceivedWebhook {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface TestServer {
  url: string;
  received: ReceivedWebhook[];
  /** Next responses return this status (sticky until changed). */
  setStatus: (status: number) => void;
  /** When set, the server delays responses by this many ms. */
  setDelayMs: (ms: number) => void;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const received: ReceivedWebhook[] = [];
  let status = 200;
  let delayMs = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      setTimeout(() => {
        res.statusCode = status;
        res.end(JSON.stringify({ ok: status < 300 }));
      }, delayMs);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    setStatus: (s) => (status = s),
    setDelayMs: (ms) => (delayMs = ms),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
```

`webhook-sender.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SecretCipher, verifyWebhook } from "@eventform/shared";
import { WebhookSender } from "../src/webhook/webhook-sender.service";
import { startTestServer, TestServer } from "./test-server";

const cipher = new SecretCipher({
  keyId: "alias/eventform-endpoint-secrets",
  endpoint: "http://localhost:4566",
  region: "us-east-1",
});

describe("WebhookSender", () => {
  let server: TestServer;
  const tenantId = randomUUID();
  const secret = "whsec_" + "ab".repeat(24);
  let ciphertext: string;

  beforeAll(async () => {
    server = await startTestServer();
    ciphertext = await cipher.encrypt(secret, tenantId);
  });

  afterAll(async () => {
    await server.close();
  });

  function sender(timeoutMs = 2000) {
    return new WebhookSender(cipher, timeoutMs);
  }

  it("POSTs a payload with verifiable HMAC headers", async () => {
    const body = { eventId: randomUUID(), hello: "world" };
    const result = await sender().send({
      url: server.url,
      secretCiphertext: ciphertext,
      tenantId,
      endpointId: randomUUID(),
      payload: body,
    });
    expect(result.ok).toBe(true);
    expect(result.responseCode).toBe(200);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const hit = server.received.at(-1)!;
    expect(hit.headers["x-eventform-event-id"]).toBe(body.eventId);
    const ok = verifyWebhook({
      secret,
      timestamp: hit.headers["x-eventform-timestamp"] as string,
      body: hit.body,
      signature: hit.headers["x-eventform-signature"] as string,
    });
    expect(ok).toBe(true);
    expect(JSON.parse(hit.body)).toEqual(body);
  });

  it("reports non-2xx as failure with the status code", async () => {
    server.setStatus(500);
    const result = await sender().send({
      url: server.url,
      secretCiphertext: ciphertext,
      tenantId,
      endpointId: randomUUID(),
      payload: { x: 1 },
    });
    expect(result.ok).toBe(false);
    expect(result.responseCode).toBe(500);
    server.setStatus(200);
  });

  it("times out and reports an error without a response code", async () => {
    server.setDelayMs(1500);
    const result = await sender(300).send({
      url: server.url,
      secretCiphertext: ciphertext,
      tenantId,
      endpointId: randomUUID(),
      payload: { x: 1 },
    });
    expect(result.ok).toBe(false);
    expect(result.responseCode).toBeNull();
    expect(result.error).toMatch(/abort|timeout/i);
    server.setDelayMs(0);
  });

  it("reports connection refusal as failure", async () => {
    const result = await sender().send({
      url: "http://127.0.0.1:1/hook",
      secretCiphertext: ciphertext,
      tenantId,
      endpointId: randomUUID(),
      payload: { x: 1 },
    });
    expect(result.ok).toBe(false);
    expect(result.responseCode).toBeNull();
  });

  it("caches decrypted secrets per endpoint+ciphertext", async () => {
    const endpointId = randomUUID();
    const spy = { count: 0 };
    const countingCipher = {
      decrypt: async (ct: string, t: string) => {
        spy.count += 1;
        return cipher.decrypt(ct, t);
      },
    } as unknown as SecretCipher;
    const s = new WebhookSender(countingCipher, 2000);
    const args = { url: server.url, secretCiphertext: ciphertext, tenantId, endpointId, payload: { a: 1 } };
    await s.send(args);
    await s.send(args);
    expect(spy.count).toBe(1);
    // rotation: a different ciphertext busts the cache entry
    const rotated = await cipher.encrypt("whsec_" + "cd".repeat(24), tenantId);
    await s.send({ ...args, secretCiphertext: rotated });
    expect(spy.count).toBe(2);
  });
});
```

- [ ] **Step 2: Red** (LocalStack must be up for KMS).

- [ ] **Step 3: `apps/worker/src/processor/backoff.ts`**

```ts
export const MAX_ATTEMPTS = 3;

const DELAYS_MS = [5_000, 30_000];

/** Delay before the NEXT attempt, given the attempt number that just failed; null = terminal. */
export function nextRetryDelayMs(failedAttemptNo: number): number | null {
  if (failedAttemptNo >= MAX_ATTEMPTS) {
    return null;
  }
  return DELAYS_MS[failedAttemptNo - 1] ?? DELAYS_MS[DELAYS_MS.length - 1];
}
```

- [ ] **Step 4: `apps/worker/src/webhook/webhook-sender.service.ts`**

```ts
import { Inject, Injectable } from "@nestjs/common";
import { SecretCipher, signWebhook } from "@eventform/shared";
import { SECRET_CIPHER } from "../db.module";

export interface SendArgs {
  url: string;
  secretCiphertext: string;
  tenantId: string;
  endpointId: string;
  payload: unknown;
}

export interface SendResult {
  ok: boolean;
  responseCode: number | null;
  error: string | null;
  durationMs: number;
}

interface CacheEntry {
  ciphertext: string;
  secret: string;
  expiresAt: number;
}

const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class WebhookSender {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipher,
    private readonly timeoutMs: number = 10_000,
  ) {}

  private async secretFor(args: SendArgs): Promise<string> {
    const entry = this.cache.get(args.endpointId);
    const now = Date.now();
    if (entry && entry.ciphertext === args.secretCiphertext && entry.expiresAt > now) {
      return entry.secret;
    }
    const secret = await this.cipher.decrypt(args.secretCiphertext, args.tenantId);
    this.cache.set(args.endpointId, {
      ciphertext: args.secretCiphertext,
      secret,
      expiresAt: now + SECRET_CACHE_TTL_MS,
    });
    return secret;
  }

  async send(args: SendArgs): Promise<SendResult> {
    const started = Date.now();
    try {
      const secret = await this.secretFor(args);
      const body = JSON.stringify(args.payload);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const eventId =
        typeof args.payload === "object" && args.payload !== null && "eventId" in args.payload
          ? String((args.payload as { eventId: unknown }).eventId)
          : "";

      const res = await fetch(args.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "eventform-webhook/1.0",
          "x-eventform-event-id": eventId,
          "x-eventform-timestamp": timestamp,
          "x-eventform-signature": signWebhook(secret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "manual",
      });
      // drain the body so the socket is released
      await res.arrayBuffer().catch(() => undefined);
      return {
        ok: res.status >= 200 && res.status < 300,
        responseCode: res.status,
        error: res.status >= 200 && res.status < 300 ? null : `http ${res.status}`,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        responseCode: null,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        durationMs: Date.now() - started,
      };
    }
  }
}
```

- [ ] **Step 5: Green** — `pnpm --filter @eventform/worker test` (backoff 3 + sender 5 + health 1 = 9). Commit: `git add apps/worker && git commit -m "feat(worker): webhook sender with hmac signing and secret cache"`

---

### Task 5: Delivery processor — the idempotent core (TDD)

**Files:**
- Create: `apps/worker/src/processor/delivery-processor.service.ts`
- Test: `apps/worker/test/delivery-processor.test.ts`
- Modify: `apps/worker/src/app.module.ts` (providers: WebhookSender via factory with config timeout, DeliveryProcessor)

The processor is Kafka-agnostic: it takes a parsed `SubmissionReceivedEvent` and runs the
one-transaction algorithm. Tests hit the real DB and the local test server — no Kafka.

- [ ] **Step 1: Failing test `apps/worker/test/delivery-processor.test.ts`**

Fixtures are seeded via the ADMIN pool (worker never creates forms): tenant → form →
endpoint (real ciphertext via SecretCipher) → submission → delivery(pending) + matching
event payload, mirroring what the API writes.

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPool } from "@eventform/db";
import { SecretCipher, SubmissionReceivedEvent } from "@eventform/shared";
import { DeliveryProcessor } from "../src/processor/delivery-processor.service";
import { WebhookSender } from "../src/webhook/webhook-sender.service";
import { startTestServer, TestServer } from "./test-server";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://eventform:eventform@localhost:5432/eventform";
const WORKER_URL =
  process.env.DATABASE_URL_WORKER ?? "postgres://app_worker:app_worker_dev@localhost:5432/eventform";

const cipher = new SecretCipher({
  keyId: "alias/eventform-endpoint-secrets",
  endpoint: "http://localhost:4566",
  region: "us-east-1",
});

describe("DeliveryProcessor", () => {
  let admin: Pool;
  let workerPool: Pool;
  let server: TestServer;
  let processor: DeliveryProcessor;
  const tenantId = randomUUID();
  const cleanupTenants = [tenantId];

  async function seed(opts: { url?: string } = {}) {
    const formId = randomUUID();
    const endpointId = randomUUID();
    const submissionId = randomUUID();
    const deliveryId = randomUUID();
    const eventId = randomUUID();
    const secret = "whsec_" + "ee".repeat(24);
    const ciphertext = await cipher.encrypt(secret, tenantId);

    await admin.query(
      "INSERT INTO forms (id, tenant_id, title, status, public_slug) VALUES ($1,$2,'Proc form','published',$3)",
      [formId, tenantId, `proc-${randomUUID()}`],
    );
    await admin.query(
      "INSERT INTO endpoints (id, tenant_id, name, url, secret_ciphertext) VALUES ($1,$2,'ep',$3,$4)",
      [endpointId, tenantId, opts.url ?? server.url, ciphertext],
    );
    await admin.query(
      "INSERT INTO submissions (id, form_id, tenant_id, answers) VALUES ($1,$2,$3,'{\"Q\":\"A\"}'::jsonb)",
      [submissionId, formId, tenantId],
    );
    await admin.query(
      "INSERT INTO deliveries (id, tenant_id, endpoint_id, submission_id, event_id) VALUES ($1,$2,$3,$4,$5)",
      [deliveryId, tenantId, endpointId, submissionId, eventId],
    );
    const event: SubmissionReceivedEvent = {
      eventId,
      type: "submission.received",
      attempt: 1,
      tenantId,
      formId,
      formTitle: "Proc form",
      submissionId,
      endpointId,
      deliveryId,
      answers: { Q: "A" },
      submittedAt: new Date().toISOString(),
    };
    return { event, deliveryId, eventId, secret };
  }

  async function delivery(id: string) {
    const res = await admin.query("SELECT * FROM deliveries WHERE id = $1", [id]);
    return res.rows[0];
  }

  beforeAll(async () => {
    admin = createPool(ADMIN_URL);
    workerPool = createPool(WORKER_URL);
    server = await startTestServer();
    await admin.query("INSERT INTO tenants (id, name, cognito_sub) VALUES ($1,'proc',$2)", [
      tenantId,
      `proc-${randomUUID()}`,
    ]);
    processor = new DeliveryProcessor(workerPool, new WebhookSender(cipher, 1000));
  });

  afterAll(async () => {
    for (const table of ["outbox", "processed_events", "delivery_attempts", "deliveries", "submissions", "endpoints", "form_fields", "forms"]) {
      await admin.query(
        table === "processed_events"
          ? "DELETE FROM processed_events WHERE TRUE" // pruned per-test below; safe final sweep
          : `DELETE FROM ${table} WHERE tenant_id = ANY($1)`,
        table === "processed_events" ? [] : [cleanupTenants],
      );
    }
    await admin.query("DELETE FROM tenants WHERE id = ANY($1)", [cleanupTenants]);
    await server.close();
    await admin.end();
    await workerPool.end();
  });

  it("delivers, records the attempt, and marks delivered", async () => {
    const { event, deliveryId } = await seed();
    const outcome = await processor.process(event);
    expect(outcome).toBe("delivered");

    const row = await delivery(deliveryId);
    expect(row.status).toBe("delivered");
    expect(row.attempt_count).toBe(1);
    expect(row.response_code).toBe(200);
    expect(row.delivered_at).not.toBeNull();

    const attempts = await admin.query(
      "SELECT * FROM delivery_attempts WHERE delivery_id = $1", [deliveryId]);
    expect(attempts.rowCount).toBe(1);
    expect(attempts.rows[0]).toMatchObject({ attempt_no: 1, response_code: 200 });
  });

  it("is idempotent: a duplicate event sends exactly one webhook", async () => {
    const { event } = await seed();
    const before = server.received.length;
    expect(await processor.process(event)).toBe("delivered");
    expect(await processor.process(event)).toBe("duplicate");
    expect(server.received.length).toBe(before + 1);
  });

  it("schedules a retry with +5s backoff on first failure", async () => {
    server.setStatus(500);
    const { event, deliveryId } = await seed();
    expect(await processor.process(event)).toBe("retry_scheduled");
    const row = await delivery(deliveryId);
    expect(row.status).toBe("retrying");
    expect(row.attempt_count).toBe(1);
    expect(row.last_error).toContain("500");
    const deltaMs = new Date(row.next_retry_at).getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(2_000);
    expect(deltaMs).toBeLessThan(8_000);
    server.setStatus(200);
  });

  it("marks failed after the third failed attempt", async () => {
    server.setStatus(500);
    const { event, deliveryId } = await seed();
    await admin.query("UPDATE deliveries SET attempt_count = 2, status = 'pending' WHERE id = $1", [deliveryId]);
    expect(await processor.process(event)).toBe("failed");
    const row = await delivery(deliveryId);
    expect(row.status).toBe("failed");
    expect(row.attempt_count).toBe(3);
    server.setStatus(200);
  });

  it("skips terminal deliveries without sending", async () => {
    const { event, deliveryId } = await seed();
    await admin.query("UPDATE deliveries SET status = 'failed' WHERE id = $1", [deliveryId]);
    const before = server.received.length;
    expect(await processor.process(event)).toBe("stale");
    expect(server.received.length).toBe(before);
  });

  it("claims orphan events (delivery row missing) without crashing", async () => {
    const { event } = await seed();
    await admin.query("DELETE FROM delivery_attempts WHERE delivery_id = $1", [event.deliveryId]);
    await admin.query("DELETE FROM deliveries WHERE id = $1", [event.deliveryId]);
    expect(await processor.process(event)).toBe("orphan");
    expect(await processor.process(event)).toBe("duplicate");
  });

  it("a crash between send and commit re-sends on redelivery (at-least-once)", async () => {
    const { event } = await seed();
    const sender = new WebhookSender(cipher, 1000);
    const exploding = new DeliveryProcessor(workerPool, sender, {
      afterSendHook: () => {
        throw new Error("simulated crash before commit");
      },
    });
    const before = server.received.length;
    await expect(exploding.process(event)).rejects.toThrow("simulated crash");
    expect(server.received.length).toBe(before + 1); // HTTP went out...
    // ...but nothing was committed:
    const claimed = await admin.query("SELECT 1 FROM processed_events WHERE event_id = $1", [event.eventId]);
    expect(claimed.rowCount).toBe(0);
    // redelivery processes cleanly end-to-end (documented duplicate webhook):
    expect(await processor.process(event)).toBe("delivered");
    expect(server.received.length).toBe(before + 2);
  });
});
```

- [ ] **Step 2: Red.**

- [ ] **Step 3: Write `apps/worker/src/processor/delivery-processor.service.ts`**

```ts
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Pool, PoolClient } from "pg";
import type { SubmissionReceivedEvent } from "@eventform/shared";
import { WORKER_POOL } from "../db.module";
import { MAX_ATTEMPTS, nextRetryDelayMs } from "./backoff";
import { WebhookSender } from "../webhook/webhook-sender.service";

export type ProcessOutcome =
  | "delivered"
  | "retry_scheduled"
  | "failed"
  | "duplicate"
  | "stale"
  | "orphan";

export interface ProcessorHooks {
  /** Test seam: runs after the HTTP send, before commit. */
  afterSendHook?: () => void;
}

@Injectable()
export class DeliveryProcessor {
  private readonly logger = new Logger(DeliveryProcessor.name);

  constructor(
    @Inject(WORKER_POOL) private readonly pool: Pool,
    private readonly sender: WebhookSender,
    @Optional() private readonly hooks: ProcessorHooks = {},
  ) {}

  /**
   * One transaction per event:
   *   claim processed_events (idempotency) → lock delivery FOR UPDATE →
   *   HTTP send → record attempt → advance status machine → COMMIT.
   * A crash after the send rolls everything back, so redelivery re-sends:
   * that is the documented at-least-once contract (receivers dedupe on
   * X-Eventform-Event-Id).
   */
  async process(event: SubmissionReceivedEvent): Promise<ProcessOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const outcome = await this.run(client, event);
      await client.query("COMMIT");
      client.release();
      return outcome;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
        client.release();
      } catch {
        client.release(err as Error);
      }
      throw err;
    }
  }

  private async run(client: PoolClient, event: SubmissionReceivedEvent): Promise<ProcessOutcome> {
    const claim = await client.query(
      "INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id",
      [event.eventId],
    );
    if (claim.rowCount === 0) {
      return "duplicate";
    }

    const found = await client.query("SELECT * FROM deliveries WHERE id = $1 FOR UPDATE", [
      event.deliveryId,
    ]);
    if (found.rowCount === 0) {
      this.logger.warn(`orphan event ${event.eventId}: delivery ${event.deliveryId} missing`);
      return "orphan";
    }
    const delivery = found.rows[0];
    if (delivery.status === "delivered" || delivery.status === "failed") {
      return "stale";
    }

    const endpointRes = await client.query(
      "SELECT url, secret_ciphertext FROM endpoints WHERE id = $1",
      [delivery.endpoint_id],
    );
    if (endpointRes.rowCount === 0) {
      this.logger.warn(`delivery ${delivery.id}: endpoint ${delivery.endpoint_id} missing`);
      return "orphan";
    }
    const endpoint = endpointRes.rows[0];

    const attemptNo = delivery.attempt_count + 1;
    const result = await this.sender.send({
      url: endpoint.url,
      secretCiphertext: endpoint.secret_ciphertext,
      tenantId: delivery.tenant_id,
      endpointId: delivery.endpoint_id,
      payload: { ...event, attempt: attemptNo },
    });
    this.hooks.afterSendHook?.();

    await client.query(
      `INSERT INTO delivery_attempts (delivery_id, tenant_id, attempt_no, response_code, error, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [delivery.id, delivery.tenant_id, attemptNo, result.responseCode, result.error, result.durationMs],
    );

    if (result.ok) {
      await client.query(
        `UPDATE deliveries SET status='delivered', attempt_count=$2, response_code=$3,
         last_error=NULL, next_retry_at=NULL, delivered_at=now() WHERE id=$1`,
        [delivery.id, attemptNo, result.responseCode],
      );
      return "delivered";
    }

    const delayMs = nextRetryDelayMs(attemptNo);
    if (delayMs === null) {
      await client.query(
        `UPDATE deliveries SET status='failed', attempt_count=$2, response_code=$3,
         last_error=$4, next_retry_at=NULL WHERE id=$1`,
        [delivery.id, attemptNo, result.responseCode, result.error],
      );
      this.logger.warn(`delivery ${delivery.id} failed after ${MAX_ATTEMPTS} attempts`);
      return "failed";
    }

    await client.query(
      `UPDATE deliveries SET status='retrying', attempt_count=$2, response_code=$3,
       last_error=$4, next_retry_at=now() + ($5 || ' milliseconds')::interval WHERE id=$1`,
      [delivery.id, attemptNo, result.responseCode, result.error, String(delayMs)],
    );
    return "retry_scheduled";
  }
}
```

- [ ] **Step 4: Wire providers in `app.module.ts`:**

```ts
import { Module } from "@nestjs/common";
import { SecretCipher } from "@eventform/shared";
import { loadConfig } from "./config";
import { DbModule, SECRET_CIPHER, WORKER_POOL } from "./db.module";
import { HealthController } from "./health.controller";
import { DeliveryProcessor } from "./processor/delivery-processor.service";
import { WebhookSender } from "./webhook/webhook-sender.service";
import { Pool } from "pg";

@Module({
  imports: [DbModule],
  controllers: [HealthController],
  providers: [
    {
      provide: WebhookSender,
      useFactory: (cipher: SecretCipher) => new WebhookSender(cipher, loadConfig().webhookTimeoutMs),
      inject: [SECRET_CIPHER],
    },
    {
      provide: DeliveryProcessor,
      useFactory: (pool: Pool, sender: WebhookSender) => new DeliveryProcessor(pool, sender),
      inject: [WORKER_POOL, WebhookSender],
    },
  ],
})
export class AppModule {}
```

- [ ] **Step 5: Green** — worker tests (9 + 7 = 16), run twice. Commit:
`git add apps/worker && git commit -m "feat(worker): idempotent delivery processor with backoff state machine"`

---

### Task 6: Kafka consumer (TDD via pipeline e2e)

**Files:**
- Create: `apps/worker/src/kafka/kafka-consumer.service.ts`
- Test: `apps/worker/test/pipeline.e2e.test.ts`
- Modify: `apps/worker/src/app.module.ts`

- [ ] **Step 1: Failing e2e `apps/worker/test/pipeline.e2e.test.ts`** — requires kafka+connect healthy AND the connector registered (`pnpm connect:register`).

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { Pool } from "pg";
import { createPool } from "@eventform/db";
import { SecretCipher, verifyWebhook } from "@eventform/shared";
import { AppModule } from "../src/app.module";
import { startTestServer, TestServer } from "./test-server";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://eventform:eventform@localhost:5432/eventform";

const cipher = new SecretCipher({
  keyId: "alias/eventform-endpoint-secrets",
  endpoint: "http://localhost:4566",
  region: "us-east-1",
});

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 60_000, everyMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("condition not met in time");
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

describe("pipeline e2e: outbox → debezium → kafka → worker → webhook", () => {
  let app: INestApplication;
  let admin: Pool;
  let server: TestServer;
  const tenantId = randomUUID();
  const secret = "whsec_" + "0f".repeat(24);

  beforeAll(async () => {
    admin = createPool(ADMIN_URL);
    server = await startTestServer();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init(); // consumer joins the group; first join can take ~10s
  }, 90_000);

  afterAll(async () => {
    await app.close();
    for (const table of ["outbox", "delivery_attempts", "deliveries", "submissions", "endpoints", "forms"]) {
      await admin.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    }
    await admin.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await server.close();
    await admin.end();
  });

  it("delivers a signed webhook for an outbox event end-to-end", async () => {
    const formId = randomUUID();
    const endpointId = randomUUID();
    const submissionId = randomUUID();
    const deliveryId = randomUUID();
    const eventId = randomUUID();
    const ciphertext = await cipher.encrypt(secret, tenantId);

    await admin.query("INSERT INTO tenants (id, name, cognito_sub) VALUES ($1,'pipe',$2)", [
      tenantId, `pipe-${randomUUID()}`]);
    await admin.query(
      "INSERT INTO forms (id, tenant_id, title, status, public_slug) VALUES ($1,$2,'Pipe','published',$3)",
      [formId, tenantId, `pipe-${randomUUID()}`]);
    await admin.query(
      "INSERT INTO endpoints (id, tenant_id, name, url, secret_ciphertext) VALUES ($1,$2,'hook',$3,$4)",
      [endpointId, tenantId, server.url, ciphertext]);
    await admin.query(
      "INSERT INTO submissions (id, form_id, tenant_id, answers) VALUES ($1,$2,$3,'{\"Q\":\"pipe\"}'::jsonb)",
      [submissionId, formId, tenantId]);
    await admin.query(
      "INSERT INTO deliveries (id, tenant_id, endpoint_id, submission_id, event_id) VALUES ($1,$2,$3,$4,$5)",
      [deliveryId, tenantId, endpointId, submissionId, eventId]);

    const payload = {
      eventId, type: "submission.received", attempt: 1, tenantId, formId,
      formTitle: "Pipe", submissionId, endpointId, deliveryId,
      answers: { Q: "pipe" }, submittedAt: new Date().toISOString(),
    };
    // The atomic write the API does — here only the outbox insert is the trigger:
    await admin.query(
      `INSERT INTO outbox (id, tenant_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1,$2,'delivery',$3,'submission.received',$4)`,
      [eventId, tenantId, deliveryId, JSON.stringify(payload)]);

    const hit = await until(async () =>
      server.received.find((r) => r.headers["x-eventform-event-id"] === eventId));

    expect(
      verifyWebhook({
        secret,
        timestamp: hit.headers["x-eventform-timestamp"] as string,
        body: hit.body,
        signature: hit.headers["x-eventform-signature"] as string,
      }),
    ).toBe(true);
    const delivered = JSON.parse(hit.body);
    expect(delivered.deliveryId).toBe(deliveryId);
    expect(delivered.answers).toEqual({ Q: "pipe" });

    const row = await until(async () => {
      const res = await admin.query("SELECT * FROM deliveries WHERE id = $1", [deliveryId]);
      return res.rows[0]?.status === "delivered" ? res.rows[0] : undefined;
    });
    expect(row.attempt_count).toBe(1);
  }, 120_000);

  it("skips poison messages without crashing the consumer", async () => {
    await admin.query(
      `INSERT INTO outbox (tenant_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1,'delivery',$2,'submission.received','{"not":"an event"}'::jsonb)`,
      [tenantId, randomUUID()]);
    // consumer must survive; prove liveness by pushing one more valid event through
    // (reuse the seeding from the first test with fresh ids):
    const formId = randomUUID(); const endpointId = randomUUID();
    const submissionId = randomUUID(); const deliveryId = randomUUID();
    const eventId = randomUUID();
    const ciphertext = await cipher.encrypt(secret, tenantId);
    await admin.query(
      "INSERT INTO forms (id, tenant_id, title, status, public_slug) VALUES ($1,$2,'P2','published',$3)",
      [formId, tenantId, `pipe2-${randomUUID()}`]);
    await admin.query(
      "INSERT INTO endpoints (id, tenant_id, name, url, secret_ciphertext) VALUES ($1,$2,'h2',$3,$4)",
      [endpointId, tenantId, server.url, ciphertext]);
    await admin.query(
      "INSERT INTO submissions (id, form_id, tenant_id, answers) VALUES ($1,$2,$3,'{\"Q\":\"2\"}'::jsonb)",
      [submissionId, formId, tenantId]);
    await admin.query(
      "INSERT INTO deliveries (id, tenant_id, endpoint_id, submission_id, event_id) VALUES ($1,$2,$3,$4,$5)",
      [deliveryId, tenantId, endpointId, submissionId, eventId]);
    const payload = {
      eventId, type: "submission.received", attempt: 1, tenantId, formId,
      formTitle: "P2", submissionId, endpointId, deliveryId,
      answers: { Q: "2" }, submittedAt: new Date().toISOString(),
    };
    await admin.query(
      `INSERT INTO outbox (id, tenant_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1,$2,'delivery',$3,'submission.received',$4)`,
      [eventId, tenantId, deliveryId, JSON.stringify(payload)]);

    const hit = await until(async () =>
      server.received.find((r) => r.headers["x-eventform-event-id"] === eventId));
    expect(hit).toBeDefined();
  }, 120_000);
});
```

- [ ] **Step 2: Red** (consumer doesn't exist; events never arrive).

- [ ] **Step 3: Write `apps/worker/src/kafka/kafka-consumer.service.ts`**

```ts
import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { Consumer, Kafka, logLevel } from "kafkajs";
import { submissionReceivedSchema } from "@eventform/shared";
import { loadConfig } from "../config";
import { DeliveryProcessor } from "../processor/delivery-processor.service";

export const EVENTS_TOPIC = "eventform.events";
export const CONSUMER_GROUP = "eventform-worker";

@Injectable()
export class KafkaConsumerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(KafkaConsumerService.name);
  private consumer: Consumer | null = null;

  constructor(private readonly processor: DeliveryProcessor) {}

  async onApplicationBootstrap(): Promise<void> {
    const kafka = new Kafka({
      clientId: "eventform-worker",
      brokers: loadConfig().kafkaBrokers,
      logLevel: logLevel.WARN,
    });
    this.consumer = kafka.consumer({ groupId: CONSUMER_GROUP });
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: EVENTS_TOPIC, fromBeginning: false });

    await this.consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
        const raw = message.value?.toString("utf8");
        let parsed: ReturnType<typeof submissionReceivedSchema.parse> | null = null;
        if (raw) {
          try {
            parsed = submissionReceivedSchema.parse(JSON.parse(raw));
          } catch (err) {
            // Poison pill: log + ack. A malformed event must not crash-loop.
            this.logger.error(
              `skipping unparseable message at ${topic}/${partition}@${message.offset}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
        if (parsed) {
          // Throws on processing errors (e.g. DB down) → offset NOT committed →
          // kafkajs redelivers. That is the at-least-once contract.
          const outcome = await this.processor.process(parsed);
          this.logger.log(`event ${parsed.eventId} → ${outcome}`);
        }
        await this.consumer!.commitOffsets([
          { topic, partition, offset: (Number(message.offset) + 1).toString() },
        ]);
      },
    });
    this.logger.log(`consuming ${EVENTS_TOPIC} as ${CONSUMER_GROUP}`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer?.disconnect();
  }
}
```

- [ ] **Step 4: Register `KafkaConsumerService` in app.module providers.**

- [ ] **Step 5: Green** — prerequisites: full stack healthy + `pnpm connect:register` done. Run the worker suite; expect 16 + 2 = 18 green. NOTE: the pipeline e2e is the slowest suite (group join + CDC latency); if it flakes on the `until` timeout, check `docker compose logs connect` for connector errors before touching the test.

- [ ] **Step 6: Commit** — `git add apps/worker && git commit -m "feat(worker): kafka consumer with manual commits and poison-pill skip"`

---

### Task 7: Retry scheduler + outbox cleanup (TDD)

**Files:**
- Create: `apps/worker/src/scheduler/retry-scheduler.service.ts`
- Create: `apps/worker/src/scheduler/outbox-cleanup.service.ts`
- Test: `apps/worker/test/retry-scheduler.test.ts`
- Modify: `apps/worker/src/app.module.ts`

- [ ] **Step 1: Failing test `apps/worker/test/retry-scheduler.test.ts`**

Tests call `tick()` directly — no timers. Seeding mirrors the processor test
(admin pool; same column set). The scheduler claims due `retrying` deliveries and
re-emits outbox rows; the pipeline then redelivers (proven in Task 6's e2e — here
we assert the claim/re-emit mechanics only).

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPool } from "@eventform/db";
import { submissionReceivedSchema } from "@eventform/shared";
import { RetryScheduler } from "../src/scheduler/retry-scheduler.service";
import { OutboxCleanup } from "../src/scheduler/outbox-cleanup.service";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://eventform:eventform@localhost:5432/eventform";
const WORKER_URL =
  process.env.DATABASE_URL_WORKER ?? "postgres://app_worker:app_worker_dev@localhost:5432/eventform";

describe("RetryScheduler", () => {
  let admin: Pool;
  let workerPool: Pool;
  let scheduler: RetryScheduler;
  const tenantId = randomUUID();

  async function seedRetrying(opts: { dueInMs: number; attemptCount?: number }) {
    const formId = randomUUID(); const endpointId = randomUUID();
    const submissionId = randomUUID(); const deliveryId = randomUUID();
    await admin.query(
      "INSERT INTO forms (id, tenant_id, title, status, public_slug) VALUES ($1,$2,'Sched','published',$3)",
      [formId, tenantId, `sched-${randomUUID()}`]);
    await admin.query(
      "INSERT INTO endpoints (id, tenant_id, name, url, secret_ciphertext) VALUES ($1,$2,'ep','https://example.com/h','ct')",
      [endpointId, tenantId]);
    await admin.query(
      "INSERT INTO submissions (id, form_id, tenant_id, answers) VALUES ($1,$2,$3,'{\"Q\":\"s\"}'::jsonb)",
      [submissionId, formId, tenantId]);
    await admin.query(
      `INSERT INTO deliveries (id, tenant_id, endpoint_id, submission_id, event_id, status, attempt_count, next_retry_at)
       VALUES ($1,$2,$3,$4,$5,'retrying',$6, now() + ($7 || ' milliseconds')::interval)`,
      [deliveryId, tenantId, endpointId, submissionId, randomUUID(), opts.attemptCount ?? 1, String(opts.dueInMs)]);
    return { deliveryId, submissionId };
  }

  beforeAll(async () => {
    admin = createPool(ADMIN_URL);
    workerPool = createPool(WORKER_URL);
    await admin.query("INSERT INTO tenants (id, name, cognito_sub) VALUES ($1,'sched',$2)", [
      tenantId, `sched-${randomUUID()}`]);
    scheduler = new RetryScheduler(workerPool);
  });

  afterAll(async () => {
    for (const table of ["outbox", "deliveries", "submissions", "endpoints", "forms"]) {
      await admin.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    }
    await admin.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await admin.end();
    await workerPool.end();
  });

  it("re-emits due retrying deliveries through the outbox", async () => {
    const { deliveryId } = await seedRetrying({ dueInMs: -1000, attemptCount: 1 });
    const claimed = await scheduler.tick();
    expect(claimed).toBeGreaterThanOrEqual(1);

    const row = await admin.query("SELECT * FROM deliveries WHERE id = $1", [deliveryId]);
    expect(row.rows[0].status).toBe("pending");

    const outboxRow = await admin.query("SELECT * FROM outbox WHERE aggregate_id = $1", [deliveryId]);
    expect(outboxRow.rowCount).toBe(1);
    expect(outboxRow.rows[0].id).toBe(row.rows[0].event_id); // delivery points at the new event
    const payload = submissionReceivedSchema.parse(outboxRow.rows[0].payload);
    expect(payload.attempt).toBe(2); // attempt_count 1 → next attempt is 2
    expect(payload.deliveryId).toBe(deliveryId);
  });

  it("leaves not-yet-due and non-retrying deliveries alone", async () => {
    const { deliveryId: future } = await seedRetrying({ dueInMs: 60_000 });
    await scheduler.tick();
    const row = await admin.query("SELECT status FROM deliveries WHERE id = $1", [future]);
    expect(row.rows[0].status).toBe("retrying");
  });

  it("two concurrent ticks never double-claim (SKIP LOCKED)", async () => {
    await seedRetrying({ dueInMs: -1000 });
    const [a, b] = await Promise.all([scheduler.tick(), scheduler.tick()]);
    // every due delivery claimed exactly once across both ticks
    const dupes = await admin.query(
      `SELECT aggregate_id, count(*) FROM outbox WHERE tenant_id = $1
       GROUP BY aggregate_id HAVING count(*) > 1`, [tenantId]);
    expect(dupes.rowCount).toBe(0);
    expect(a + b).toBeGreaterThanOrEqual(1);
  });
});

describe("OutboxCleanup", () => {
  it("prunes outbox rows older than the retention window", async () => {
    const admin = createPool(ADMIN_URL);
    const workerPool = createPool(WORKER_URL);
    const old = randomUUID();
    const fresh = randomUUID();
    await admin.query(
      `INSERT INTO outbox (id, tenant_id, aggregate_type, aggregate_id, event_type, payload, created_at)
       VALUES ($1, gen_random_uuid(), 'delivery', gen_random_uuid(), 'cleanup-test', '{}'::jsonb, now() - interval '25 hours')`,
      [old]);
    await admin.query(
      `INSERT INTO outbox (id, tenant_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1, gen_random_uuid(), 'delivery', gen_random_uuid(), 'cleanup-test', '{}'::jsonb)`,
      [fresh]);

    const cleanup = new OutboxCleanup(workerPool, 24);
    const pruned = await cleanup.tick();
    expect(pruned).toBeGreaterThanOrEqual(1);

    const rows = await admin.query("SELECT id FROM outbox WHERE event_type = 'cleanup-test'");
    expect(rows.rows.map((r) => r.id)).toEqual([fresh]);

    await admin.query("DELETE FROM outbox WHERE event_type = 'cleanup-test'");
    await admin.end();
    await workerPool.end();
  });
});
```

- [ ] **Step 2: Red.**

- [ ] **Step 3: Write `apps/worker/src/scheduler/retry-scheduler.service.ts`**

```ts
import { randomUUID } from "node:crypto";
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from "@nestjs/common";
import { Pool } from "pg";
import type { SubmissionReceivedEvent } from "@eventform/shared";
import { WORKER_POOL } from "../db.module";
import { loadConfig } from "../config";

@Injectable()
export class RetryScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RetryScheduler.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(WORKER_POOL) private readonly pool: Pool,
    @Optional() private readonly pollMs: number = loadConfig().retryPollMs,
    @Optional() private readonly enableTimer: boolean = false,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enableTimer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick().catch((err) => this.logger.error(`tick failed: ${err}`));
    }, this.pollMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /**
   * Claim due retries with FOR UPDATE SKIP LOCKED and re-emit each through the
   * outbox (new event id, attempt = attempt_count + 1). Same pipeline as the
   * first attempt and as manual retry: "even retries are events".
   * Returns the number of deliveries re-emitted.
   */
  async tick(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query(
        `SELECT d.*, s.answers, s.submitted_at, f.id AS form_id, f.title AS form_title
         FROM deliveries d
         JOIN submissions s ON s.id = d.submission_id
         JOIN forms f ON f.id = s.form_id
         WHERE d.status = 'retrying' AND d.next_retry_at <= now()
         ORDER BY d.next_retry_at
         FOR UPDATE OF d SKIP LOCKED
         LIMIT 10`,
      );
      for (const row of due.rows) {
        const eventId = randomUUID();
        const payload: SubmissionReceivedEvent = {
          eventId,
          type: "submission.received",
          attempt: row.attempt_count + 1,
          tenantId: row.tenant_id,
          formId: row.form_id,
          formTitle: row.form_title,
          submissionId: row.submission_id,
          endpointId: row.endpoint_id,
          deliveryId: row.id,
          answers: row.answers,
          submittedAt: new Date(row.submitted_at).toISOString(),
        };
        await client.query(
          `INSERT INTO outbox (id, tenant_id, aggregate_type, aggregate_id, event_type, payload)
           VALUES ($1,$2,'delivery',$3,'submission.received',$4)`,
          [eventId, row.tenant_id, row.id, JSON.stringify(payload)],
        );
        await client.query(
          "UPDATE deliveries SET status='pending', event_id=$2, next_retry_at=NULL WHERE id=$1",
          [row.id, eventId],
        );
      }
      await client.query("COMMIT");
      if (due.rowCount! > 0) {
        this.logger.log(`re-emitted ${due.rowCount} due deliveries`);
      }
      client.release();
      return due.rowCount ?? 0;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
        client.release();
      } catch {
        client.release(err as Error);
      }
      throw err;
    }
  }
}
```

- [ ] **Step 4: Write `apps/worker/src/scheduler/outbox-cleanup.service.ts`**

```ts
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from "@nestjs/common";
import { Pool } from "pg";
import { WORKER_POOL } from "../db.module";
import { loadConfig } from "../config";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly

@Injectable()
export class OutboxCleanup implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxCleanup.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(WORKER_POOL) private readonly pool: Pool,
    @Optional() private readonly retentionHours: number = loadConfig().outboxRetentionHours,
    @Optional() private readonly enableTimer: boolean = false,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enableTimer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick().catch((err) => this.logger.error(`cleanup failed: ${err}`));
    }, CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /** Debezium reads the WAL, so deleting captured rows is safe. */
  async tick(): Promise<number> {
    const res = await this.pool.query(
      "DELETE FROM outbox WHERE created_at < now() - ($1 || ' hours')::interval",
      [String(this.retentionHours)],
    );
    if (res.rowCount! > 0) {
      this.logger.log(`pruned ${res.rowCount} captured outbox rows`);
    }
    return res.rowCount ?? 0;
  }
}
```

- [ ] **Step 5: Wire both into app.module providers** with timers ENABLED in the real app:

```ts
    {
      provide: RetryScheduler,
      useFactory: (pool: Pool) => new RetryScheduler(pool, loadConfig().retryPollMs, true),
      inject: [WORKER_POOL],
    },
    {
      provide: OutboxCleanup,
      useFactory: (pool: Pool) => new OutboxCleanup(pool, loadConfig().outboxRetentionHours, true),
      inject: [WORKER_POOL],
    },
```

- [ ] **Step 6: Green** — worker suite (18 + 4 = 22), run twice. Commit:
`git add apps/worker && git commit -m "feat(worker): retry scheduler with skip-locked claims and outbox cleanup"`

---

### Task 8: Full-loop verification + docs

**Files:**
- Modify: `README.md`
- Modify: this plan (implementation notes)

- [ ] **Step 1: The money test, manually.** With the full stack healthy, connector registered, API (`PORT=3001`) and worker booted from dist:
  1. Start a local receiver: `npx -y http-echo-server 9099` (or any logger).
  2. Via curl with a dev token: create a form, one text field "Name", publish; create an endpoint pointing at `http://localhost:9099` (the worker runs on the host, so localhost is correct — no docker DNS needed).
  3. Anonymous POST a submission.
  4. Within ~2 s the receiver logs a POST with `X-Eventform-Signature`; `GET /deliveries` shows `delivered`, attempts = 1.
  5. Update the endpoint URL to `http://localhost:9098` (nothing listening), submit again → watch `GET /deliveries`: pending → retrying (attempt 1) → retrying (attempt 2) → failed (attempt 3) over ~40 s.
  6. Point the URL back at 9099, `POST /deliveries/:id/retry` → delivered.
  Capture this transcript in the report; clean up the demo tenant rows after.
- [ ] **Step 2: README** — flip `apps/worker` line to "Kafka consumer + webhook delivery — idempotent, at-least-once, auto-retry"; add a "Run the pipeline locally" snippet (db:up → connect:register → start api + worker). Add the Phase 3 plan link.
- [ ] **Step 3:** Append "## Implementation notes (deviations)" to this plan; record exact final test counts.
- [ ] **Step 4:** Root `pnpm build && pnpm test` — all green (expect ~116: 94 + 22).
- [ ] **Step 5: Commit** — `git add README.md docs && git commit -m "docs: document pipeline phase and local run instructions"`

## Done criteria for Phase 3

- Full stack (postgres, localstack, kafka, connect) healthy; connector RUNNING.
- Root suite green including the pipeline e2e (outbox insert → signed webhook at a local server → delivery row `delivered`).
- Manual full-loop transcript: submit → delivered; unreachable endpoint → 3 attempts → failed → manual retry → delivered. ("Even retries are events.")
- Duplicate Kafka delivery sends exactly one webhook (idempotency test); a poison message is skipped, consumer stays live.
- Phase 4 (frontend) needs no backend changes: every UI feature maps to an existing API.
