import { describe, expect, it, vi } from "vitest";
import { createClient, RobloxApiError } from "./http";

const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe("createClient", () => {
  it("retries once with the csrf token Roblox hands back on 403", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(403, { errors: [{ message: "XSRF token invalid" }] }, { "x-csrf-token": "tok1" }))
      .mockResolvedValueOnce(res(200, { ok: true }));
    const client = createClient(fetchImpl);

    await expect(client.json("https://x/y", { method: "PATCH" })).resolves.toEqual({ ok: true });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const retryInit = fetchImpl.mock.calls[1][1] as RequestInit;
    expect(new Headers(retryInit.headers).get("x-csrf-token")).toBe("tok1");
    expect(retryInit.credentials).toBe("include");
  });

  it("reuses the token on later requests", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(403, {}, { "x-csrf-token": "tok1" }))
      .mockResolvedValueOnce(res(200))
      .mockResolvedValueOnce(res(200));
    const client = createClient(fetchImpl);

    await client.request("https://x/a", { method: "PATCH" });
    await client.request("https://x/b", { method: "PATCH" });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(new Headers((fetchImpl.mock.calls[2][1] as RequestInit).headers).get("x-csrf-token")).toBe("tok1");
  });

  it("does not loop when a 403 is a real permission error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(403, { errors: [{ message: "You do not have permission" }] }));
    const client = createClient(fetchImpl);

    await expect(client.request("https://x/a")).rejects.toMatchObject({
      status: 403,
      message: "You do not have permission",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces Roblox's error message and retry-after", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(429, { errors: [{ message: "Too many requests" }] }, { "retry-after": "3" }));
    const client = createClient(fetchImpl);

    const err = await client.request("https://x/a").catch((e) => e);
    expect(err).toBeInstanceOf(RobloxApiError);
    expect(err.message).toBe("Too many requests");
    expect(err.retryAfterMs).toBe(3000);
  });
});
