# Eventform Phase 2a — API Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the NestJS API (`apps/api`) with dev-mode auth + tenant auto-provisioning, tenant-scoped forms CRUD/publish, and webhook-endpoint CRUD with KMS-encrypted secrets — all proven by supertest e2e tests against the live Postgres/LocalStack stack.

**Architecture:** NestJS 11 (Express, CJS) app consuming `@eventform/db` (withTenant + RLS) and `@eventform/shared` (SecretCipher, generateEndpointSecret). A global `AuthGuard` resolves `Bearer dev_<sub>` tokens via a swappable `TokenVerifier` (Cognito JWKS verifier arrives in Phase 5 behind the same interface), upserts the tenant by `cognito_sub`, and attaches it to the request. Every service method runs inside `withTenant` so RLS enforces isolation; controllers translate empty results to 404 (cross-tenant rows are simply invisible). Request bodies validated by a zod pipe. Branch: `feat/phase-2-api`.

**Tech Stack:** NestJS 11, Express, zod, vitest + unplugin-swc (decorator metadata), supertest, pg/Drizzle via `@eventform/db`.

**Spec:** `docs/superpowers/specs/2026-06-11-eventform-design.md`
**Prereqs:** Phase 1 complete (40 tests green); `pnpm db:up` stack healthy. Phase 2b (public submission + outbox + deliveries API) is a separate follow-up plan.

---

## API surface in this plan

| Method/Path | Auth | Behavior |
|---|---|---|
| GET /health | public | `{ status: "ok" }` |
| GET /me | bearer | `{ tenantId, name }` (provisions tenant on first call) |
| POST /forms | bearer | create draft form `{title}` → form with generated `publicSlug` |
| GET /forms | bearer | list own forms |
| GET /forms/:id | bearer | form + ordered fields; 404 if not visible |
| PUT /forms/:id | bearer | update title |
| DELETE /forms/:id | bearer | draft-only; 409 if published |
| PUT /forms/:id/fields | bearer | replace all fields (draft-only; positions = array order) |
| POST /forms/:id/publish | bearer | draft + ≥1 field → published (one-way); 409 otherwise |
| POST /endpoints | bearer | create; returns `secret` plaintext ONCE in response |
| GET /endpoints | bearer | list (never includes secret) |
| PUT /endpoints/:id | bearer | update name/url/active |
| DELETE /endpoints/:id | bearer | delete; 409 if deliveries reference it |
| GET /endpoints/:id/secret | bearer | reveal (KMS decrypt) |
| POST /endpoints/:id/rotate | bearer | new secret, returns plaintext |

Field rules: `multiple_choice` requires 2–20 options; `text` must have none. 1–50 fields per form.
Endpoint URL: `http(s)` only (SSRF resolve-time guards are a Phase 3 worker concern — the worker makes the outbound call, not the API; note carried in plan).

## File structure created in this phase

```
apps/api/
  package.json, tsconfig.json, nest-cli.json, vitest.config.ts
  src/main.ts                       bootstrap, PORT (default 3001)
  src/app.module.ts                 wires Db/Auth/Forms/Endpoints + global pipe/guard
  src/health.controller.ts
  src/config.ts                     typed env access (single place that reads process.env)
  src/zod.pipe.ts                   ZodValidationPipe
  src/db/db.module.ts               API_POOL + SECRET_CIPHER providers, shutdown hook
  src/auth/auth.module.ts
  src/auth/token-verifier.ts        TokenVerifier interface + DI token
  src/auth/dev-token-verifier.ts    Bearer dev_<sub>
  src/auth/auth.guard.ts            global guard + @Public decorator
  src/auth/current-tenant.decorator.ts
  src/auth/tenants.service.ts       findOrCreateBySub (upsert)
  src/auth/me.controller.ts
  src/forms/forms.module.ts, forms.controller.ts, forms.service.ts, forms.schemas.ts
  src/endpoints/endpoints.module.ts, endpoints.controller.ts, endpoints.service.ts, endpoints.schemas.ts
  test/utils.ts                     createTestApp + auth helper + cleanup
  test/health.e2e.test.ts
  test/zod.pipe.test.ts
  test/auth.e2e.test.ts
  test/forms.e2e.test.ts
  test/endpoints.e2e.test.ts
```

---

