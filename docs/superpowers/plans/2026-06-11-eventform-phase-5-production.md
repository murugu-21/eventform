# Eventform Phase 5 — Production Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make eventform deployable to `eventform.murugappan.dev` / `eventform-api.murugappan.dev` on one cheap VPS (any provider): real Cognito Google OAuth (verifier + SPA PKCE flow, both testable locally without AWS), production Docker images behind Caddy TLS, a prod compose stack with hardened bootstrap, AWS CDK (AuthStack + KmsStack) with assertion tests, and CI/CD — ending with a DEPLOYMENT.md handoff checklist for the steps only the account owner can do (AWS account for Cognito only, Google OAuth client, VPS + DNS, GitHub secrets).

**Architecture:** The API's `TokenVerifier` seam gets a `CognitoTokenVerifier` (jose JWKS verify; unit-tested against a locally generated keypair — no AWS needed). The SPA's auth seam gets a Cognito provider (authorization-code + PKCE against the hosted UI) selected by `VITE_AUTH_MODE`. Prod runs 8 containers via `docker-compose.prod.yml`: caddy (TLS + web static + API proxy), api, worker, postgres, kafka, connect, connect-init (one-shot connector registration), localstack (KMS only, fixed-material boot). CDK defines the Cognito pool + Google IdP (AuthStack, deployed to real AWS — the only real-AWS resource, free tier) and the LocalStack KMS key/alias (KmsStack, deployed via cdklocal into the dev/prod LocalStack container); both covered by `Template.fromStack` assertion tests. Compute is deliberately NOT IaC: the prod compose runs on any Docker VPS (EC2→VPS pivot per user decision 2026-06-11 — cost + lock-in). Branch: `feat/phase-5-production`.

**Carried-forward hard requirements (from earlier phase reviews — ALL land here):**
1. `app.set("trust proxy", 1)` behind Caddy (else per-IP throttling collapses to the proxy IP).
2. Prod pins `AUTH_MODE=cognito` (dev tokens must be impossible in prod).
3. Prod bootstrap: `REVOKE CREATE ON SCHEMA public FROM PUBLIC`; rotate `app_api`/`app_worker` passwords; generate the KMS key-material file (mode 600).
4. Worker liveness: fatal consumer crash already exits (done in Phase 3); compose `restart: unless-stopped` completes the loop.
5. Dedicated Debezium replication role noted as acceptable-deviation (demo uses the admin user; documented).

**Spec:** `docs/superpowers/specs/2026-06-11-eventform-design.md` (§Auth, §Infra, §README)
**Prereqs:** Phase 4 complete (122 unit/integration tests + 1 Playwright smoke green).

## File structure

```
apps/api/src/auth/cognito-token-verifier.ts     jose JWKS verification
apps/api/test/cognito-token-verifier.test.ts    local-keypair tests
apps/web/src/lib/pkce.ts                        verifier/challenge/url helpers
apps/web/src/lib/pkce.test.ts
apps/web/src/lib/auth.tsx                       (modified: provider selection seam)
apps/web/src/pages/auth-callback.tsx            /auth/callback code exchange
apps/api/Dockerfile · apps/worker/Dockerfile
infra/caddy/Dockerfile · infra/caddy/Caddyfile
infra/compose/docker-compose.prod.yml
infra/prod/bootstrap.sh                          KMS material, role passwords, schema hardening
infra/cdk/  (package.json, cdk.json, tsconfig, bin/eventform.ts,
             lib/auth-stack.ts, lib/kms-stack.ts, test/*.test.ts)
.github/workflows/ci.yml · .github/workflows/deploy.yml
docs/DEPLOYMENT.md                               the human handoff checklist
README.md                                        final recruiter-facing rewrite
```

---

### Task 1: CognitoTokenVerifier (TDD, no AWS needed) + trust proxy

