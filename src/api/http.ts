// Thin wrapper over fetch for Roblox web APIs.
//
// Requests ride on the user's existing roblox.com session (credentials:
// "include"); RoBulk never reads or stores the session cookie itself.
// Mutating requests need an x-csrf-token: Roblox rejects the first attempt
// with 403 and hands back a token in a response header, and we retry once.

export class RobloxApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "RobloxApiError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RobloxClient {
  request(url: string, init?: RequestInit): Promise<Response>;
  json<T>(url: string, init?: RequestInit): Promise<T>;
}

export function createClient(fetchImpl: FetchLike = (i, o) => fetch(i, o)): RobloxClient {
  let csrfToken = "";

  const send = (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    if (csrfToken) headers.set("x-csrf-token", csrfToken);
    return fetchImpl(url, { ...init, headers, credentials: "include" });
  };

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    let res = await send(url, init);
    const freshToken = res.headers.get("x-csrf-token");
    if (res.status === 403 && freshToken && freshToken !== csrfToken) {
      csrfToken = freshToken;
      res = await send(url, init);
    }
    if (!res.ok) throw await toError(res);
    return res;
  }

  async function json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await request(url, init);
    return (await res.json()) as T;
  }

  return { request, json };
}

async function toError(res: Response): Promise<RobloxApiError> {
  let message = `${res.status} ${res.statusText}`.trim();
  try {
    const body = await res.json();
    const first = body?.errors?.[0];
    if (first?.message) message = first.message;
    else if (typeof body?.message === "string") message = body.message;
  } catch {
    // Non-JSON error body; keep the status line.
  }
  const retryAfter = Number(res.headers.get("retry-after"));
  return new RobloxApiError(message, res.status, retryAfter > 0 ? retryAfter * 1000 : undefined);
}

export function jsonBody(body: unknown): RequestInit {
  return { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } };
}