### Task 1: NestJS app scaffold + health endpoint

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/nest-cli.json`
- Create: `apps/api/vitest.config.ts`
- Create: `apps/api/src/main.ts`
- Create: `apps/api/src/app.module.ts`
- Create: `apps/api/src/health.controller.ts`
- Create: `apps/api/src/config.ts`
- Test: `apps/api/test/health.e2e.test.ts`
- Modify: `.env.example` (add PORT)

- [ ] **Step 1: Write `apps/api/package.json`**

```json
{
  "name": "@eventform/api",
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
    "pg": "^8.16.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@nestjs/cli": "^11.0.0",
    "@nestjs/testing": "^11.0.0",
    "@swc/core": "^1.10.0",
    "@types/express": "^5.0.0",
    "@types/node": "^22.0.0",
    "@types/supertest": "^6.0.0",
    "supertest": "^7.0.0",
    "typescript": "^5.8.0",
    "unplugin-swc": "^1.5.0",
    "vitest": "^3.0.0"
  }
}
```
(If a range fails to resolve, use the closest current stable and report the deviation.)

- [ ] **Step 2: Write `apps/api/tsconfig.json`**

Nest needs decorators + metadata; the app emits CJS and is never published, so a
self-contained config is simpler than extending the NodeNext base:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "sourceMap": true,
    "outDir": "dist",
    "baseUrl": "."
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `apps/api/nest-cli.json`**

```json
{
  "$schema": "https://json-schema.org/schema",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": { "deleteOutDir": true }
}
```

- [ ] **Step 4: Write `apps/api/vitest.config.ts`**

esbuild does not emit decorator metadata — the SWC plugin does. This config is
load-bearing; do not swap it for plain vitest.

```ts
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20000,
    passWithNoTests: true,
  },
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: "es2022",
      },
      module: { type: "commonjs" },
    }),
  ],
});
```

- [ ] **Step 5: Write `apps/api/src/config.ts`**

The single place that reads process.env. Everything else injects nothing —
plain functions are enough at this scale.

```ts
export interface ApiConfig {
  port: number;
  databaseUrlApi: string;
  databaseUrlAdmin: string;
  authMode: "dev" | "cognito";
  kmsKeyId: string;
  awsEndpointUrl: string | undefined;
  awsRegion: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    port: Number(env.PORT ?? 3001),
    databaseUrlApi:
      env.DATABASE_URL_API ?? "postgres://app_api:app_api_dev@localhost:5432/eventform",
    databaseUrlAdmin:
      env.DATABASE_URL ?? "postgres://eventform:eventform@localhost:5432/eventform",
    authMode: env.AUTH_MODE === "cognito" ? "cognito" : "dev",
    kmsKeyId: env.KMS_KEY_ID ?? "alias/eventform-endpoint-secrets",
    awsEndpointUrl: env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
    awsRegion: env.AWS_REGION ?? "us-east-1",
  };
}
```

(`databaseUrlAdmin` is used only by tests for fixtures/cleanup, never by app code.)

- [ ] **Step 6: Write `apps/api/src/health.controller.ts`**

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

- [ ] **Step 7: Write `apps/api/src/app.module.ts`** (minimal now; later tasks extend it)

```ts
import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";

@Module({
  controllers: [HealthController],
})
export class AppModule {}
```

- [ ] **Step 8: Write `apps/api/src/main.ts`**

```ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadConfig } from "./config";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const { port } = loadConfig();
  await app.listen(port);
}

void bootstrap();
```

- [ ] **Step 9: Write the e2e test `apps/api/test/health.e2e.test.ts`**

```ts
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";

describe("GET /health", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns ok without auth", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
```

- [ ] **Step 10: Install, test, build**

Run: `pnpm install && pnpm --filter @eventform/api test`
Expected: 1 passing.
Run: `pnpm --filter @eventform/api build`
Expected: `dist/main.js` exists.
Run: `pnpm test` (root)
Expected: 41 total green (28 shared + 12 db + 1 api).

- [ ] **Step 11: Add `PORT=3001` to `.env.example`** (new line under the AWS block, with a `# api` comment header)

- [ ] **Step 12: Commit**

```bash
git add apps/api .env.example pnpm-lock.yaml
git commit -m "feat(api): scaffold nestjs app with health endpoint"
```

---

### Task 2: DbModule — pool + SecretCipher providers

**Files:**
- Create: `apps/api/src/db/db.module.ts`
- Modify: `apps/api/src/app.module.ts`

No dedicated test — exercised by every later e2e suite; the boot path is covered
by the existing health e2e (module compiles or every test fails).

- [ ] **Step 1: Write `apps/api/src/db/db.module.ts`**

```ts
import { Global, Inject, Module, OnApplicationShutdown } from "@nestjs/common";
import { Pool } from "pg";
import { createPool } from "@eventform/db";
import { SecretCipher } from "@eventform/shared";
import { loadConfig } from "../config";

export const API_POOL = "API_POOL";
export const SECRET_CIPHER = "SECRET_CIPHER";

@Global()
@Module({
  providers: [
    {
      provide: API_POOL,
      useFactory: (): Pool => createPool(loadConfig().databaseUrlApi),
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
  exports: [API_POOL, SECRET_CIPHER],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(API_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
```

- [ ] **Step 2: Import DbModule in `app.module.ts`** (`imports: [DbModule]`)

- [ ] **Step 3: Verify**

Run: `pnpm --filter @eventform/api test && pnpm --filter @eventform/api build`
Expected: still green, builds clean.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): add db module providing api pool and kms secret cipher"
```

---

### Task 3: ZodValidationPipe (TDD)

**Files:**
- Create: `apps/api/src/zod.pipe.ts`
- Test: `apps/api/test/zod.pipe.test.ts`

- [ ] **Step 1: Write the failing test `apps/api/test/zod.pipe.test.ts`**

```ts
import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ZodValidationPipe } from "../src/zod.pipe";

const schema = z.object({ title: z.string().min(1) }).strict();
const pipe = new ZodValidationPipe(schema);

