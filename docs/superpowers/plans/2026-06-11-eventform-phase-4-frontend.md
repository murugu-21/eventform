# Eventform Phase 4 — Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The recruiter-facing product: a React + shadcn/ui SPA covering the full loop — sign in (dev mode), build & publish a form, share the public link, watch submissions arrive, manage webhook endpoints with reveal/rotate, and operate the failed-deliveries UI with manual retry — verified by a Playwright smoke test across the whole stack.

**Architecture:** `apps/web` — Vite + React 18 + TypeScript + Tailwind v4 + shadcn/ui components (generated via the shadcn CLI; treated like other codegen). react-router v7 (library mode), @tanstack/react-query v5 for data + polling. A tiny typed fetch client targets `VITE_API_URL` (default `http://localhost:3001`); auth is a swappable seam — dev mode stores a sub in localStorage and sends `Bearer dev_<sub>` (Phase 5 replaces this provider with Cognito hosted-UI tokens, nothing else changes). The API gains CORS config (env-driven origins). Branch: `feat/phase-4-frontend`.

**Plan style note (deviation from full-code convention):** shared infrastructure (API client, auth, router, query setup, Playwright spec) is given IN FULL; page components are specified by exact routes, API calls, behavior, and acceptance checklists rather than full JSX — shadcn/React composition is well-trodden ground for the implementer, and the binding contracts (API shapes) are pinned by the typed client. The Playwright smoke + per-task acceptance checks are the verification.

**Spec:** `docs/superpowers/specs/2026-06-11-eventform-design.md` (§Frontend pages)
**Prereqs:** Phase 3 complete (116 tests green); full compose stack + connector for the smoke test.

## Shared API types (pin these in `src/lib/types.ts`, used by every page)

```ts
export type FormStatus = "draft" | "published";
export type FieldType = "text" | "multiple_choice";
export type DeliveryStatus = "pending" | "delivered" | "retrying" | "failed";

export interface Form {
  id: string;
  title: string;
  status: FormStatus;
  publicSlug: string;
  createdAt: string;
}

export interface FormField {
  id: string;
  type: FieldType;
  label: string;
  options: string[] | null;
  required: boolean;
  position: number;
}

export interface FormWithFields extends Form {
  fields: FormField[];
}

export interface PublicForm {
  id: string;
  title: string;
  slug: string;
  fields: FormField[];
}

export interface Endpoint {
  id: string;
  name: string;
  url: string;
  active: boolean;
  createdAt: string;
}

export interface EndpointWithSecret extends Endpoint {
  secret: string; // present ONLY on create/rotate responses
}

export interface Submission {
  id: string;
  formId: string;
  answers: Record<string, string>;
  submittedAt: string;
  sourceIp: string | null;
}

export interface Delivery {
  id: string;
  endpointId: string;
  endpointName: string;
  submissionId: string;
  status: DeliveryStatus;
  attemptCount: number;
  nextRetryAt: string | null;
  lastError: string | null;
  responseCode: number | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface DeliveryAttempt {
  id: string;
  attemptNo: number;
  requestedAt: string;
  responseCode: number | null;
  error: string | null;
  durationMs: number | null;
}

export interface DeliveryDetail extends Delivery {
  attempts: DeliveryAttempt[];
}
```

## Route map

| Route | Auth | Page |
|---|---|---|
| `/` | public | Landing: pitch, architecture blurb, "Sign in" |
| `/login` | public | Dev sign-in (enter a handle → stored as dev sub) |
| `/f/:slug` | public | Public form render + submit + thank-you |
| `/app` | gate | Dashboard: forms list + create + delete |
| `/app/forms/:id` | gate | Form builder: fields editor + publish + share link |
| `/app/forms/:id/submissions` | gate | Submissions table |
| `/app/endpoints` | gate | Endpoints CRUD + secret reveal/rotate + verify snippet |
| `/app/deliveries` | gate | Deliveries table + filters + attempts + retry (5s poll) |

Auth gate: no dev sub in localStorage → redirect `/login`.

---

### Task 1: API CORS + web scaffold + auth + API client