**Files:**
- Create: `apps/api/src/auth/cognito-token-verifier.ts`
- Modify: `apps/api/src/auth/auth.module.ts` (factory selects verifier by AUTH_MODE)
- Modify: `apps/api/src/config.ts` (+cognitoIssuer, +cognitoClientId, +trustProxy)
- Modify: `apps/api/src/main.ts` (trust proxy)
- Test: `apps/api/test/cognito-token-verifier.test.ts`
- Modify: `.env.example`

- [ ] **Step 1:** `pnpm --filter @eventform/api add jose`

- [ ] **Step 2: Failing test** — generate an RS256 keypair with jose in the test, build a `createLocalJWKSet`, inject it into the verifier (constructor accepts an optional JWKS for tests; prod path uses `createRemoteJWKSet(issuer + "/.well-known/jwks.json")`). Tests:

```ts
import { describe, expect, it, beforeAll } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { CognitoTokenVerifier } from "../src/auth/cognito-token-verifier";

const ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST";
const CLIENT_ID = "test-client-id";

describe("CognitoTokenVerifier", () => {
  let privateKey: CryptoKey;
  let verifier: CognitoTokenVerifier;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey as CryptoKey;
    const jwk = await exportJWK(pair.publicKey);
    jwk.kid = "test-kid";
    jwk.alg = "RS256";
    verifier = new CognitoTokenVerifier(
      { issuer: ISSUER, clientId: CLIENT_ID },
      createLocalJWKSet({ keys: [jwk] }),
    );
  });

  function token(claims: Record<string, unknown>, expiresIn = "1h") {
    return new SignJWT({ token_use: "access", client_id: CLIENT_ID, sub: "user-123", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
      .setIssuedAt()
      .setIssuer((claims.iss as string) ?? ISSUER)
      .setExpirationTime(expiresIn)
      .sign(privateKey);
  }

  it("returns the sub for a valid access token", async () => {
    await expect(verifier.verify(await token({}))).resolves.toBe("user-123");
  });

  it("rejects expired tokens", async () => {
    await expect(verifier.verify(await token({}, "-1h"))).rejects.toThrow(UnauthorizedException);
  });

  it("rejects a wrong issuer", async () => {
    await expect(verifier.verify(await token({ iss: "https://evil.example.com" })))
      .rejects.toThrow(UnauthorizedException);
  });

  it("rejects id tokens (token_use must be access)", async () => {
    await expect(verifier.verify(await token({ token_use: "id" })))
      .rejects.toThrow(UnauthorizedException);
  });

  it("rejects a wrong client_id", async () => {
    await expect(verifier.verify(await token({ client_id: "other" })))
      .rejects.toThrow(UnauthorizedException);
  });

  it("rejects garbage", async () => {
    await expect(verifier.verify("not.a.jwt")).rejects.toThrow(UnauthorizedException);
  });
});
```

- [ ] **Step 3: Implement**

```ts
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { TokenVerifier } from "./token-verifier";

export interface CognitoVerifierOptions {
  issuer: string;   // https://cognito-idp.<region>.amazonaws.com/<poolId>
  clientId: string; // app client id — Cognito access tokens carry it as client_id
}

type Jwks = Parameters<typeof jwtVerify>[1];

@Injectable()
export class CognitoTokenVerifier implements TokenVerifier {
  private readonly jwks: Jwks;

  constructor(
    private readonly opts: CognitoVerifierOptions,
    jwks?: Jwks, // test seam
  ) {
    this.jwks =
      jwks ?? (createRemoteJWKSet(new URL(`${opts.issuer}/.well-known/jwks.json`)) as Jwks);
  }

  async verify(token: string): Promise<string> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, { issuer: this.opts.issuer });
      if (payload.token_use !== "access") {
        throw new Error("token_use must be access");
      }
      if (payload.client_id !== this.opts.clientId) {
        throw new Error("client_id mismatch");
      }
      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new Error("missing sub");
      }
      return payload.sub;
    } catch {
      throw new UnauthorizedException("invalid token");
    }
  }
}
```