describe("ZodValidationPipe", () => {
  it("returns the parsed value on success", () => {
    expect(pipe.transform({ title: "hi" })).toEqual({ title: "hi" });
  });

  it("throws BadRequestException with field details on failure", () => {
    try {
      pipe.transform({ title: "" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const body = (err as BadRequestException).getResponse() as Record<string, unknown>;
      expect(JSON.stringify(body.errors)).toContain("title");
    }
  });

  it("rejects unknown keys (strict schemas)", () => {
    expect(() => pipe.transform({ title: "hi", extra: 1 })).toThrow(BadRequestException);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @eventform/api test -- zod` → cannot find module.

- [ ] **Step 3: Write `apps/api/src/zod.pipe.ts`**

```ts
import { BadRequestException, Injectable, PipeTransform } from "@nestjs/common";
import { ZodError, ZodType } from "zod";

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    try {
      return this.schema.parse(value);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException({
          message: "Validation failed",
          errors: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run tests** — `pnpm --filter @eventform/api test` → all green (4 total in api).

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): add zod validation pipe"
```

---

### Task 4: Auth — dev token verifier, global guard, tenant provisioning (TDD)

**Files:**
- Create: `apps/api/src/auth/token-verifier.ts`
- Create: `apps/api/src/auth/dev-token-verifier.ts`
- Create: `apps/api/src/auth/tenants.service.ts`
- Create: `apps/api/src/auth/auth.guard.ts`
- Create: `apps/api/src/auth/current-tenant.decorator.ts`
- Create: `apps/api/src/auth/me.controller.ts`
- Create: `apps/api/src/auth/auth.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/auth.e2e.test.ts`
- Modify: `.env.example` (add `AUTH_MODE=dev`)

Dev tokens: `Authorization: Bearer dev_<sub>` where `<sub>` matches
`/^[A-Za-z0-9_-]{1,64}$/`. The Cognito JWKS verifier lands in Phase 5 behind the
same `TokenVerifier` interface; with `AUTH_MODE=cognito` the factory throws at
boot (fail loud, no silent fallback to dev).

- [ ] **Step 1: Write the failing e2e test `apps/api/test/auth.e2e.test.ts`**

```ts
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { createPool } from "@eventform/db";
import { AppModule } from "../src/app.module";
import { loadConfig } from "../src/config";

describe("auth", () => {
  let app: INestApplication;
  let adminPool: Pool;
  const sub = `auth-e2e-${randomUUID()}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    adminPool = createPool(loadConfig().databaseUrlAdmin);
  });

  afterAll(async () => {
    await adminPool.query("DELETE FROM tenants WHERE cognito_sub = $1", [sub]);
    await adminPool.end();
    await app.close();
  });

  it("rejects requests without a bearer token", async () => {
    await request(app.getHttpServer()).get("/me").expect(401);
  });

  it("rejects malformed dev tokens", async () => {
    await request(app.getHttpServer())
      .get("/me")
      .set("Authorization", "Bearer dev_!!bad!!")
      .expect(401);
    await request(app.getHttpServer())
      .get("/me")
      .set("Authorization", "Bearer not-a-dev-token")
      .expect(401);
  });

  it("provisions a tenant on first valid request and returns it", async () => {
    const res = await request(app.getHttpServer())
      .get("/me")
      .set("Authorization", `Bearer dev_${sub}`)
      .expect(200);
    expect(res.body.tenantId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.name).toBe(sub);

    const row = await adminPool.query("SELECT id FROM tenants WHERE cognito_sub = $1", [sub]);
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].id).toBe(res.body.tenantId);
  });

  it("is idempotent — same sub maps to the same tenant", async () => {
    const a = await request(app.getHttpServer())
      .get("/me")
      .set("Authorization", `Bearer dev_${sub}`)
      .expect(200);
    const b = await request(app.getHttpServer())
      .get("/me")
      .set("Authorization", `Bearer dev_${sub}`)
      .expect(200);
    expect(a.body.tenantId).toBe(b.body.tenantId);
  });

  it("keeps /health public", async () => {
    await request(app.getHttpServer()).get("/health").expect(200);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `/me` returns 404 (no route) instead of expectations → red.

- [ ] **Step 3: Write `apps/api/src/auth/token-verifier.ts`**

```ts
export const TOKEN_VERIFIER = "TOKEN_VERIFIER";

/** Verifies a bearer token and returns the stable subject (cognito_sub). Throws on invalid. */
export interface TokenVerifier {
  verify(token: string): Promise<string>;
}
```

- [ ] **Step 4: Write `apps/api/src/auth/dev-token-verifier.ts`**

```ts
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { TokenVerifier } from "./token-verifier";

const DEV_TOKEN_RE = /^dev_([A-Za-z0-9_-]{1,64})$/;

@Injectable()
export class DevTokenVerifier implements TokenVerifier {
  async verify(token: string): Promise<string> {
    const match = DEV_TOKEN_RE.exec(token);
    if (!match) {
      throw new UnauthorizedException("invalid token");
    }
    return match[1];
  }
}
```

- [ ] **Step 5: Write `apps/api/src/auth/tenants.service.ts`**

`tenants` has no RLS (lookup table); the api role has INSERT/SELECT grants.

```ts
import { Inject, Injectable } from "@nestjs/common";
import { Pool } from "pg";
import { API_POOL } from "../db/db.module";

export interface Tenant {
  id: string;
  name: string;
}

@Injectable()
export class TenantsService {
  constructor(@Inject(API_POOL) private readonly pool: Pool) {}

  async findOrCreateBySub(sub: string): Promise<Tenant> {
    const res = await this.pool.query(
      `INSERT INTO tenants (name, cognito_sub) VALUES ($1, $2)
       ON CONFLICT (cognito_sub) DO UPDATE SET cognito_sub = EXCLUDED.cognito_sub
       RETURNING id, name`,
      [sub, sub],
    );
    return res.rows[0];
  }
}
```

(The no-op `DO UPDATE` makes `RETURNING` work on the conflict path — a plain
`DO NOTHING` returns zero rows for existing tenants.)

- [ ] **Step 6: Write `apps/api/src/auth/auth.guard.ts`**

```ts
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { TOKEN_VERIFIER, TokenVerifier } from "./token-verifier";
import { Tenant, TenantsService } from "./tenants.service";

export const IS_PUBLIC_KEY = "isPublic";
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export interface AuthedRequest extends Request {
  tenant: Tenant;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    private readonly tenants: TenantsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("missing bearer token");
    }
    const sub = await this.verifier.verify(header.slice("Bearer ".length));
    req.tenant = await this.tenants.findOrCreateBySub(sub);
    return true;
  }
}
```

- [ ] **Step 7: Write `apps/api/src/auth/current-tenant.decorator.ts`**

```ts
import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { AuthedRequest } from "./auth.guard";
import type { Tenant } from "./tenants.service";

export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Tenant =>
    ctx.switchToHttp().getRequest<AuthedRequest>().tenant,
);
```

- [ ] **Step 8: Write `apps/api/src/auth/me.controller.ts`**

```ts
import { Controller, Get } from "@nestjs/common";
import { CurrentTenant } from "./current-tenant.decorator";
import { Tenant } from "./tenants.service";

@Controller("me")
export class MeController {
  @Get()
  me(@CurrentTenant() tenant: Tenant) {
    return { tenantId: tenant.id, name: tenant.name };
  }
}
```

- [ ] **Step 9: Write `apps/api/src/auth/auth.module.ts`** and wire into AppModule

```ts
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { loadConfig } from "../config";
import { AuthGuard } from "./auth.guard";
import { DevTokenVerifier } from "./dev-token-verifier";
import { MeController } from "./me.controller";
import { TenantsService } from "./tenants.service";
import { TOKEN_VERIFIER } from "./token-verifier";

@Module({
  controllers: [MeController],
  providers: [
    TenantsService,
    {
      provide: TOKEN_VERIFIER,
      useFactory: () => {
        if (loadConfig().authMode !== "dev") {
          throw new Error("AUTH_MODE=cognito requires the Phase 5 Cognito verifier");
        }
        return new DevTokenVerifier();
      },
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [TenantsService],
})
export class AuthModule {}
```

In `app.module.ts`: add `AuthModule` to imports, and add `@Public()` to
`HealthController` (class-level) so health stays open:

```ts
// health.controller.ts
import { Controller, Get } from "@nestjs/common";
import { Public } from "./auth/auth.guard";

@Public()
@Controller("health")
export class HealthController {
  @Get()
  health() {
    return { status: "ok" };
  }
}
```

- [ ] **Step 10: Run tests** — `pnpm --filter @eventform/api test` → all green (9 api tests). Add `AUTH_MODE=dev` to `.env.example`.

- [ ] **Step 11: Commit**

```bash
git add apps/api .env.example
git commit -m "feat(api): add dev-mode auth guard with tenant auto-provisioning"
```

---

### Task 5: Forms module — CRUD, fields, publish (TDD)

**Files:**
- Create: `apps/api/src/forms/forms.schemas.ts`
- Create: `apps/api/src/forms/forms.service.ts`
- Create: `apps/api/src/forms/forms.controller.ts`
- Create: `apps/api/src/forms/forms.module.ts`
- Create: `apps/api/test/utils.ts`
- Test: `apps/api/test/forms.e2e.test.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Write `apps/api/test/utils.ts`** (shared by forms/endpoints suites)

```ts
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { Pool } from "pg";
import request from "supertest";
import { createPool } from "@eventform/db";
import { AppModule } from "../src/app.module";
import { loadConfig } from "../src/config";

export interface TestContext {
  app: INestApplication;
  adminPool: Pool;
  http: () => ReturnType<typeof request>;
  authed: (sub: string) => { Authorization: string };
  cleanupSubs: (subs: string[]) => Promise<void>;
  close: () => Promise<void>;
}

export async function createTestApp(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  const adminPool = createPool(loadConfig().databaseUrlAdmin);

  return {
    app,
    adminPool,
    http: () => request(app.getHttpServer()),
    authed: (sub: string) => ({ Authorization: `Bearer dev_${sub}` }),
    cleanupSubs: async (subs: string[]) => {
      // delete in FK order; deliveries/submissions don't exist in 2a fixtures
      await adminPool.query(
        `DELETE FROM form_fields WHERE tenant_id IN (SELECT id FROM tenants WHERE cognito_sub = ANY($1))`,
        [subs],
      );
      await adminPool.query(
        `DELETE FROM forms WHERE tenant_id IN (SELECT id FROM tenants WHERE cognito_sub = ANY($1))`,
        [subs],
      );
      await adminPool.query(
        `DELETE FROM endpoints WHERE tenant_id IN (SELECT id FROM tenants WHERE cognito_sub = ANY($1))`,
        [subs],
      );
      await adminPool.query(`DELETE FROM tenants WHERE cognito_sub = ANY($1)`, [subs]);
    },
    close: async () => {
      await adminPool.end();
      await app.close();
    },
  };
}
```

- [ ] **Step 2: Write the failing e2e test `apps/api/test/forms.e2e.test.ts`**

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, TestContext } from "./utils";

describe("forms", () => {
  let t: TestContext;
  const subA = `forms-a-${randomUUID()}`;
  const subB = `forms-b-${randomUUID()}`;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.cleanupSubs([subA, subB]);
    await t.close();
  });

  const FIELDS = {
    fields: [
      { type: "text", label: "Your name", required: true },
      { type: "multiple_choice", label: "Rating", options: ["Good", "Bad"], required: false },
    ],
  };

  it("creates a draft form with a public slug", async () => {
    const res = await t.http().post("/forms").set(t.authed(subA)).send({ title: "Feedback" }).expect(201);
    expect(res.body).toMatchObject({ title: "Feedback", status: "draft" });
    expect(res.body.publicSlug).toMatch(/^[A-Za-z0-9_-]{8,}$/);
  });

  it("rejects an empty title", async () => {
    await t.http().post("/forms").set(t.authed(subA)).send({ title: "" }).expect(400);
  });

  it("lists only the caller's forms", async () => {
    await t.http().post("/forms").set(t.authed(subB)).send({ title: "B form" }).expect(201);
    const listA = await t.http().get("/forms").set(t.authed(subA)).expect(200);
    expect(listA.body.every((f: { title: string }) => f.title !== "B form")).toBe(true);
  });

  it("replaces fields and returns them ordered", async () => {
    const form = await t.http().post("/forms").set(t.authed(subA)).send({ title: "F" }).expect(201);
    await t.http().put(`/forms/${form.body.id}/fields`).set(t.authed(subA)).send(FIELDS).expect(200);
    const got = await t.http().get(`/forms/${form.body.id}`).set(t.authed(subA)).expect(200);
    expect(got.body.fields).toHaveLength(2);
    expect(got.body.fields[0]).toMatchObject({ label: "Your name", position: 0 });
    expect(got.body.fields[1]).toMatchObject({ label: "Rating", position: 1, options: ["Good", "Bad"] });
  });

  it("rejects multiple_choice without options and text with options", async () => {
    const form = await t.http().post("/forms").set(t.authed(subA)).send({ title: "V" }).expect(201);
    await t.http()
      .put(`/forms/${form.body.id}/fields`)
      .set(t.authed(subA))
      .send({ fields: [{ type: "multiple_choice", label: "Pick", required: false }] })
      .expect(400);
    await t.http()
      .put(`/forms/${form.body.id}/fields`)
      .set(t.authed(subA))
      .send({ fields: [{ type: "text", label: "T", options: ["x", "y"], required: false }] })
      .expect(400);
  });

  it("publishes a form with fields; publish is one-way and requires fields", async () => {
    const empty = await t.http().post("/forms").set(t.authed(subA)).send({ title: "E" }).expect(201);
    await t.http().post(`/forms/${empty.body.id}/publish`).set(t.authed(subA)).expect(409);

    const form = await t.http().post("/forms").set(t.authed(subA)).send({ title: "P" }).expect(201);
    await t.http().put(`/forms/${form.body.id}/fields`).set(t.authed(subA)).send(FIELDS).expect(200);
    const pub = await t.http().post(`/forms/${form.body.id}/publish`).set(t.authed(subA)).expect(201);
    expect(pub.body.status).toBe("published");
    await t.http().post(`/forms/${form.body.id}/publish`).set(t.authed(subA)).expect(409);
  });

  it("locks fields and deletion after publish", async () => {
    const form = await t.http().post("/forms").set(t.authed(subA)).send({ title: "L" }).expect(201);
    await t.http().put(`/forms/${form.body.id}/fields`).set(t.authed(subA)).send(FIELDS).expect(200);
    await t.http().post(`/forms/${form.body.id}/publish`).set(t.authed(subA)).expect(201);
    await t.http().put(`/forms/${form.body.id}/fields`).set(t.authed(subA)).send(FIELDS).expect(409);
    await t.http().delete(`/forms/${form.body.id}`).set(t.authed(subA)).expect(409);
  });

  it("updates the title", async () => {
    const form = await t.http().post("/forms").set(t.authed(subA)).send({ title: "Old" }).expect(201);
    const res = await t.http().put(`/forms/${form.body.id}`).set(t.authed(subA)).send({ title: "New" }).expect(200);
    expect(res.body.title).toBe("New");
  });

  it("deletes a draft form", async () => {
    const form = await t.http().post("/forms").set(t.authed(subA)).send({ title: "Gone" }).expect(201);
    await t.http().delete(`/forms/${form.body.id}`).set(t.authed(subA)).expect(204);
    await t.http().get(`/forms/${form.body.id}`).set(t.authed(subA)).expect(404);
  });

  it("returns 404 for another tenant's form (RLS through the API)", async () => {
    const form = await t.http().post("/forms").set(t.authed(subA)).send({ title: "Mine" }).expect(201);
    await t.http().get(`/forms/${form.body.id}`).set(t.authed(subB)).expect(404);
    await t.http().put(`/forms/${form.body.id}`).set(t.authed(subB)).send({ title: "x" }).expect(404);
    await t.http().delete(`/forms/${form.body.id}`).set(t.authed(subB)).expect(404);
  });

  it("returns 400 for a non-uuid form id", async () => {
    await t.http().get("/forms/not-a-uuid").set(t.authed(subA)).expect(400);
  });
});
```

- [ ] **Step 3: Run to verify failure** — routes 404 → red.

- [ ] **Step 4: Write `apps/api/src/forms/forms.schemas.ts`**

```ts
import { z } from "zod";

export const createFormSchema = z.object({ title: z.string().min(1).max(200) }).strict();
export const updateFormSchema = createFormSchema;

const fieldSchema = z
  .object({
    type: z.enum(["text", "multiple_choice"]),
    label: z.string().min(1).max(500),
    options: z.array(z.string().min(1).max(200)).min(2).max(20).optional(),
    required: z.boolean().default(false),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (field.type === "multiple_choice" && !field.options) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "multiple_choice requires options" });
    }
    if (field.type === "text" && field.options) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "text fields cannot have options" });
    }
  });