**Files:**
- Modify: `apps/api/src/main.ts` (+ `apps/api/src/config.ts` for `corsOrigins`)
- Create: `apps/web/*` scaffold (vite, tailwind v4, shadcn init)
- Create: `apps/web/src/lib/types.ts` (block above), `src/lib/api.ts`, `src/lib/auth.tsx`
- Create: `src/main.tsx`, `src/App.tsx` (router), `src/pages/login.tsx`, `src/components/layout.tsx`
- Test: `apps/web/src/lib/api.test.ts`

- [ ] **Step 1: API CORS.** `config.ts`: add `corsOrigins: (env.CORS_ORIGINS ?? "http://localhost:5173").split(",")` (+ interface field). `main.ts`: `app.enableCors({ origin: loadConfig().corsOrigins });` before listen. Add `CORS_ORIGINS=http://localhost:5173` to `.env.example`. Run the api e2e suite (54 green, unaffected). Commit: `feat(api): enable env-driven cors`.

- [ ] **Step 2: Scaffold.** From `apps/`: `pnpm create vite@latest web --template react-ts`; set package name `@eventform/web`, add to workspace (already matched by `apps/*`). Install; add Tailwind v4 (`tailwindcss @tailwindcss/vite`) per current Tailwind+Vite docs; add `react-router` v7, `@tanstack/react-query` v5. shadcn: `pnpm dlx shadcn@latest init -d` then `pnpm dlx shadcn@latest add button card input label table badge dialog select switch separator sonner` (treat generated `src/components/ui/*` as codegen — commit but don't review line-by-line; if the CLI requires interaction that can't be satisfied, vendor the components manually from the shadcn registry and report the deviation). vitest for unit tests (jsdom not required for api client tests — plain node env with fetch mocked).

- [ ] **Step 3: `src/lib/api.ts`** (IN FULL — this is the contract):

