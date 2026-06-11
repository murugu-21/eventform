# Eventform Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the eventform monorepo with Postgres (logical replication), LocalStack KMS, the shared HMAC/event-schema/secret-cipher package, the full Drizzle data model, and DB-enforced multi-tenancy (RLS + roles) proven by integration tests.

**Architecture:** pnpm-workspaces monorepo. `packages/shared` holds webhook HMAC utilities, zod event schemas, and a KMS-backed `SecretCipher` (endpoint HMAC secrets are never stored plaintext — see spec §Endpoint secret encryption). `packages/db` holds the Drizzle schema, SQL migrations (including roles + RLS policies), and a `withTenant` transaction helper that sets `app.tenant_id` per transaction. Postgres 16 runs in docker-compose with `wal_level=logical` (ready for Debezium in Phase 3) alongside LocalStack (`SERVICES=kms`) whose boot hook imports fixed key material so ciphertexts survive restarts. The API connects as non-superuser role `app_api` (RLS enforced); the worker connects as `app_worker` (BYPASSRLS).

**Tech Stack:** Node 22, pnpm, TypeScript 5, Drizzle ORM + drizzle-kit, node-postgres (`pg`), zod, `@aws-sdk/client-kms`, vitest, Postgres 16 + LocalStack (docker-compose).

**Spec:** `docs/superpowers/specs/2026-06-11-eventform-design.md`

**Phase roadmap (separate plans, written after each phase ships):**
Phase 1 Foundation (this plan) → Phase 2 API → Phase 3 Kafka/Debezium pipeline + worker → Phase 4 Frontend → Phase 5 Cognito/CDK/CI/EC2.

---

## File structure created in this phase

```
package.json                      root: workspaces, shared scripts
pnpm-workspace.yaml
tsconfig.base.json
.gitignore
.env.example
infra/compose/docker-compose.yml  postgres 16 (wal_level=logical) + localstack (kms)
infra/compose/localstack/
  dev-key-material.b64            fixed dev KMS key material (checked in, dev-only)
  ready.d/01-import-kms-key.sh    boot hook: create key + import material (BYOK)
packages/shared/
  package.json, tsconfig.json, vitest.config.ts
  src/index.ts                    re-exports
  src/hmac.ts                     signWebhook / verifyWebhook
  src/events.ts                   submission.received zod schema
  src/kms.ts                      SecretCipher (KMS encrypt/decrypt), generateEndpointSecret
  test/hmac.test.ts
  test/events.test.ts
  test/kms.test.ts                integration — needs localstack up
packages/db/
  package.json, tsconfig.json, vitest.config.ts, drizzle.config.ts
  src/index.ts                    re-exports
  src/schema.ts                   all 9 tables + enums
  src/client.ts                   createPool, withTenant
  migrations/                     0000 (generated DDL), 0001 (hand-written RLS)
  test/client.test.ts             withTenant behavior
  test/rls.test.ts                tenant isolation + public-read policies
```

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`

- [ ] **Step 1: Write root `package.json`**

```json
{
  "name": "eventform",
  "private": true,
  "engines": { "node": ">=22" },
  "packageManager": "pnpm@10.4.1",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "db:up": "docker compose -f infra/compose/docker-compose.yml up -d",
    "db:down": "docker compose -f infra/compose/docker-compose.yml down",
    "db:migrate": "pnpm --filter @eventform/db migrate"
  }
}
```

- [ ] **Step 2: Write `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 3: Write `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 4: Write `.gitignore`**

```
node_modules/
dist/
.env
*.tsbuildinfo
```

- [ ] **Step 5: Verify pnpm resolves the workspace**

Run: `pnpm install`
Expected: completes without error (no packages yet — lockfile created).

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore pnpm-lock.yaml
git commit -m "chore: scaffold pnpm workspaces monorepo"
```

---

### Task 2: Postgres + LocalStack KMS via docker-compose

**Files:**
- Create: `infra/compose/docker-compose.yml`
- Create: `infra/compose/localstack/dev-key-material.b64`
- Create: `infra/compose/localstack/ready.d/01-import-kms-key.sh`
- Create: `.env.example`

- [ ] **Step 1: Write `infra/compose/docker-compose.yml`**

`wal_level=logical` is required by Debezium in Phase 3; setting it now avoids a
volume reset later. LocalStack serves KMS only; its boot hook (Step 3) imports
fixed key material so endpoint-secret ciphertexts survive container restarts
(Community edition has no persistence).

```yaml
name: eventform

services:
  postgres:
    image: postgres:16-alpine
    command: postgres -c wal_level=logical
    environment:
      POSTGRES_USER: eventform
      POSTGRES_PASSWORD: eventform
      POSTGRES_DB: eventform
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U eventform -d eventform"]
      interval: 5s
      timeout: 3s
      retries: 10

  localstack:
    image: localstack/localstack:latest
    environment:
      SERVICES: kms
      KMS_KEY_MATERIAL_PATH: /etc/eventform/kms-key-material.b64
    ports:
      - "4566:4566"
    volumes:
      - ./localstack/ready.d:/etc/localstack/init/ready.d:ro
      - ./localstack/dev-key-material.b64:/etc/eventform/kms-key-material.b64:ro
    healthcheck:
      test: ["CMD-SHELL", "awslocal kms describe-key --key-id alias/eventform-endpoint-secrets"]
      interval: 5s
      timeout: 5s
      retries: 20

volumes:
  pgdata:
```