export const replaceFieldsSchema = z
  .object({ fields: z.array(fieldSchema).min(1).max(50) })
  .strict();

export type CreateFormDto = z.infer<typeof createFormSchema>;
export type ReplaceFieldsDto = z.infer<typeof replaceFieldsSchema>;

export const uuidSchema = z.string().uuid();
```

- [ ] **Step 5: Write `apps/api/src/forms/forms.service.ts`**

```ts
import { randomBytes } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { asc, eq } from "drizzle-orm";
import { formFields, forms, withTenant } from "@eventform/db";
import { API_POOL } from "../db/db.module";
import { CreateFormDto, ReplaceFieldsDto } from "./forms.schemas";

@Injectable()
export class FormsService {
  constructor(@Inject(API_POOL) private readonly pool: Pool) {}

  create(tenantId: string, dto: CreateFormDto) {
    return withTenant(this.pool, tenantId, async (db) => {
      const [form] = await db
        .insert(forms)
        .values({
          tenantId,
          title: dto.title,
          publicSlug: randomBytes(6).toString("base64url"),
        })
        .returning();
      return form;
    });
  }

  list(tenantId: string) {
    return withTenant(this.pool, tenantId, (db) =>
      db.select().from(forms).orderBy(asc(forms.createdAt)),
    );
  }