```ts
import type {
  Delivery, DeliveryDetail, Endpoint, EndpointWithSecret,
  Form, FormWithFields, PublicForm, Submission,
} from "./types";

const API_URL: string = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const DEV_SUB_KEY = "eventform.devSub";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly errors?: { path?: string; message: string }[] | string[],
  ) {
    super(message);
  }
}

export function getDevSub(): string | null {
  return localStorage.getItem(DEV_SUB_KEY);
}

export function setDevSub(sub: string | null): void {
  if (sub) {
    localStorage.setItem(DEV_SUB_KEY, sub);
  } else {
    localStorage.removeItem(DEV_SUB_KEY);
  }
}

async function request<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body) {
    headers["content-type"] = "application/json";
  }
  if (auth) {
    const sub = getDevSub();
    if (!sub) {
      throw new ApiError(401, "not signed in");
    }
    headers.authorization = `Bearer dev_${sub}`;
  }
  const res = await fetch(`${API_URL}${path}`, { ...init, headers: { ...headers, ...init.headers } });
  if (res.status === 204) {
    return undefined as T;
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.message ?? res.statusText, body?.errors);
  }
  return body as T;
}

export const api = {
  me: () => request<{ tenantId: string; name: string }>("/me"),

  listForms: () => request<Form[]>("/forms"),
  createForm: (title: string) =>
    request<Form>("/forms", { method: "POST", body: JSON.stringify({ title }) }),
  getForm: (id: string) => request<FormWithFields>(`/forms/${id}`),
  updateForm: (id: string, title: string) =>
    request<Form>(`/forms/${id}`, { method: "PUT", body: JSON.stringify({ title }) }),
  deleteForm: (id: string) => request<void>(`/forms/${id}`, { method: "DELETE" }),
  replaceFields: (id: string, fields: Omit<import("./types").FormField, "id" | "position">[]) =>
    request<import("./types").FormField[]>(`/forms/${id}/fields`, {
      method: "PUT",
      body: JSON.stringify({
        fields: fields.map(({ type, label, options, required }) => ({
          type, label, required, ...(options ? { options } : {}),
        })),
      }),
    }),
  publishForm: (id: string) => request<Form>(`/forms/${id}/publish`, { method: "POST" }),
  listSubmissions: (formId: string) => request<Submission[]>(`/forms/${formId}/submissions`),

  listEndpoints: () => request<Endpoint[]>("/endpoints"),
  createEndpoint: (name: string, url: string) =>
    request<EndpointWithSecret>("/endpoints", { method: "POST", body: JSON.stringify({ name, url }) }),
  updateEndpoint: (id: string, patch: Partial<Pick<Endpoint, "name" | "url" | "active">>) =>
    request<Endpoint>(`/endpoints/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  deleteEndpoint: (id: string) => request<void>(`/endpoints/${id}`, { method: "DELETE" }),
  revealSecret: (id: string) => request<{ secret: string }>(`/endpoints/${id}/secret`),
  rotateSecret: (id: string) =>
    request<EndpointWithSecret>(`/endpoints/${id}/rotate`, { method: "POST" }),

  listDeliveries: (filter: { status?: string; endpointId?: string } = {}) => {
    const qs = new URLSearchParams(
      Object.entries(filter).filter(([, v]) => v != null) as [string, string][],
    ).toString();
    return request<Delivery[]>(`/deliveries${qs ? `?${qs}` : ""}`);
  },
  getDelivery: (id: string) => request<DeliveryDetail>(`/deliveries/${id}`),
  retryDelivery: (id: string) =>
    request<Delivery>(`/deliveries/${id}/retry`, { method: "POST" }),

  publicGetForm: (slug: string) => request<PublicForm>(`/f/${slug}`, {}, false),
  publicSubmit: (slug: string, answers: Record<string, string>) =>
    request<{ submissionId: string }>(
      `/f/${slug}`,
      { method: "POST", body: JSON.stringify({ answers }) },
      false,
    ),
};
```

- [ ] **Step 4: `src/lib/api.test.ts`** — vitest with stubbed `global.fetch` + localStorage shim: (1) authed call sends `Bearer dev_<sub>`; (2) unauthed throws ApiError 401 without fetching; (3) public call sends no auth header; (4) non-ok response throws ApiError with server message; (5) 204 → undefined. ~5 tests, write first (red), implement client, green.

- [ ] **Step 5: `src/lib/auth.tsx`** — `AuthProvider` context exposing `{ sub, signIn(sub), signOut() }` over localStorage (the Phase 5 seam); `RequireAuth` wrapper component redirecting to `/login`.

- [ ] **Step 6: Router + shell.** `App.tsx`: routes per the route map (lazy pages fine); `components/layout.tsx`: sidebar/topbar nav (Dashboard, Endpoints, Deliveries), current tenant name (from `/me` via react-query), sign-out. `pages/login.tsx`: input for handle (validate `[A-Za-z0-9_-]{1,64}`), explanatory copy ("dev sign-in — Google via Cognito arrives with the production deploy"), on submit `signIn(sub)` → navigate `/app`. QueryClientProvider + Toaster (sonner) in `main.tsx`.

- [ ] **Step 7: Acceptance** — `pnpm --filter @eventform/web test` green (api client tests); `pnpm --filter @eventform/web build` clean; `pnpm --filter @eventform/web dev` + API running: `/login` accepts a handle, `/app` renders the (empty) shell with tenant name. Root `pnpm test` all green.

- [ ] **Step 8: Commit** — `feat(web): scaffold spa with dev auth and typed api client`

---

### Task 2: Dashboard (forms list + create + delete)

**Files:** `src/pages/dashboard.tsx` (+ wire route)

Behavior: react-query `listForms`; card/table of forms (title, status badge, created date, public link when published, submissions/builder links); "New form" dialog (title input → `createForm` → navigate to builder); delete (drafts only — confirm dialog; published delete shows the API's 409 message via toast). Loading + empty states.

Acceptance: with the API running — create a draft from the UI, see it listed, delete it; published forms (seed one via curl) show a copyable `/f/<slug>` link and no delete. Build + unit tests stay green.

Commit: `feat(web): dashboard with form management`

---

### Task 3: Form builder

**Files:** `src/pages/form-builder.tsx` (+ small components as needed, e.g. `field-editor.tsx`)

Behavior: load `getForm(id)`. Title inline-edit (`updateForm`). Fields editor mirroring API rules: add field (type select: text | multiple choice), label input, required switch, options editor for multiple_choice (2–20 non-empty options, add/remove), remove field, reorder (up/down buttons fine — no dnd dependency), labels must be unique (client-side check mirrors the API 400). "Save fields" → `replaceFields` (only enabled when dirty & valid; max 50 fields). Publish button (enabled when ≥1 saved field, draft): confirm dialog explaining one-way; on success show the public URL prominently (copy button). Published forms: editor read-only with a notice. Validation errors from the API surface as toasts.

Acceptance (manual with stack up): build a 2-field form (text + multiple choice), save, publish, copy link, open `/f/<slug>` in the browser and see it render. Cross-check: a second dev user cannot load the form (404 page state).

Commit: `feat(web): form builder with field editor and publish flow`

---

### Task 4: Public form page

**Files:** `src/pages/public-form.tsx`, `src/pages/not-found.tsx`

Behavior: `publicGetForm(slug)` — 404 → friendly "form not found" page. Render title + fields in position order: text → Input, multiple_choice → radio group (shadcn RadioGroup — add via CLI if not present), required markers. Client-side validation mirroring the API (required non-empty, option membership). Submit → `publicSubmit`; on success swap to a thank-you state ("Response recorded — powered by eventform" + link to `/`). API 400s map field errors to inline messages where possible, else toast. 429 → "too many submissions, try again in a minute". No auth UI anywhere on this page.

Acceptance: submit the Task 3 form anonymously from a private/incognito window; thank-you state; the submission appears in the DB (verified in Task 5's UI). Required-field error renders inline.

Commit: `feat(web): public form rendering and submission`

---

### Task 5: Submissions page

**Files:** `src/pages/submissions.tsx`

Behavior: route `/app/forms/:id/submissions`; header with form title + back link; `listSubmissions` table — submitted time (relative + absolute title), one column per field label (derive the union of keys from the form's fields via `getForm`, falling back to answer keys), source IP. Empty state pointing at the public link. No pagination (mirror API).

Acceptance: the Task 4 submission shows with its answers.

Commit: `feat(web): submissions table`

---

### Task 6: Endpoints page

**Files:** `src/pages/endpoints.tsx` (+ `components/secret-dialog.tsx`)

Behavior: table (name, url, active switch → `updateEndpoint`, created). Create dialog (name, url — client-validate http(s)) → on success a SECRET dialog: shows the `whsec_` secret with copy button and "shown once — store it now" warning (closing requires a confirm checkbox or explicit button). Per row: Reveal (calls `revealSecret`, shows same dialog), Rotate (confirm dialog warning old secret stops working → `rotateSecret` → secret dialog), Delete (confirm; API 409 (has deliveries) → toast explaining why). A collapsible "Verify signatures" card with a code snippet showing receiver-side verification (timestamp + '.' + body HMAC-SHA256, compare to `X-Eventform-Signature`, reject stale `X-Eventform-Timestamp`) — mirrors `packages/shared` semantics.

Acceptance: create endpoint → secret shown once; reveal returns the same; rotate changes it; toggle active; delete a fresh endpoint works, delete one with deliveries shows the 409 toast (seed a delivery by submitting).

Commit: `feat(web): endpoints management with secret lifecycle`

---

### Task 7: Deliveries page

**Files:** `src/pages/deliveries.tsx` (+ `components/delivery-row.tsx`)

Behavior: filters — status select (all | pending | delivered | retrying | failed) + endpoint select (from `listEndpoints`); react-query `listDeliveries(filter)` with `refetchInterval: 5000`. Table: status badge (color-coded: pending=secondary, delivered=green, retrying=amber, failed=destructive), endpoint name, submission id (short), attempts, last response code/error (truncated, title=full), next retry countdown when retrying, created. Row expands (fetch `getDelivery`) → attempts timeline: attempt #, time, code, error, duration. Failed rows get a Retry button → `retryDelivery` → optimistic refetch + toast. Header shows per-status counts from the current result set. Note in UI footer: "showing latest 200".

Acceptance (the demo path): point an endpoint at an unreachable URL, submit → watch the row go pending → retrying (attempts ticking) → failed within ~60s WITHOUT manual refresh (polling); fix the endpoint URL, click Retry → delivered. This is the recruiter money-shot — make the state transitions legible.

Commit: `feat(web): deliveries dashboard with live status and manual retry`

---

### Task 8: Landing page + Playwright smoke + docs

**Files:** `src/pages/landing.tsx`, `apps/web/e2e/smoke.spec.ts`, `apps/web/playwright.config.ts`, `README.md`, this plan (notes)

- [ ] **Step 1: Landing** — hero ("Forms in. Webhooks out. Exactly once*… at least once."), 3-step "how it works", a compact architecture diagram (static SVG or styled boxes: Form → Postgres outbox → Debezium → Kafka → Worker → Webhook), tech badge row, GitHub link placeholder, Sign in CTA. Tasteful shadcn defaults — this is the recruiter's first impression.

- [ ] **Step 2: Playwright smoke `apps/web/e2e/smoke.spec.ts`** (IN FULL):

```ts
import { expect, test } from "@playwright/test";