- [ ] **Step 4: Wiring.** config: `cognitoIssuer: env.COGNITO_ISSUER ?? ""`, `cognitoClientId: env.COGNITO_CLIENT_ID ?? ""`, `trustProxy: env.TRUST_PROXY === "1"`. auth.module factory: AUTH_MODE=cognito → both vars required (throw with a clear message if blank) → `new CognitoTokenVerifier({...})`; dev → DevTokenVerifier (unchanged). main.ts: `if (loadConfig().trustProxy) { app.getHttpAdapter().getInstance().set("trust proxy", 1); }`. `.env.example`: add `# production auth` block (AUTH_MODE already there; add COGNITO_ISSUER=, COGNITO_CLIENT_ID=, TRUST_PROXY=0).

- [ ] **Step 5:** api suite green (54 + 6 = 60), build clean. Commit: `feat(api): cognito jwt verifier behind the auth-mode seam`

---

### Task 2: SPA Cognito PKCE provider (TDD on helpers)

**Files:**
- Create: `apps/web/src/lib/pkce.ts`, `apps/web/src/lib/pkce.test.ts`
- Create: `apps/web/src/pages/auth-callback.tsx`
- Modify: `apps/web/src/lib/auth.tsx`, `src/lib/api.ts` (token header seam), `src/pages/login.tsx`, `src/App.tsx`
- Modify: `apps/web/.env.example` (create — VITE_ vars)

- [ ] **Step 1: `pkce.ts`** (IN FULL):

```ts
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function generateVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export interface CognitoConfig {
  domain: string;   // https://<prefix>.auth.<region>.amazoncognito.com
  clientId: string;
  redirectUri: string;
}

export function authorizeUrl(cfg: CognitoConfig, challenge: string, state: string): string {
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: "openid email profile",
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
    identity_provider: "Google",
  });
  return `${cfg.domain}/oauth2/authorize?${qs}`;
}

export interface TokenResponse {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  expires_in: number;
}

export async function exchangeCode(
  cfg: CognitoConfig,
  code: string,
  verifier: string,
): Promise<TokenResponse> {
  const res = await fetch(`${cfg.domain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      code,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status}`);
  }
  return res.json();
}

export async function refreshTokens(
  cfg: CognitoConfig,
  refreshToken: string,
): Promise<TokenResponse> {
  const res = await fetch(`${cfg.domain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: cfg.clientId,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`refresh failed: ${res.status}`);
  }
  return res.json();
}
```

- [ ] **Step 2: tests** (`pkce.test.ts`, vitest — node 22 has webcrypto/btoa): verifier is 43-char base64url + unique; challenge matches a known RFC 7636 vector (verifier `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` → challenge `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`); authorizeUrl contains all params incl. S256 + Google idp; exchangeCode posts the right form body (stub fetch) and throws on non-ok. ~5 tests, red → green.

- [ ] **Step 3: auth seam.** `auth.tsx`: `const AUTH_MODE = import.meta.env.VITE_AUTH_MODE ?? "dev"`. Dev path unchanged. Cognito path: `signIn()` generates verifier+state (sessionStorage), redirects to `authorizeUrl`; `auth-callback.tsx` (route `/auth/callback`) validates state, exchanges code, stores `eventform.accessToken` + `eventform.refreshToken` (localStorage — documented tradeoff), navigates `/app`; `signOut()` clears + redirects to `${domain}/logout?client_id=...&logout_uri=<origin>`. `api.ts`: replace the dev-only header logic with a mode-aware header: dev → `Bearer dev_<sub>`; cognito → `Bearer <accessToken>`, and on a 401 attempt one refresh-token rotation then retry once (helper `withAuthRetry`). Login page: cognito mode renders a single "Continue with Google" button (calls signIn); dev mode unchanged. `apps/web/.env.example`: VITE_API_URL, VITE_AUTH_MODE=dev, VITE_COGNITO_DOMAIN=, VITE_COGNITO_CLIENT_ID=, VITE_REDIRECT_URI=.

- [ ] **Step 4:** web tests green (6 + ~5 = 11), build clean, dev-mode behavior unchanged (Playwright smoke still passes if run — optional here, required in Task 6). Commit: `feat(web): cognito pkce auth behind the auth-mode seam`

---

### Task 3: Production images, Caddy, prod compose, bootstrap

**Files:**
- Create: `apps/api/Dockerfile`, `apps/worker/Dockerfile`, `infra/caddy/Dockerfile`, `infra/caddy/Caddyfile`
- Create: `infra/compose/docker-compose.prod.yml`, `infra/prod/bootstrap.sh`
- Create: `.dockerignore`

- [ ] **Step 1: API/worker Dockerfiles** — multi-stage with pnpm workspace pruning. Pattern (api shown; worker identical with names swapped):

```dockerfile
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @eventform/api...
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm --filter @eventform/api... build \
 && pnpm --filter @eventform/api deploy --prod --legacy /out