  async getWithFields(tenantId: string, formId: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const [form] = await db.select().from(forms).where(eq(forms.id, formId));
      if (!form) {
        throw new NotFoundException("form not found");
      }
      const fields = await db
        .select()
        .from(formFields)
        .where(eq(formFields.formId, formId))
        .orderBy(asc(formFields.position));
      return { ...form, fields };
    });
  }

  async updateTitle(tenantId: string, formId: string, dto: CreateFormDto) {
    return withTenant(this.pool, tenantId, async (db) => {
      const [form] = await db
        .update(forms)
        .set({ title: dto.title })
        .where(eq(forms.id, formId))
        .returning();
      if (!form) {
        throw new NotFoundException("form not found");
      }
      return form;
    });
  }

  async remove(tenantId: string, formId: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const [form] = await db.select().from(forms).where(eq(forms.id, formId));
      if (!form) {
        throw new NotFoundException("form not found");
      }
      if (form.status !== "draft") {
        throw new ConflictException("published forms cannot be deleted");
      }
      await db.delete(forms).where(eq(forms.id, formId)); // fields cascade
    });
  }

  async replaceFields(tenantId: string, formId: string, dto: ReplaceFieldsDto) {
    return withTenant(this.pool, tenantId, async (db) => {
      const [form] = await db.select().from(forms).where(eq(forms.id, formId));
      if (!form) {
        throw new NotFoundException("form not found");
      }
      if (form.status !== "draft") {
        throw new ConflictException("published forms cannot be edited");
      }
      await db.delete(formFields).where(eq(formFields.formId, formId));
      const rows = await db
        .insert(formFields)
        .values(
          dto.fields.map((f, position) => ({
            formId,
            tenantId,
            type: f.type,
            label: f.label,
            options: f.options ?? null,
            required: f.required,
            position,
          })),
        )
        .returning();
      return rows;
    });
  }

  async publish(tenantId: string, formId: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const [form] = await db.select().from(forms).where(eq(forms.id, formId));
      if (!form) {
        throw new NotFoundException("form not found");
      }
      if (form.status !== "draft") {
        throw new ConflictException("form is already published");
      }
      const fields = await db.select().from(formFields).where(eq(formFields.formId, formId));
      if (fields.length === 0) {
        throw new ConflictException("cannot publish a form without fields");
      }
      const [updated] = await db
        .update(forms)
        .set({ status: "published" })
        .where(eq(forms.id, formId))
        .returning();
      return updated;
    });
  }
}
```

- [ ] **Step 6: Write `apps/api/src/forms/forms.controller.ts`**

```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import { CurrentTenant } from "../auth/current-tenant.decorator";
import { Tenant } from "../auth/tenants.service";
import { ZodValidationPipe } from "../zod.pipe";
import {
  CreateFormDto,
  createFormSchema,
  ReplaceFieldsDto,
  replaceFieldsSchema,
  updateFormSchema,
  uuidSchema,
} from "./forms.schemas";
import { FormsService } from "./forms.service";

