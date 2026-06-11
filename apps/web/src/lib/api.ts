import type {
  Delivery, DeliveryDetail, Endpoint, EndpointWithSecret,
  Form, FormWithFields, PublicForm, Submission,
} from "./types";
import { refreshTokens } from "./pkce";
import { getAccessToken, getRefreshToken, storeTokens } from "@/pages/auth-callback";

const API_URL: string = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const AUTH_MODE: string = import.meta.env.VITE_AUTH_MODE ?? "dev";
const DEV_SUB_KEY = "eventform.devSub";

const COGNITO_CFG = {
  domain: import.meta.env.VITE_COGNITO_DOMAIN ?? "",
  clientId: import.meta.env.VITE_COGNITO_CLIENT_ID ?? "",
  redirectUri: import.meta.env.VITE_REDIRECT_URI ?? "",
};

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

function getAuthHeader(): string | null {
  if (AUTH_MODE === "cognito") {
    const token = getAccessToken();
    if (!token) return null;
    return `Bearer ${token}`;
  }
  const sub = getDevSub();
  if (!sub) return null;
  return `Bearer dev_${sub}`;
}

/** Attempt one token refresh. Returns new access token or throws. */
async function attemptRefresh(): Promise<string> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    throw new ApiError(401, "no refresh token");
  }
  const tokens = await refreshTokens(COGNITO_CFG, refreshToken);
  storeTokens(tokens.access_token, tokens.refresh_token);
  return tokens.access_token;
}

async function rawFetch(path: string, init: RequestInit, authHeader: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.body) {
    headers["content-type"] = "application/json";
  }
  if (authHeader) {
    headers.authorization = authHeader;
  }
  return fetch(`${API_URL}${path}`, { ...init, headers: { ...headers, ...init.headers } });
}

async function request<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
  if (auth && AUTH_MODE !== "cognito") {
    // Dev mode — simple path, no retry
    const sub = getDevSub();
    if (!sub) {
      throw new ApiError(401, "not signed in");
    }
    const headers: Record<string, string> = {};
    if (init.body) {
      headers["content-type"] = "application/json";
    }
    headers.authorization = `Bearer dev_${sub}`;
    const res = await fetch(`${API_URL}${path}`, { ...init, headers: { ...headers, ...init.headers } });
    if (res.status === 204) return undefined as T;
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, body?.message ?? res.statusText, body?.errors);
    return body as T;
  }

  // Cognito mode (or unauthenticated)
  const authHeader = auth ? getAuthHeader() : null;
  if (auth && !authHeader) {
    throw new ApiError(401, "not signed in");
  }

  let res = await rawFetch(path, init, authHeader);

  // One refresh-and-retry on 401 in cognito mode (never in dev mode, never loops)
  if (auth && AUTH_MODE === "cognito" && res.status === 401) {
    try {
      const newToken = await attemptRefresh();
      res = await rawFetch(path, init, `Bearer ${newToken}`);
    } catch {
      throw new ApiError(401, "session expired");
    }
  }

  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.message ?? res.statusText, body?.errors);
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