FROM node:22-alpine
WORKDIR /app
COPY --from=build /out .
EXPOSE 3001
USER node
CMD ["node", "dist/main.js"]
```

(If `pnpm deploy` fights the workspace layout, fall back to copying the full built workspace + `pnpm prune --prod` and report; image size is secondary to correctness.) Worker has no exposed port requirement beyond 3002 health. `.dockerignore`: node_modules, dist, .git, docs, test-results.

- [ ] **Step 2: Caddy.** `infra/caddy/Dockerfile`: stage 1 builds the web app (`pnpm --filter @eventform/web build` with `VITE_API_URL=https://eventform-api.murugappan.dev`, `VITE_AUTH_MODE=cognito`, VITE_COGNITO_* as build ARGs); stage 2 `FROM caddy:2-alpine`, copy dist → `/srv/web`, copy Caddyfile. `Caddyfile`:

```
{
  email {$ACME_EMAIL}
}

{$WEB_HOST:eventform.murugappan.dev} {
  root * /srv/web
  encode gzip
  try_files {path} /index.html
  file_server
}

{$API_HOST:eventform-api.murugappan.dev} {
  reverse_proxy api:3001
}
```

- [ ] **Step 3: `docker-compose.prod.yml`** — standalone file: postgres (same tuning + healthcheck, NO published port), localstack (kms, material from `${KMS_KEY_MATERIAL_FILE}`, no published port), kafka + connect (as dev minus published ports), `connect-init` (curlimages/curl one-shot: retry-PUT the connector config mounted from `infra/compose/connect/`, `restart: "no"`, depends_on connect healthy), api (build apps/api Dockerfile; env: DATABASE_URL_API w/ `${APP_API_PASSWORD}`, AUTH_MODE=cognito, COGNITO_ISSUER/CLIENT_ID, CORS_ORIGINS=https://eventform.murugappan.dev, TRUST_PROXY=1, AWS_ENDPOINT_URL=http://localstack:4566, healthcheck wget /health), worker (env analog incl. KAFKA_BROKERS=kafka:9092 — NOTE: in-network listener, not 29092), caddy (build infra/caddy, ports 80/443, volumes caddy_data+caddy_config, depends_on api). ALL services `restart: unless-stopped`. An `x-required-env` comment block documents every `${VAR}`.

- [ ] **Step 4: `infra/prod/bootstrap.sh`** — idempotent, run once on the EC2 after first `up`: (a) generate `${KMS_KEY_MATERIAL_FILE}` (openssl rand -base64 32, chmod 600) if missing — must exist BEFORE first compose up; (b) `ALTER ROLE app_api/app_worker PASSWORD` from env (psql via the postgres container); (c) `REVOKE CREATE ON SCHEMA public FROM PUBLIC;`; (d) run migrations (`docker compose run --rm api node node_modules/.bin/...`? — simpler: document `pnpm db:migrate` from a checkout, or add a tiny migrate stage; choose ONE working mechanism, implement, and document it in DEPLOYMENT.md).

- [ ] **Step 5: Local prod-mode verification (required).** `docker compose -f infra/compose/docker-compose.prod.yml build` succeeds for all three images. Then boot the prod stack LOCALLY with a `docker-compose.prod-local.override.yml` (auto_https off / :8080 for caddy, AUTH_MODE=dev, CORS http://localhost:8080, dev role passwords, dev key material): the full loop must work — login (dev), create+publish form via the SPA served by caddy at :8080, anonymous submit, delivery delivered (worker→kafka in-network). This proves images + Caddyfile + in-network wiring without AWS. Tear down after (it shares no state with the dev compose — separate project name `eventform-prod`).

- [ ] **Step 6: Commit** — `feat(infra): production images, caddy, prod compose, and bootstrap`

---

### Task 4: AWS CDK (AuthStack + ComputeStack) with assertion tests

**Files:**
- Create: `infra/cdk/package.json`, `cdk.json`, `tsconfig.json`, `bin/eventform.ts`, `lib/auth-stack.ts`, `lib/compute-stack.ts`, `test/auth-stack.test.ts`, `test/compute-stack.test.ts`

- [ ] **Step 1: Scaffold** — aws-cdk-lib ^2, constructs, vitest (consistent runner). cdk.json context defaults: `webHost: eventform.murugappan.dev`, `apiHost: eventform-api.murugappan.dev`.

- [ ] **Step 2: AuthStack** — UserPool (no self-signup, email auto-verified via Google), `UserPoolIdentityProviderGoogle` (clientId/secret from context `-c googleClientId=… -c googleClientSecret=…`; secret via `SecretValue.unsafePlainText` with a comment that Secrets Manager is the non-demo path), hosted domain (`cognitoDomain` prefix from context, default `eventform-auth`), app client: authorization-code grant + PKCE (no client secret), scopes openid/email/profile, callbacks `https://<webHost>/auth/callback` + `http://localhost:5173/auth/callback`, logout urls analog, supported idps [Google]. Outputs: Issuer (`https://cognito-idp.${region}.amazonaws.com/${poolId}`), ClientId, HostedDomain.

- [ ] **Step 3: KmsStack** — the endpoint-secret key as IaC, deployable via `cdklocal` into LocalStack: `kms.CfnKey` with `Origin: EXTERNAL`, `Description`, and Tags including `{ Key: "_custom_id_", Value: "11111111-2222-4333-8444-555555555555" }` (the LocalStack extension pinning the key id so existing ciphertexts stay valid), plus `kms.CfnAlias` `alias/eventform-endpoint-secrets`. IMPORTANT interplay: the compose boot hook stays as the idempotent creation+material-import fallback (it skips when the key is already Enabled); KmsStack is the IaC source of truth — `cdklocal deploy KmsStack` then the boot hook only imports material. Verify against the running dev LocalStack: `pnpm --filter eventform-cdk exec cdklocal deploy KmsStack --require-approval never` succeeds AND a pre-existing ciphertext still decrypts after a `docker compose restart localstack` (boot-hook import still healing).

- [ ] **Step 4: Assertion tests** (no AWS needed): AuthStack template has `AWS::Cognito::UserPool` with self-signup disabled, IdP Google with correct scopes, client with `AllowedOAuthFlows: [code]` + correct callbacks + no secret; KmsStack has the EXTERNAL-origin key with the `_custom_id_` tag and the alias. ~7 tests.

- [ ] **Step 5:** `pnpm --filter eventform-cdk test` green; `cdk synth --all` (with dummy google context) produces both templates; the cdklocal KmsStack deploy from Step 3 verified live. (Cognito can't be exercised locally — Community LocalStack doesn't emulate it; assertions + synth are its local verification.)

- [ ] **Step 6: Commit** — `feat(infra): cdk stacks for cognito auth and localstack kms`

---

### Task 5: CI/CD workflows

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`

- [ ] **Step 1: ci.yml** — on push/PR to main + phase branches: checkout, pnpm/node setup (cache), install frozen, `pnpm build`, boot the dev compose services (postgres localstack kafka connect — `docker compose -f infra/compose/docker-compose.yml up -d --wait`), `pnpm connect:register`, `pnpm test` (the full 133-test integration suite is the point of having it), upload junit/log artifacts on failure. Playwright smoke: separate job, `continue-on-error: true` initially (needs api+worker+web orchestration: build, start both from dist in background, `playwright install chromium`, run) — promote to required later.

- [ ] **Step 2: deploy.yml** — `workflow_dispatch` + push tags `v*`: build & push 3 images to GHCR (`docker/build-push-action`, tags latest+sha; caddy image needs VITE_* build args from repo variables), then ssh (appleboy/ssh-action with `secrets.VPS_HOST/VPS_SSH_KEY`) → `cd /opt/eventform && docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d`. NOTE: prod compose must reference `image:` (ghcr.io/...) with `build:` as dev-only fallback — adjust compose accordingly (`image: ghcr.io/${GITHUB_REPOSITORY:-murugu21/eventform}-api:latest` pattern + build key kept for local). Gate the job on secrets being configured (`if: ${{ secrets.VPS_HOST != '' }}` via env indirection — document the GitHub limitation honestly if a workaround is needed).

- [ ] **Step 3:** Validate YAML (`actionlint` via pnpm dlx if available, else careful review). CI can't be fully proven without pushing — note it.

- [ ] **Step 4: Commit** — `ci: add integration test and deploy workflows`

---

### Task 6: README finale + DEPLOYMENT.md + verification

- [ ] **Step 1: README rewrite** (the recruiter artifact): hero paragraph; mermaid architecture diagram (browser → caddy → api → postgres outbox → debezium → kafka → worker → webhook, with KMS + Cognito annotations); "Patterns on display" table — each row: pattern → why it matters → implementing file links (transactional outbox `apps/api/src/public/public.service.ts`, CDC `infra/compose/connect/eventform-outbox.json`, idempotent consumer `apps/worker/src/processor/delivery-processor.service.ts`, RLS `packages/db/migrations/0001_rls.sql`, row locks scheduler/retry, HMAC `packages/shared/src/hmac.ts`, KMS secrets `packages/shared/src/kms.ts`, PKCE `apps/web/src/lib/pkce.ts`); honest "at-least-once, not exactly-once" note; local quickstart (kept); full-demo walkthrough (kept); test inventory (counts by suite); deployment pointer to DEPLOYMENT.md; cost notes (t3.small via credits, Cognito free tier, KMS $0 via LocalStack).

- [ ] **Step 2: docs/DEPLOYMENT.md** — the handoff checklist, numbered, copy-pasteable: (1) AWS account + `cdk bootstrap` (Cognito only — free tier); (2) Google Cloud Console OAuth client (exact console path, authorized redirect URI `https://<cognito-domain>.auth.<region>.amazoncognito.com/oauth2/idpresponse`); (3) `cdk deploy AuthStack -c googleClientId=… -c googleClientSecret=…` → note outputs; (4) VPS: pick any ≥2 GB Docker-capable box (Hetzner CX22 / DO / Vultr — price-compare table), point both subdomains' A records at it, optional cloud-init snippet (docker install + /opt/eventform) provided inline; (5) VPS first-time setup: clone repo to /opt/eventform, write `.env` (every `${VAR}` from the prod compose with explanations), run `infra/prod/bootstrap.sh`, `docker compose -f docker-compose.prod.yml up -d` (connect-init registers the connector), run migrations, `cdklocal deploy KmsStack` against the VPS LocalStack (or rely on the boot hook — both documented); (6) GitHub repo secrets/variables for deploy.yml (VPS_HOST/VPS_SSH_KEY); (7) smoke checklist (https loads, Google login works, full loop, failed-delivery demo script for recruiters); (8) teardown/cost table (VPS ~€4-6/mo, Cognito $0, domain you already own).

- [ ] **Step 3: Final verification** — root `pnpm build && pnpm test` (expect ~133 unit/integration: 122 + 6 cognito + 5 pkce); Playwright smoke against the dev stack still green; `cdk synth` green; prod images build.

- [ ] **Step 4:** Append implementation notes to this plan. Commits: `docs: recruiter-facing readme and deployment guide`.

## Done criteria for Phase 5

- All local suites green (~133 + smoke); cdk assertion tests + synth pass; all three prod images build; the LOCAL prod-mode compose boot serves the full loop through Caddy.
- AUTH_MODE seams proven on both sides (cognito verifier unit-tested via local JWKS; PKCE helpers vector-tested) — flipping env vars is the only deploy-time change.
- DEPLOYMENT.md gets a human from zero to deployed with no undocumented step; every carried-forward hard requirement (trust proxy, cognito pinned, schema hardening, password rotation, KMS material) is implemented, not just documented.

---

## Implementation notes (deviations)

**EC2 → VPS pivot (mid-phase, 2026-06-11):** The original plan called for an EC2 ComputeStack.
The user pivoted to a generic VPS (Hetzner / DO / Vultr) to avoid AWS lock-in and reduce cost.
CDK scope shrank to AuthStack (Cognito, real AWS) + KmsStack (LocalStack via cdklocal). No
ComputeStack was ever written. DEPLOYMENT.md reflects the VPS path.

**Migrate-image mechanism:** Migrations are packaged as a dedicated `migrate` service in the
prod compose (`packages/db/Dockerfile.migrate`), referencing
`ghcr.io/murugu21/eventform-migrate:latest`. They run via
`docker compose run --rm migrate` (profile `setup`). This was simpler and more reliable than
running migrations inside the API container on startup.

**`pnpm deploy --legacy`:** The API and worker Dockerfiles use
`pnpm --filter <pkg> deploy --prod --legacy /out` to produce a standalone deployment directory.
The `--legacy` flag was required to work around pnpm workspace hoisting behaviour in the
multi-stage build context. Image size is larger than optimal but correctness takes priority.

**KMS_KEY_MATERIAL_FILE default:** The prod compose uses
`${KMS_KEY_MATERIAL_FILE:-./localstack/dev-key-material.b64}` as a fallback default so the
compose file is usable in dev overrides without explicitly setting the variable.

**Connect-init password substitution:** The prod connector template
(`infra/compose/connect/eventform-outbox-prod.json`) contains `${DB_ADMIN_PASSWORD}` as a
literal string. The `connect-init` one-shot container performs shell substitution via
`envsubst` before POSTing the config to the Connect REST API.

**aws-cdk-local 3.x:** The CDK package uses `aws-cdk-local` 3.x (matching CDK v2). The
`cdklocal` CLI wraps `cdk` and redirects all AWS SDK calls to `AWS_ENDPOINT_URL=http://localhost:4566`.
The KmsStack deploys cleanly to LocalStack Community with this version.

**LocalStack Community Origin=AWS_KMS note:** LocalStack Community reports the KMS key
`Origin` as `AWS_KMS` rather than `EXTERNAL` even when created with `Origin: EXTERNAL` in
the CDK template. This is a LocalStack Community limitation — the CDK declaration is honoured
at the CloudFormation template level (covered by assertion tests), and key material import
works correctly regardless.

**Final test counts (verified 2026-06-11):**
- `packages/shared`: 28 tests
- `packages/db`: 12 tests
- `apps/api`: 60 tests
- `apps/worker`: 22 tests
- `apps/web`: 17 tests
- `infra/cdk`: 14 tests
- **Total: 153 unit/integration tests + 1 Playwright smoke (all green)**