const uuidPipe = new ZodValidationPipe(uuidSchema);

@Controller("forms")
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  @Post()
  create(
    @CurrentTenant() tenant: Tenant,
    @Body(new ZodValidationPipe(createFormSchema)) dto: CreateFormDto,
  ) {
    return this.forms.create(tenant.id, dto);
  }

  @Get()
  list(@CurrentTenant() tenant: Tenant) {
    return this.forms.list(tenant.id);
  }

  @Get(":id")
  get(@CurrentTenant() tenant: Tenant, @Param("id", uuidPipe) id: string) {
    return this.forms.getWithFields(tenant.id, id);
  }

  @Put(":id")
  update(
    @CurrentTenant() tenant: Tenant,
    @Param("id", uuidPipe) id: string,
    @Body(new ZodValidationPipe(updateFormSchema)) dto: CreateFormDto,
  ) {
    return this.forms.updateTitle(tenant.id, id, dto);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@CurrentTenant() tenant: Tenant, @Param("id", uuidPipe) id: string) {
    return this.forms.remove(tenant.id, id);
  }

  @Put(":id/fields")
  @HttpCode(200)
  replaceFields(
    @CurrentTenant() tenant: Tenant,
    @Param("id", uuidPipe) id: string,
    @Body(new ZodValidationPipe(replaceFieldsSchema)) dto: ReplaceFieldsDto,
  ) {
    return this.forms.replaceFields(tenant.id, id, dto);
  }

  @Post(":id/publish")
  publish(@CurrentTenant() tenant: Tenant, @Param("id", uuidPipe) id: string) {
    return this.forms.publish(tenant.id, id);
  }
}
```

- [ ] **Step 7: Write `apps/api/src/forms/forms.module.ts`** and add to AppModule imports

```ts
import { Module } from "@nestjs/common";
import { FormsController } from "./forms.controller";
import { FormsService } from "./forms.service";

@Module({
  controllers: [FormsController],
  providers: [FormsService],
})
export class FormsModule {}
```

- [ ] **Step 8: Run tests** — `pnpm --filter @eventform/api test` → all green (20 api tests). Run twice (cleanup idempotent).

- [ ] **Step 9: Commit**

```bash
git add apps/api
git commit -m "feat(api): add forms crud, field replacement, and publish flow"
```

---

### Task 6: Endpoints module — CRUD with KMS-encrypted secrets (TDD)

**Files:**
- Create: `apps/api/src/endpoints/endpoints.schemas.ts`
- Create: `apps/api/src/endpoints/endpoints.service.ts`
- Create: `apps/api/src/endpoints/endpoints.controller.ts`
- Create: `apps/api/src/endpoints/endpoints.module.ts`
- Test: `apps/api/test/endpoints.e2e.test.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Write the failing e2e test `apps/api/test/endpoints.e2e.test.ts`**

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, TestContext } from "./utils";