const sub = `smoke-${Date.now()}`;

test("full loop: sign in → build → publish → submit → delivery delivered", async ({ page, request }) => {
  // receiver: use the worker-reachable echo at localhost:9099 if running; otherwise
  // accept 'pending/retrying' as proof the pipeline engaged. Prefer webhook.site-free local:
  // simplest deterministic target is the API health endpoint (always 200, wrong semantics
  // but a valid 2xx sink for the demo loop).
  const sinkUrl = "http://localhost:3001/health";

  await page.goto("/login");
  await page.getByLabel(/handle/i).fill(sub);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.getByRole("button", { name: /new form/i }).click();
  await page.getByLabel(/title/i).fill("Smoke Form");
  await page.getByRole("button", { name: /create/i }).click();
  await expect(page).toHaveURL(/\/app\/forms\//);

  await page.getByRole("button", { name: /add field/i }).click();
  await page.getByLabel(/label/i).last().fill("Name");
  await page.getByRole("button", { name: /save fields/i }).click();

  await page.getByRole("button", { name: /^publish/i }).click();
  await page.getByRole("button", { name: /confirm|publish/i }).last().click();
  const publicLink = await page.getByTestId("public-link").textContent();
  expect(publicLink).toBeTruthy();

  // endpoint pointing at the sink
  await page.goto("/app/endpoints");
  await page.getByRole("button", { name: /new endpoint/i }).click();
  await page.getByLabel(/name/i).fill("smoke sink");
  await page.getByLabel(/url/i).fill(sinkUrl);
  await page.getByRole("button", { name: /create/i }).click();
  await expect(page.getByText(/whsec_/)).toBeVisible();
  await page.getByRole("button", { name: /i.?ve stored it|close/i }).click();

  // anonymous submit
  const slug = publicLink!.trim().split("/f/")[1];
  await page.goto(`/f/${slug}`);
  await page.getByLabel("Name").fill("Playwright");
  await page.getByRole("button", { name: /submit/i }).click();
  await expect(page.getByText(/response recorded/i)).toBeVisible();

  // delivery reaches a terminal/active state via polling UI
  await page.goto("/app/deliveries");
  await expect(page.getByText(/delivered/i).first()).toBeVisible({ timeout: 30_000 });
});
```

  `playwright.config.ts`: baseURL `http://localhost:5173`, `webServer: { command: "pnpm dev", port: 5173, reuseExistingServer: true }`, chromium only, testDir `e2e`. Add `"e2e": "playwright test"` script + `@playwright/test` devDep + `pnpm exec playwright install chromium`. Prereqs documented in the spec file header: compose stack healthy, connector registered, api + worker running. ADAPT selectors to the actual markup built in Tasks 1–7 (getByTestId/data-testid additions to pages are encouraged — add `data-testid="public-link"` etc. where the spec references them).

- [ ] **Step 3: Run the smoke** with the full stack + api + worker up. It must pass; debug selectors/timing honestly (the deliveries assertion has 30s for CDC + delivery).

- [ ] **Step 4: README** — repo layout `apps/web` line → real description; "Run the full demo locally" section (stack, connector, api, worker, web dev server, login with any handle); Phase 4 plan link.

- [ ] **Step 5:** Append "## Implementation notes (deviations)" to this plan (actual component layout, shadcn CLI vs vendored, final test counts incl. Playwright).

- [ ] **Step 6: Commit** — `feat(web): landing page and full-stack smoke test` then `docs: document frontend phase`.

## Done criteria for Phase 4

- `pnpm build` + root `pnpm test` green; web unit tests green.
- Playwright smoke passes against the live stack (sign-in → build → publish → anonymous submit → delivered visible in the polling deliveries UI).
- Every spec §Frontend page exists and is wired to the real API; failed-delivery retry works from the UI.
- The dev-auth seam is isolated in `src/lib/auth.tsx` + `api.ts` (Phase 5 swaps providers without touching pages).
