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