describe("endpoints", () => {
  let t: TestContext;
  const subA = `ep-a-${randomUUID()}`;
  const subB = `ep-b-${randomUUID()}`;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.cleanupSubs([subA, subB]);
    await t.close();
  });

  it("creates an endpoint and returns the secret exactly once", async () => {
    const res = await t.http()
      .post("/endpoints")
      .set(t.authed(subA))
      .send({ name: "CI hook", url: "https://example.com/hook" })
      .expect(201);
    expect(res.body.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(res.body).toMatchObject({ name: "CI hook", url: "https://example.com/hook", active: true });

    const list = await t.http().get("/endpoints").set(t.authed(subA)).expect(200);
    expect(list.body[0].secret).toBeUndefined();
    expect(list.body[0].secretCiphertext).toBeUndefined();
  });

  it("stores only ciphertext at rest", async () => {
    const res = await t.http()
      .post("/endpoints")
      .set(t.authed(subA))
      .send({ name: "At rest", url: "https://example.com/x" })
      .expect(201);
    const row = await t.adminPool.query(
      "SELECT secret_ciphertext FROM endpoints WHERE id = $1",
      [res.body.id],
    );
    expect(row.rows[0].secret_ciphertext).not.toContain(res.body.secret);
    expect(row.rows[0].secret_ciphertext).not.toMatch(/^whsec_/);
  });

  it("reveals the secret via KMS decrypt", async () => {
    const created = await t.http()
      .post("/endpoints")
      .set(t.authed(subA))
      .send({ name: "Reveal", url: "https://example.com/r" })
      .expect(201);
    const revealed = await t.http()
      .get(`/endpoints/${created.body.id}/secret`)
      .set(t.authed(subA))
      .expect(200);
    expect(revealed.body.secret).toBe(created.body.secret);
  });

  it("rotates the secret", async () => {
    const created = await t.http()
      .post("/endpoints")
      .set(t.authed(subA))
      .send({ name: "Rotate", url: "https://example.com/ro" })
      .expect(201);
    const rotated = await t.http()
      .post(`/endpoints/${created.body.id}/rotate`)
      .set(t.authed(subA))
      .expect(201);
    expect(rotated.body.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(rotated.body.secret).not.toBe(created.body.secret);
    const revealed = await t.http()
      .get(`/endpoints/${created.body.id}/secret`)
      .set(t.authed(subA))
      .expect(200);
    expect(revealed.body.secret).toBe(rotated.body.secret);
  });

  it("updates name/url/active", async () => {
    const created = await t.http()
      .post("/endpoints")
      .set(t.authed(subA))
      .send({ name: "U", url: "https://example.com/u" })
      .expect(201);
    const res = await t.http()
      .put(`/endpoints/${created.body.id}`)
      .set(t.authed(subA))
      .send({ active: false, name: "U2" })
      .expect(200);
    expect(res.body).toMatchObject({ active: false, name: "U2" });
  });

  it("rejects non-http(s) urls", async () => {
    await t.http()
      .post("/endpoints")
      .set(t.authed(subA))
      .send({ name: "ftp", url: "ftp://example.com" })
      .expect(400);
  });

  it("deletes an endpoint", async () => {
    const created = await t.http()
      .post("/endpoints")
      .set(t.authed(subA))
      .send({ name: "Del", url: "https://example.com/d" })
      .expect(201);
    await t.http().delete(`/endpoints/${created.body.id}`).set(t.authed(subA)).expect(204);
    await t.http().get(`/endpoints/${created.body.id}/secret`).set(t.authed(subA)).expect(404);
  });

  it("isolates endpoints between tenants (404 cross-tenant)", async () => {
    const created = await t.http()
      .post("/endpoints")
      .set(t.authed(subA))
      .send({ name: "Iso", url: "https://example.com/i" })
      .expect(201);
    await t.http().get(`/endpoints/${created.body.id}/secret`).set(t.authed(subB)).expect(404);
    await t.http().post(`/endpoints/${created.body.id}/rotate`).set(t.authed(subB)).expect(404);
    await t.http().delete(`/endpoints/${created.body.id}`).set(t.authed(subB)).expect(404);
  });
});
```

- [ ] **Step 2: Run to verify failure** — red (no routes).

- [ ] **Step 3: Write `apps/api/src/endpoints/endpoints.schemas.ts`**

```ts
import { z } from "zod";

const httpUrl = z
  .string()
  .url()
  .max(2000)
  .refine((u) => u.startsWith("http://") || u.startsWith("https://"), {
    message: "url must be http(s)",
  });

export const createEndpointSchema = z
  .object({ name: z.string().min(1).max(100), url: httpUrl })
  .strict();

export const updateEndpointSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    url: httpUrl.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: "empty update" });

export type CreateEndpointDto = z.infer<typeof createEndpointSchema>;
export type UpdateEndpointDto = z.infer<typeof updateEndpointSchema>;
```

- [ ] **Step 4: Write `apps/api/src/endpoints/endpoints.service.ts`**

Note the response shaping: `secretCiphertext` never leaves the service.

```ts
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { asc, eq } from "drizzle-orm";
import { endpoints, withTenant } from "@eventform/db";
import { generateEndpointSecret, SecretCipher } from "@eventform/shared";
import { API_POOL, SECRET_CIPHER } from "../db/db.module";
import { CreateEndpointDto, UpdateEndpointDto } from "./endpoints.schemas";

