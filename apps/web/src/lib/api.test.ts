import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, getDevSub, setDevSub } from "./api";

// ── localStorage shim ──────────────────────────────────────────────────────
const store = new Map<string, string>();
const localStorageShim = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
  removeItem: (key: string) => { store.delete(key); },
  clear: () => { store.clear(); },
};
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageShim,
  writable: true,
});

// ── helpers ────────────────────────────────────────────────────────────────
function mockFetch(status: number, body: unknown, headers?: Record<string, string>) {
  const headersMap = new Headers(headers);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    statusText: "OK",
    headers: headersMap,
    json: () => Promise.resolve(body),
  }));
}

describe("api client", () => {
  beforeEach(() => {
    store.clear();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("(1) authed call sends Bearer dev_<sub> authorization header", async () => {
    setDevSub("alice");
    mockFetch(200, []);

    await api.listForms();

    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/forms");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer dev_alice");
  });

  it("(2) authed call throws ApiError 401 without fetching when no sub stored", async () => {
    // no sub set — localStorage is clear
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.listForms()).rejects.toThrow(ApiError);
    await expect(api.listForms()).rejects.toMatchObject({ status: 401, message: "not signed in" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("(3) public call sends no authorization header", async () => {
    mockFetch(200, { id: "x", title: "t", slug: "s", fields: [] });

    await api.publicGetForm("some-slug");

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("(4) non-ok response throws ApiError with server message", async () => {
    setDevSub("bob");
    mockFetch(404, { message: "form not found", errors: [] });

    await expect(api.getForm("nonexistent")).rejects.toThrow(ApiError);
    await expect(api.getForm("nonexistent")).rejects.toMatchObject({
      status: 404,
      message: "form not found",
    });
  });

  it("(5) 204 response resolves to undefined", async () => {
    setDevSub("carol");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      status: 204,
      ok: true,
      statusText: "No Content",
      headers: new Headers(),
      json: () => Promise.reject(new Error("no body")),
    }));

    const result = await api.deleteForm("some-id");
    expect(result).toBeUndefined();
  });

  // helper to verify setDevSub / getDevSub round-trip
  it("setDevSub / getDevSub round-trip", () => {
    expect(getDevSub()).toBeNull();
    setDevSub("dev-user");
    expect(getDevSub()).toBe("dev-user");
    setDevSub(null);
    expect(getDevSub()).toBeNull();
  });
});