- [ ] **Step 2: Generate the fixed dev key material**

Checked in deliberately — it is a dev-only secret, same class as the
`app_api_dev` password. Production generates its own file in Phase 5.

Run:
```bash
mkdir -p infra/compose/localstack/ready.d
openssl rand -base64 32 > infra/compose/localstack/dev-key-material.b64
```
Expected: file contains one 44-char base64 line.

- [ ] **Step 3: Write `infra/compose/localstack/ready.d/01-import-kms-key.sh`**

BYOK flow: create the key with `Origin=EXTERNAL` and a **fixed custom key id**
(LocalStack's `_custom_id_` tag), then wrap our fixed material with the import
wrapping key and import it. Same key id + same material every boot ⇒ old
ciphertexts always decrypt. Idempotent: skips if the key is already enabled.

```bash
#!/bin/bash
set -euo pipefail

python3 - <<'PYEOF'
import base64
import boto3
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

ALIAS = "alias/eventform-endpoint-secrets"
CUSTOM_KEY_ID = "11111111-2222-4333-8444-555555555555"
MATERIAL_PATH = "/etc/eventform/kms-key-material.b64"

kms = boto3.client(
    "kms",
    endpoint_url="http://localhost:4566",
    region_name="us-east-1",
    aws_access_key_id="test",
    aws_secret_access_key="test",
)

try:
    meta = kms.describe_key(KeyId=ALIAS)["KeyMetadata"]
    if meta["KeyState"] == "Enabled":
        print("eventform KMS key already enabled, skipping import")
        raise SystemExit(0)
    key_id = meta["KeyId"]
except kms.exceptions.NotFoundException:
    key = kms.create_key(
        Description="eventform endpoint HMAC secrets",
        Origin="EXTERNAL",
        Tags=[{"TagKey": "_custom_id_", "TagValue": CUSTOM_KEY_ID}],
    )
    key_id = key["KeyMetadata"]["KeyId"]
    kms.create_alias(AliasName=ALIAS, TargetKeyId=key_id)

with open(MATERIAL_PATH) as f:
    material = base64.b64decode(f.read().strip())
assert len(material) == 32, "key material must be 32 bytes"

params = kms.get_parameters_for_import(
    KeyId=key_id,
    WrappingAlgorithm="RSAES_OAEP_SHA_256",
    WrappingKeySpec="RSA_2048",
)
wrapping_key = serialization.load_der_public_key(params["PublicKey"])
wrapped = wrapping_key.encrypt(
    material,
    padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
)
kms.import_key_material(
    KeyId=key_id,
    ImportToken=params["ImportToken"],
    EncryptedKeyMaterial=wrapped,
    ExpirationModel="KEY_MATERIAL_DOES_NOT_EXPIRE",
)
print(f"imported fixed key material into {key_id}")
PYEOF
```

Then make it executable:
```bash
chmod +x infra/compose/localstack/ready.d/01-import-kms-key.sh
```

- [ ] **Step 4: Write `.env.example`**

Three connection strings — admin (migrations), API role (RLS enforced), worker
role (BYPASSRLS); dev passwords match the role-creation migration in Task 7.
AWS vars point the SDK at LocalStack (dummy creds are what LocalStack expects).

```
DATABASE_URL=postgres://eventform:eventform@localhost:5432/eventform
DATABASE_URL_API=postgres://app_api:app_api_dev@localhost:5432/eventform
DATABASE_URL_WORKER=postgres://app_worker:app_worker_dev@localhost:5432/eventform

AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
AWS_ENDPOINT_URL=http://localhost:4566
KMS_KEY_ID=alias/eventform-endpoint-secrets
```

- [ ] **Step 5: Start the stack and verify health**

Run: `pnpm db:up && sleep 15 && docker compose -f infra/compose/docker-compose.yml ps`
Expected: `eventform-postgres-1` and `eventform-localstack-1` both `(healthy)`.

- [ ] **Step 6: Verify the KMS key survives a restart**

Run:
```bash
docker compose -f infra/compose/docker-compose.yml exec localstack \
  awslocal kms encrypt --key-id alias/eventform-endpoint-secrets \
  --plaintext "cm91bmR0cmlw" --query CiphertextBlob --output text > /tmp/ef-kms-ct.txt
docker compose -f infra/compose/docker-compose.yml restart localstack && sleep 15
docker compose -f infra/compose/docker-compose.yml exec localstack \
  awslocal kms decrypt --ciphertext-blob "$(cat /tmp/ef-kms-ct.txt)" \
  --query Plaintext --output text
```
Expected: final output `cm91bmR0cmlw` — a pre-restart ciphertext decrypts after
restart, proving the fixed-material import works.

- [ ] **Step 7: Commit**

```bash
git add infra/compose .env.example
git commit -m "chore: add postgres and localstack kms compose services"
```

---

### Task 3: Shared package — HMAC utilities (TDD)

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/vitest.config.ts`
- Create: `packages/shared/src/hmac.ts`
- Create: `packages/shared/src/index.ts`
- Test: `packages/shared/test/hmac.test.ts`

- [ ] **Step 1: Write `packages/shared/package.json`**

```json
{
  "name": "@eventform/shared",
  "version": "0.0.1",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.8.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Write `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `packages/shared/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
```

- [ ] **Step 4: Install workspace deps**

Run: `pnpm install`
Expected: `@eventform/shared` deps resolved.

- [ ] **Step 5: Write the failing test `packages/shared/test/hmac.test.ts`**

The signature format is `sha256=<hex hmac of "timestamp.body">` — what
receivers verify and what the spec's `X-Eventform-Signature` header carries.

```ts
import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhook } from "../src/hmac";

const SECRET = "whsec_test_secret";
const BODY = JSON.stringify({ hello: "world" });
const TS = "1760000000";

describe("signWebhook", () => {
  it("produces a sha256= prefixed hex signature", () => {
    const sig = signWebhook(SECRET, TS, BODY);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("is deterministic for the same inputs", () => {
    expect(signWebhook(SECRET, TS, BODY)).toBe(signWebhook(SECRET, TS, BODY));
  });

  it("changes when the body changes", () => {
    expect(signWebhook(SECRET, TS, BODY)).not.toBe(signWebhook(SECRET, TS, BODY + "x"));
  });
});

describe("verifyWebhook", () => {
  it("accepts a valid signature within tolerance", () => {
    const sig = signWebhook(SECRET, TS, BODY);
    expect(
      verifyWebhook({
        secret: SECRET,
        timestamp: TS,
        body: BODY,
        signature: sig,
        nowEpochSeconds: Number(TS) + 60,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = signWebhook(SECRET, TS, BODY);
    expect(
      verifyWebhook({
        secret: SECRET,
        timestamp: TS,
        body: BODY + "tampered",
        signature: sig,
        nowEpochSeconds: Number(TS) + 60,
      }),
    ).toBe(false);
  });

  it("rejects a stale timestamp outside tolerance", () => {
    const sig = signWebhook(SECRET, TS, BODY);
    expect(
      verifyWebhook({
        secret: SECRET,
        timestamp: TS,
        body: BODY,
        signature: sig,
        toleranceSeconds: 300,
        nowEpochSeconds: Number(TS) + 301,
      }),
    ).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const sig = signWebhook("other_secret", TS, BODY);
    expect(
      verifyWebhook({
        secret: SECRET,
        timestamp: TS,
        body: BODY,
        signature: sig,
        nowEpochSeconds: Number(TS) + 60,
      }),
    ).toBe(false);
  });

  it("rejects a malformed timestamp", () => {
    const sig = signWebhook(SECRET, TS, BODY);
    expect(
      verifyWebhook({
        secret: SECRET,
        timestamp: "not-a-number",
        body: BODY,
        signature: sig,
        nowEpochSeconds: Number(TS),
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter @eventform/shared test`
Expected: FAIL — `Cannot find module '../src/hmac'` (or equivalent).

- [ ] **Step 7: Write `packages/shared/src/hmac.ts`**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function signWebhook(secret: string, timestamp: string, body: string): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `sha256=${mac}`;
}

export interface VerifyWebhookParams {
  secret: string;
  timestamp: string;
  body: string;
  signature: string;
  /** Maximum allowed clock skew in seconds. Default 300. */
  toleranceSeconds?: number;
  /** Injectable clock for tests. Defaults to Date.now(). */
  nowEpochSeconds?: number;
}

export function verifyWebhook(params: VerifyWebhookParams): boolean {
  const { secret, timestamp, body, signature, toleranceSeconds = 300 } = params;
  const now = params.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > toleranceSeconds) {
    return false;
  }
  const expected = Buffer.from(signWebhook(secret, timestamp, body));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
```

- [ ] **Step 8: Write `packages/shared/src/index.ts`**

```ts
export * from "./hmac";
```

- [ ] **Step 9: Run test to verify it passes**

Run: `pnpm --filter @eventform/shared test`
Expected: PASS — 9 tests.

- [ ] **Step 10: Verify the package builds**

Run: `pnpm --filter @eventform/shared build`
Expected: `dist/index.js`, `dist/hmac.d.ts` produced, no errors.

- [ ] **Step 11: Commit**

```bash
git add packages/shared pnpm-lock.yaml
git commit -m "feat(shared): add webhook HMAC sign/verify utilities"
```

---

### Task 4: Shared package — event schema (TDD)

**Files:**
- Create: `packages/shared/src/events.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/events.test.ts`

- [ ] **Step 1: Write the failing test `packages/shared/test/events.test.ts`**

This schema is the contract between the API (outbox payload producer), the
worker (consumer), and webhook receivers.

```ts
import { describe, expect, it } from "vitest";
import { submissionReceivedSchema } from "../src/events";

const VALID = {
  eventId: "0d4f9d40-0000-4000-8000-000000000001",
  type: "submission.received",
  attempt: 1,
  tenantId: "0d4f9d40-0000-4000-8000-000000000002",
  formId: "0d4f9d40-0000-4000-8000-000000000003",
  formTitle: "Customer feedback",
  submissionId: "0d4f9d40-0000-4000-8000-000000000004",
  endpointId: "0d4f9d40-0000-4000-8000-000000000005",
  deliveryId: "0d4f9d40-0000-4000-8000-000000000006",
  answers: { "What is your name?": "Ada", "Rating?": "Good" },
  submittedAt: "2026-06-11T10:00:00.000Z",
};

describe("submissionReceivedSchema", () => {
  it("parses a valid event", () => {
    const event = submissionReceivedSchema.parse(VALID);
    expect(event.type).toBe("submission.received");
    expect(event.answers["What is your name?"]).toBe("Ada");
  });

  it("rejects a wrong type literal", () => {
    expect(() =>
      submissionReceivedSchema.parse({ ...VALID, type: "submission.deleted" }),
    ).toThrow();
  });

  it("rejects attempt 0", () => {
    expect(() => submissionReceivedSchema.parse({ ...VALID, attempt: 0 })).toThrow();
  });

  it("rejects a non-uuid eventId", () => {
    expect(() => submissionReceivedSchema.parse({ ...VALID, eventId: "nope" })).toThrow();
  });

  it("rejects non-string answer values", () => {
    expect(() =>
      submissionReceivedSchema.parse({ ...VALID, answers: { q: 42 } }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @eventform/shared test`
Expected: FAIL — `Cannot find module '../src/events'`.

- [ ] **Step 3: Write `packages/shared/src/events.ts`**

```ts
import { z } from "zod";

export const submissionReceivedSchema = z.object({
  eventId: z.string().uuid(),
  type: z.literal("submission.received"),
  attempt: z.number().int().min(1),
  tenantId: z.string().uuid(),
  formId: z.string().uuid(),
  formTitle: z.string(),
  submissionId: z.string().uuid(),
  endpointId: z.string().uuid(),
  deliveryId: z.string().uuid(),
  answers: z.record(z.string()),
  submittedAt: z.string().datetime(),
});

export type SubmissionReceivedEvent = z.infer<typeof submissionReceivedSchema>;
```

- [ ] **Step 4: Update `packages/shared/src/index.ts`**

```ts
export * from "./hmac";
export * from "./events";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @eventform/shared test`
Expected: PASS — 14 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add submission.received event schema"
```

---

### Task 5: Shared package — KMS SecretCipher (TDD)

**Files:**
- Create: `packages/shared/src/kms.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/package.json` (via `pnpm add`)
- Test: `packages/shared/test/kms.test.ts`

Requires LocalStack up (Task 2). The cipher wraps KMS Encrypt/Decrypt with an
`EncryptionContext` of `{ tenantId }`, so a ciphertext replayed under another
tenant fails to decrypt. Identical code path against real AWS KMS — only
`AWS_ENDPOINT_URL` differs.

- [ ] **Step 1: Add the KMS SDK dependency**

Run: `pnpm --filter @eventform/shared add @aws-sdk/client-kms`
Expected: dependency added, install succeeds.

- [ ] **Step 2: Write the failing test `packages/shared/test/kms.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { SecretCipher, generateEndpointSecret } from "../src/kms";

const cipher = new SecretCipher({
  keyId: process.env.KMS_KEY_ID ?? "alias/eventform-endpoint-secrets",
  endpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
  region: process.env.AWS_REGION ?? "us-east-1",
});

const TENANT_A = "0d4f9d40-0000-4000-8000-00000000000a";
const TENANT_B = "0d4f9d40-0000-4000-8000-00000000000b";

describe("generateEndpointSecret", () => {
  it("produces whsec_-prefixed 48-hex-char secrets", () => {
    const secret = generateEndpointSecret();
    expect(secret).toMatch(/^whsec_[0-9a-f]{48}$/);
  });

  it("produces unique secrets", () => {
    expect(generateEndpointSecret()).not.toBe(generateEndpointSecret());
  });
});

describe("SecretCipher", () => {
  it("round-trips a secret for the same tenant", async () => {
    const secret = generateEndpointSecret();
    const ciphertext = await cipher.encrypt(secret, TENANT_A);
    expect(ciphertext).not.toContain(secret);
    await expect(cipher.decrypt(ciphertext, TENANT_A)).resolves.toBe(secret);
  });

  it("fails to decrypt under a different tenant (encryption context)", async () => {
    const ciphertext = await cipher.encrypt(generateEndpointSecret(), TENANT_A);
    await expect(cipher.decrypt(ciphertext, TENANT_B)).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @eventform/shared test -- kms`
Expected: FAIL — `Cannot find module '../src/kms'`.

- [ ] **Step 4: Write `packages/shared/src/kms.ts`**

```ts
import { randomBytes } from "node:crypto";
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";

/** Webhook signing secret: whsec_ + 48 hex chars (24 random bytes). */
export function generateEndpointSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

export interface SecretCipherOptions {
  keyId: string;
  /** LocalStack in dev/prod-on-EC2; omit for real AWS KMS. */
  endpoint?: string;
  region?: string;
  client?: KMSClient;
}

/**
 * Encrypts endpoint HMAC secrets with KMS so they are never stored plaintext.
 * EncryptionContext binds each ciphertext to its tenant.
 */
export class SecretCipher {
  private readonly client: KMSClient;
  private readonly keyId: string;

  constructor(opts: SecretCipherOptions) {
    this.keyId = opts.keyId;
    this.client =
      opts.client ??
      new KMSClient({
        region: opts.region ?? "us-east-1",
        ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      });
  }

  async encrypt(plaintext: string, tenantId: string): Promise<string> {
    const out = await this.client.send(
      new EncryptCommand({
        KeyId: this.keyId,
        Plaintext: Buffer.from(plaintext, "utf8"),
        EncryptionContext: { tenantId },
      }),
    );
    return Buffer.from(out.CiphertextBlob!).toString("base64");
  }

  async decrypt(ciphertextB64: string, tenantId: string): Promise<string> {
    const out = await this.client.send(
      new DecryptCommand({
        CiphertextBlob: Buffer.from(ciphertextB64, "base64"),
        EncryptionContext: { tenantId },
      }),
    );
    return Buffer.from(out.Plaintext!).toString("utf8");
  }
}
```

- [ ] **Step 5: Update `packages/shared/src/index.ts`**

```ts
export * from "./hmac";
export * from "./events";
export * from "./kms";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @eventform/shared test`
Expected: PASS — 18 tests (hmac 9 + events 5 + kms 4).

- [ ] **Step 7: Commit**

```bash
git add packages/shared pnpm-lock.yaml
git commit -m "feat(shared): add KMS-backed secret cipher for endpoint secrets"
```

---

### Task 6: DB package — Drizzle schema and initial migration

**Files:**
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/vitest.config.ts`
- Create: `packages/db/drizzle.config.ts`
- Create: `packages/db/src/schema.ts`
- Create: `packages/db/src/index.ts`
- Create: `packages/db/migrations/` (generated by drizzle-kit)

- [ ] **Step 1: Write `packages/db/package.json`**

```json
{
  "name": "@eventform/db",
  "version": "0.0.1",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "generate": "drizzle-kit generate",
    "migrate": "drizzle-kit migrate"
  },
  "dependencies": {
    "drizzle-orm": "^0.44.0",
    "pg": "^8.16.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0",
    "drizzle-kit": "^0.31.0",
    "typescript": "^5.8.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Write `packages/db/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `packages/db/vitest.config.ts`**

DB tests hit real Postgres; keep them serial to avoid pool contention noise.

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 15000,
  },
});
```

- [ ] **Step 4: Write `packages/db/drizzle.config.ts`**

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://eventform:eventform@localhost:5432/eventform",
  },
});
```

- [ ] **Step 5: Write `packages/db/src/schema.ts`**

All nine tables from the spec. `outbox.id` doubles as the event id. Every
tenant-scoped table carries `tenant_id`; RLS policies arrive in Task 7.
`endpoints.secret_ciphertext` holds the KMS-encrypted secret (Task 5's cipher)
— plaintext secrets never touch the database.

```ts
import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const formStatus = pgEnum("form_status", ["draft", "published"]);
export const fieldType = pgEnum("field_type", ["text", "multiple_choice"]);
export const deliveryStatus = pgEnum("delivery_status", [
  "pending",
  "delivered",
  "retrying",
  "failed",
]);

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  cognitoSub: text("cognito_sub").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const forms = pgTable("forms", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  title: text("title").notNull(),
  status: formStatus("status").notNull().default("draft"),
  publicSlug: text("public_slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const formFields = pgTable("form_fields", {
  id: uuid("id").primaryKey().defaultRandom(),
  formId: uuid("form_id").notNull().references(() => forms.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  type: fieldType("type").notNull(),
  label: text("label").notNull(),
  options: jsonb("options").$type<string[] | null>(),
  required: boolean("required").notNull().default(false),
  position: integer("position").notNull(),
});

export const submissions = pgTable("submissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  formId: uuid("form_id").notNull().references(() => forms.id),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  answers: jsonb("answers").$type<Record<string, string>>().notNull(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  sourceIp: text("source_ip"),
});

export const endpoints = pgTable("endpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  name: text("name").notNull(),
  url: text("url").notNull(),
  secretCiphertext: text("secret_ciphertext").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Transactional outbox. id is the event id. Debezium watches this table. */
export const outbox = pgTable("outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Consumer idempotency ledger. Not tenant-scoped; worker-only. */
export const processedEvents = pgTable("processed_events", {
  eventId: uuid("event_id").primaryKey(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const deliveries = pgTable("deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  endpointId: uuid("endpoint_id").notNull().references(() => endpoints.id),
  submissionId: uuid("submission_id").notNull().references(() => submissions.id),
  eventId: uuid("event_id").notNull(),
  status: deliveryStatus("status").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
  lastError: text("last_error"),
  responseCode: integer("response_code"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const deliveryAttempts = pgTable("delivery_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  deliveryId: uuid("delivery_id")
    .notNull()
    .references(() => deliveries.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").notNull(),
  attemptNo: integer("attempt_no").notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  responseCode: integer("response_code"),
  error: text("error"),
  durationMs: integer("duration_ms"),
});
```

- [ ] **Step 6: Write `packages/db/src/index.ts`**

```ts
export * from "./schema";
```

- [ ] **Step 7: Install and generate the initial migration**

Run: `pnpm install && pnpm --filter @eventform/db generate`
Expected: a new file `packages/db/migrations/0000_*.sql` containing `CREATE TABLE` statements for all 9 tables and 3 enums.

- [ ] **Step 8: Apply the migration**

Run: `pnpm db:migrate`
Expected: `migrations applied` (drizzle-kit reports success).

- [ ] **Step 9: Verify tables exist**

Run: `docker compose -f infra/compose/docker-compose.yml exec postgres psql -U eventform -d eventform -c "\dt"`
Expected: lists `tenants, forms, form_fields, submissions, endpoints, outbox, processed_events, deliveries, delivery_attempts` (plus drizzle's `__drizzle_migrations`).

- [ ] **Step 10: Commit**

```bash
git add packages/db pnpm-lock.yaml
git commit -m "feat(db): add drizzle schema and initial migration for all tables"
```

---

### Task 7: Roles + RLS policies migration

**Files:**
- Create: `packages/db/migrations/0001_rls.sql` (via `drizzle-kit generate --custom`)

- [ ] **Step 1: Create an empty custom migration**

Run: `pnpm --filter @eventform/db exec drizzle-kit generate --custom --name=rls`
Expected: new empty file `packages/db/migrations/0001_rls.sql`.

- [ ] **Step 2: Fill in the migration SQL**

Notes on intent:
- `app_api` — what the NestJS API connects as. RLS applies.
- `app_worker` — what the worker connects as. `BYPASSRLS` (trusted internal).
- `current_setting('app.tenant_id', true)` — second arg `true` returns NULL
  instead of erroring when unset, so anonymous connections simply match nothing.
- The two `*_public_read` policies serve the anonymous submission path
  (`GET/POST /f/:slug` in Phase 2): published forms are public content.
- Dev passwords are fine here; the prod bootstrap (Phase 5) rotates them with
  `ALTER ROLE ... PASSWORD` from secrets.

```sql
-- Roles ----------------------------------------------------------------
DO $$ BEGIN
  CREATE ROLE app_api LOGIN PASSWORD 'app_api_dev';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE ROLE app_worker LOGIN PASSWORD 'app_worker_dev';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER ROLE app_worker BYPASSRLS;

GRANT USAGE ON SCHEMA public TO app_api, app_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_api, app_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_api, app_worker;

-- Enable RLS on tenant-scoped tables ------------------------------------
ALTER TABLE forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_attempts ENABLE ROW LEVEL SECURITY;

-- Tenant isolation policies ----------------------------------------------
CREATE POLICY tenant_isolation ON forms
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_isolation ON form_fields
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_isolation ON submissions
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_isolation ON endpoints
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_isolation ON outbox
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_isolation ON deliveries
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_isolation ON delivery_attempts
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Anonymous read of published forms (public submission path) -------------
CREATE POLICY forms_public_read ON forms
  FOR SELECT
  USING (status = 'published');

CREATE POLICY form_fields_public_read ON form_fields
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM forms f
      WHERE f.id = form_fields.form_id AND f.status = 'published'
    )
  );
```

- [ ] **Step 3: Apply the migration**

Run: `pnpm db:migrate`
Expected: success.

- [ ] **Step 4: Verify policies and roles**

Run: `docker compose -f infra/compose/docker-compose.yml exec postgres psql -U eventform -d eventform -c "SELECT tablename, policyname FROM pg_policies ORDER BY tablename, policyname;"`
Expected: 7 `tenant_isolation` rows + `forms_public_read` + `form_fields_public_read` (9 rows).

Run: `docker compose -f infra/compose/docker-compose.yml exec postgres psql -U eventform -d eventform -c "SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname LIKE 'app_%';"`
Expected: `app_api | f` and `app_worker | t`.

- [ ] **Step 5: Commit**

```bash
git add packages/db/migrations
git commit -m "feat(db): add app roles and row-level security policies"
```

---

### Task 8: DB client helpers — `createPool` and `withTenant` (TDD)

**Files:**
- Create: `packages/db/src/client.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/test/client.test.ts`

- [ ] **Step 1: Write the failing test `packages/db/test/client.test.ts`**

Requires Postgres up and migrations applied (Tasks 2/6/7).

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPool, withTenant } from "../src/client";

const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://eventform:eventform@localhost:5432/eventform";

describe("withTenant", () => {
  let pool: Pool;
  let tenantId: string;

  beforeAll(async () => {
    pool = createPool(ADMIN_URL);
    const res = await pool.query(
      "INSERT INTO tenants (name, cognito_sub) VALUES ($1, $2) RETURNING id",
      ["client-test", `sub-${randomUUID()}`],
    );
    tenantId = res.rows[0].id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("sets app.tenant_id for the duration of the transaction", async () => {
    const setting = await withTenant(pool, tenantId, async (_db, client) => {
      const res = await client.query("SELECT current_setting('app.tenant_id', true) AS t");
      return res.rows[0].t;
    });
    expect(setting).toBe(tenantId);
  });

  it("clears app.tenant_id after the transaction (SET LOCAL semantics)", async () => {
    await withTenant(pool, tenantId, async () => undefined);
    const res = await pool.query("SELECT current_setting('app.tenant_id', true) AS t");
    expect(res.rows[0].t === null || res.rows[0].t === "").toBe(true);
  });

  it("rolls back the transaction when the callback throws", async () => {
    const slug = `rollback-${randomUUID()}`;
    await expect(
      withTenant(pool, tenantId, async (_db, client) => {
        await client.query(
          "INSERT INTO forms (tenant_id, title, public_slug) VALUES ($1, $2, $3)",
          [tenantId, "doomed", slug],
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const res = await pool.query("SELECT 1 FROM forms WHERE public_slug = $1", [slug]);
    expect(res.rowCount).toBe(0);
  });

  it("returns the callback result on commit", async () => {
    const result = await withTenant(pool, tenantId, async () => 42);
    expect(result).toBe(42);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @eventform/db test -- client`
Expected: FAIL — `Cannot find module '../src/client'`.

- [ ] **Step 3: Write `packages/db/src/client.ts`**

```ts
import { Pool, type PoolClient } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 10 });
}

/**
 * Run `fn` inside a transaction with `app.tenant_id` set via set_config(...,
 * is_local = true), so RLS policies scope every query to the tenant and the
 * setting vanishes on COMMIT/ROLLBACK.
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (db: Db, client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const db = drizzle(client, { schema });
    const result = await fn(db, client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Update `packages/db/src/index.ts`**

```ts
export * from "./schema";
export * from "./client";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @eventform/db test -- client`
Expected: PASS — 4 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/db
git commit -m "feat(db): add pool factory and tenant-scoped transaction helper"
```

---

### Task 9: RLS isolation integration tests

**Files:**
- Test: `packages/db/test/rls.test.ts`

These tests are the proof that multi-tenancy is DB-enforced. They connect as
`app_api` (the role the API will use in Phase 2).

- [ ] **Step 1: Write `packages/db/test/rls.test.ts`**

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { createPool, withTenant } from "../src/client";
import { forms } from "../src/schema";

const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://eventform:eventform@localhost:5432/eventform";
const API_URL =
  process.env.DATABASE_URL_API ??
  "postgres://app_api:app_api_dev@localhost:5432/eventform";

describe("row-level security", () => {
  let adminPool: Pool;
  let apiPool: Pool;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    adminPool = createPool(ADMIN_URL);
    apiPool = createPool(API_URL);
    const a = await adminPool.query(
      "INSERT INTO tenants (name, cognito_sub) VALUES ($1, $2) RETURNING id",
      ["rls-tenant-a", `sub-${randomUUID()}`],
    );
    const b = await adminPool.query(
      "INSERT INTO tenants (name, cognito_sub) VALUES ($1, $2) RETURNING id",
      ["rls-tenant-b", `sub-${randomUUID()}`],
    );
    tenantA = a.rows[0].id;
    tenantB = b.rows[0].id;
  });

  afterAll(async () => {
    await adminPool.end();
    await apiPool.end();
  });

  it("hides tenant A's draft forms from tenant B", async () => {
    const slug = `rls-draft-${randomUUID()}`;
    await withTenant(apiPool, tenantA, (db) =>
      db.insert(forms).values({ tenantId: tenantA, title: "A draft", publicSlug: slug }),
    );

    const seenByB = await withTenant(apiPool, tenantB, (db) =>
      db.select().from(forms).where(eq(forms.publicSlug, slug)),
    );
    expect(seenByB).toHaveLength(0);

    const seenByA = await withTenant(apiPool, tenantA, (db) =>
      db.select().from(forms).where(eq(forms.publicSlug, slug)),
    );
    expect(seenByA).toHaveLength(1);
  });

  it("rejects inserting a row for another tenant (WITH CHECK)", async () => {
    await expect(
      withTenant(apiPool, tenantA, (db) =>
        db.insert(forms).values({
          tenantId: tenantB,
          title: "forged",
          publicSlug: `rls-forged-${randomUUID()}`,
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("rejects cross-tenant updates (rows invisible)", async () => {
    const slug = `rls-update-${randomUUID()}`;
    await withTenant(apiPool, tenantA, (db) =>
      db.insert(forms).values({ tenantId: tenantA, title: "mine", publicSlug: slug }),
    );

    const updated = await withTenant(apiPool, tenantB, (db) =>
      db.update(forms).set({ title: "hijacked" }).where(eq(forms.publicSlug, slug)).returning(),
    );
    expect(updated).toHaveLength(0);
  });

  it("allows anonymous (no tenant set) reads of published forms only", async () => {
    const draftSlug = `rls-anon-draft-${randomUUID()}`;
    const publishedSlug = `rls-anon-pub-${randomUUID()}`;
    await withTenant(apiPool, tenantA, async (db) => {
      await db.insert(forms).values({ tenantId: tenantA, title: "draft", publicSlug: draftSlug });
      await db.insert(forms).values({
        tenantId: tenantA,
        title: "published",
        status: "published",
        publicSlug: publishedSlug,
      });
    });

    const client = await apiPool.connect();
    try {
      const pub = await client.query("SELECT id FROM forms WHERE public_slug = $1", [
        publishedSlug,
      ]);
      expect(pub.rowCount).toBe(1);

      const draft = await client.query("SELECT id FROM forms WHERE public_slug = $1", [
        draftSlug,
      ]);
      expect(draft.rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  it("lets the admin (table owner) see all tenants' rows", async () => {
    const slug = `rls-admin-${randomUUID()}`;
    await withTenant(apiPool, tenantA, (db) =>
      db.insert(forms).values({ tenantId: tenantA, title: "visible to admin", publicSlug: slug }),
    );
    const res = await adminPool.query("SELECT 1 FROM forms WHERE public_slug = $1", [slug]);
    expect(res.rowCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `pnpm --filter @eventform/db test`
Expected: PASS — all client + RLS tests. If `rejects inserting a row for another
tenant` fails, the likely cause is the API connecting as a superuser/owner role
(RLS bypassed) — verify `API_URL` uses `app_api`.

- [ ] **Step 3: Run the full workspace suite**

Run: `pnpm test`
Expected: shared (18) + db (9) all PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/db/test/rls.test.ts
git commit -m "test(db): prove tenant isolation and public-read RLS policies"
```

---

### Task 10: Developer quickstart in README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace `README.md` content**

The full recruiter-facing README is a Phase 5 deliverable; this is the working
skeleton so the repo is runnable from day one.

```markdown
# eventform

Multi-tenant form builder with webhook delivery, built on a transactional
outbox → Debezium CDC → Kafka → idempotent consumer pipeline.

> 🚧 Work in progress. Full architecture tour coming with the production
> deployment phase.

## Stack

React + shadcn/ui · NestJS · Postgres (RLS) · Drizzle · Debezium + Kafka ·
LocalStack KMS · AWS CDK + Cognito · docker-compose on EC2

## Local development

Prereqs: Node ≥ 22, pnpm, Docker.

\`\`\`bash
pnpm install
cp .env.example .env
pnpm db:up        # postgres 16 (wal_level=logical) + localstack kms
pnpm db:migrate   # tables, roles, RLS policies
pnpm test         # unit + KMS/RLS integration tests
\`\`\`

## Repo layout

- `packages/shared` — webhook HMAC utils, event schemas (zod), KMS secret cipher
- `packages/db` — Drizzle schema, migrations, tenant-scoped tx helper
- `apps/api` — NestJS REST API *(phase 2)*
- `apps/worker` — Kafka consumer + webhook sender *(phase 3)*
- `apps/web` — React frontend *(phase 4)*
- `infra` — docker-compose + AWS CDK *(phase 5)*

## Design docs

- [Design spec](docs/superpowers/specs/2026-06-11-eventform-design.md)
- [Phase 1 plan](docs/superpowers/plans/2026-06-11-eventform-phase-1-foundation.md)
```

(Strip the backslashes before the backticks — they're escaping for this plan document.)

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add development quickstart to README"
```

---

## Implementation notes (deviations from the plan as written)

Recorded after execution — the code is the source of truth:

- **LocalStack image pinned to `localstack/localstack:3`** — the `latest` tag now
  requires a Pro license (exits code 55). Healthcheck also hardened to assert
  `KeyState = Enabled` (not just key presence), ports bound to 127.0.0.1, both
  services get `restart: unless-stopped`, host material path parameterized via
  `KMS_KEY_MATERIAL_FILE`, and the boot hook handles Disabled/PendingDeletion
  key states explicitly.
- **HMAC verify hardened**: timestamp pinned to `/^\d{1,12}$/` (a decimal
  timestamp permitted a signature boundary-shift), empty secrets throw. 16
  hmac tests (plan said 9 — miscount; base was 8).
- **Event schema is `.strict()`** — producer and consumer deploy together, so
  unknown keys fail loudly. 7 event tests.
- **SecretCipher** re-exports `InvalidCiphertextException`; stub LocalStack
  credentials are injected only when an endpoint override is set and no real
  AWS creds exist. 5 kms tests (incl. tamper rejection). Shared total: 28.
- **Schema gained 6 secondary indexes** in migration 0000 (regenerated as
  `0000_rainy_lilith.sql`): partial `deliveries_retry_poll_idx`
  (next_retry_at WHERE status='retrying'), `deliveries_tenant_list_idx`,
  `submissions_form_idx`, `form_fields_form_idx`,
  `delivery_attempts_delivery_idx`, `outbox_created_idx`.
- **RLS policies use `NULLIF(current_setting('app.tenant_id', true), '')::uuid`**
  — a committed transaction-local set_config leaves an empty string (not NULL)
  on the pooled session; bare `::uuid` would make the anonymous public-read
  path error on reused connections. Also: `REVOKE ALL ON processed_events
  FROM app_api` (worker-only ledger).
- **withTenant releases poisoned clients with the error** (`client.release(err)`)
  when ROLLBACK fails, so pg-pool destroys instead of pooling a mid-transaction
  connection. The WITH CHECK rls test asserts on `DrizzleQueryError.cause`
  (drizzle wraps pg errors). db total: 10 tests (4 client + 6 rls, incl. a
  policy-parity metadata test).
- **esbuild build approval** lives in root package.json
  (`pnpm.onlyBuiltDependencies`), not `.npmrc` (`approve-builds=` is not a real
  pnpm setting).
- **Phase 5 TODO carried forward**: `REVOKE CREATE ON SCHEMA public FROM PUBLIC`
  in the prod bootstrap; rotate role passwords; generate prod KMS material file.

## Done criteria for Phase 1

- `pnpm db:up && pnpm db:migrate && pnpm test` passes from a clean checkout.
- `pg_policies` shows 9 policies; `app_worker` has BYPASSRLS; `app_api` does not.
- A KMS ciphertext created before `docker compose restart localstack` decrypts
  after it (fixed-material import works); no plaintext secret column exists.
- Phase 2 (API) can start by adding `apps/api` and importing `@eventform/db`
  and `@eventform/shared`.