type EndpointRow = typeof endpoints.$inferSelect;

function publicView(row: EndpointRow) {
  const { secretCiphertext: _omitted, ...rest } = row;
  return rest;
}

@Injectable()
export class EndpointsService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipher,
  ) {}

  async create(tenantId: string, dto: CreateEndpointDto) {
    const secret = generateEndpointSecret();
    const secretCiphertext = await this.cipher.encrypt(secret, tenantId);
    const row = await withTenant(this.pool, tenantId, async (db) => {
      const [created] = await db
        .insert(endpoints)
        .values({ tenantId, name: dto.name, url: dto.url, secretCiphertext })
        .returning();
      return created;
    });
    return { ...publicView(row), secret };
  }

  list(tenantId: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const rows = await db.select().from(endpoints).orderBy(asc(endpoints.createdAt));
      return rows.map(publicView);
    });
  }

  async update(tenantId: string, id: string, dto: UpdateEndpointDto) {
    const row = await withTenant(this.pool, tenantId, async (db) => {
      const [updated] = await db
        .update(endpoints)
        .set(dto)
        .where(eq(endpoints.id, id))
        .returning();
      return updated;
    });
    if (!row) {
      throw new NotFoundException("endpoint not found");
    }
    return publicView(row);
  }

  async remove(tenantId: string, id: string) {
    const removed = await withTenant(this.pool, tenantId, async (db) => {
      const rows = await db.delete(endpoints).where(eq(endpoints.id, id)).returning();
      return rows[0];
    });
    if (!removed) {
      throw new NotFoundException("endpoint not found");
    }
  }

  async revealSecret(tenantId: string, id: string) {
    const row = await withTenant(this.pool, tenantId, async (db) => {
      const [found] = await db.select().from(endpoints).where(eq(endpoints.id, id));
      return found;
    });
    if (!row) {
      throw new NotFoundException("endpoint not found");
    }
    const secret = await this.cipher.decrypt(row.secretCiphertext, tenantId);
    return { secret };
  }

  async rotateSecret(tenantId: string, id: string) {
    const secret = generateEndpointSecret();
    const secretCiphertext = await this.cipher.encrypt(secret, tenantId);
    const row = await withTenant(this.pool, tenantId, async (db) => {
      const [updated] = await db
        .update(endpoints)
        .set({ secretCiphertext })
        .where(eq(endpoints.id, id))
        .returning();
      return updated;
    });
    if (!row) {
      throw new NotFoundException("endpoint not found");
    }
    return { ...publicView(row), secret };
  }
}
```

- [ ] **Step 5: Write `apps/api/src/endpoints/endpoints.controller.ts`**

```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import { CurrentTenant } from "../auth/current-tenant.decorator";
import { Tenant } from "../auth/tenants.service";
import { uuidSchema } from "../forms/forms.schemas";
import { ZodValidationPipe } from "../zod.pipe";
import {
  CreateEndpointDto,
  createEndpointSchema,
  UpdateEndpointDto,
  updateEndpointSchema,
} from "./endpoints.schemas";
import { EndpointsService } from "./endpoints.service";

const uuidPipe = new ZodValidationPipe(uuidSchema);

@Controller("endpoints")
export class EndpointsController {
  constructor(private readonly endpoints: EndpointsService) {}

  @Post()
  create(
    @CurrentTenant() tenant: Tenant,
    @Body(new ZodValidationPipe(createEndpointSchema)) dto: CreateEndpointDto,
  ) {
    return this.endpoints.create(tenant.id, dto);
  }

  @Get()
  list(@CurrentTenant() tenant: Tenant) {
    return this.endpoints.list(tenant.id);
  }

  @Put(":id")
  update(
    @CurrentTenant() tenant: Tenant,
    @Param("id", uuidPipe) id: string,
    @Body(new ZodValidationPipe(updateEndpointSchema)) dto: UpdateEndpointDto,
  ) {
    return this.endpoints.update(tenant.id, id, dto);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@CurrentTenant() tenant: Tenant, @Param("id", uuidPipe) id: string) {
    return this.endpoints.remove(tenant.id, id);
  }

  @Get(":id/secret")
  reveal(@CurrentTenant() tenant: Tenant, @Param("id", uuidPipe) id: string) {
    return this.endpoints.revealSecret(tenant.id, id);
  }

  @Post(":id/rotate")
  rotate(@CurrentTenant() tenant: Tenant, @Param("id", uuidPipe) id: string) {
    return this.endpoints.rotateSecret(tenant.id, id);
  }
}
```

- [ ] **Step 6: Write `apps/api/src/endpoints/endpoints.module.ts`** and add to AppModule imports

```ts
import { Module } from "@nestjs/common";
import { EndpointsController } from "./endpoints.controller";
import { EndpointsService } from "./endpoints.service";

@Module({
  controllers: [EndpointsController],
  providers: [EndpointsService],
})
export class EndpointsModule {}
```

- [ ] **Step 7: Run tests** — `pnpm --filter @eventform/api test` → all green (28 api). Root `pnpm test` → 68 total (28 shared + 12 db + 28 api). Run api suite twice for cleanup idempotency.

- [ ] **Step 8: Commit**

```bash
git add apps/api
git commit -m "feat(api): add webhook endpoints crud with kms-encrypted secrets"
```

---

## Done criteria for Phase 2a

- `pnpm build && pnpm test` green from clean checkout (68 tests).
- `pnpm --filter @eventform/api start:dev` boots; `curl localhost:3001/health` → ok;
  a `dev_` token can create/publish a form and create an endpoint end-to-end.
- No plaintext secret column anywhere; secrets appear only in create/reveal/rotate responses.
- Phase 2b can add the public submission path + outbox writes on top without touching these modules.
