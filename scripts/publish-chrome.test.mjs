import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { publishChrome, serviceAccountJwt } from "./publish-chrome.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const serviceAccount = { client_email: "robulk@project.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

describe("serviceAccountJwt", () => {
  it("signs a JWT Google can verify", () => {
    const jwt = serviceAccountJwt(serviceAccount, 1_800_000_000);
    const [header, claims, signature] = jwt.split(".");

    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
      iss: "robulk@project.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/chromewebstore",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });
    expect(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, signature, "base64url")).toBe(true);
  });
});

describe("publishChrome", () => {
  it("gets a token, uploads, waits for processing and submits for review", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: "tok" }))
      .mockResolvedValueOnce(json({ uploadState: "IN_PROGRESS", crxVersion: "1.0.1" }))
      .mockResolvedValueOnce(json({ lastAsyncUploadState: "IN_PROGRESS" }))
      .mockResolvedValueOnce(json({ lastAsyncUploadState: "SUCCEEDED" }))
      .mockResolvedValueOnce(json({ state: "PENDING_REVIEW" }));

    const result = await publishChrome({
      zip: Buffer.from("zip-bytes"),
      publisherId: "pub1",
      extensionId: "ext1",
      serviceAccount,
      fetchImpl,
      sleep: async () => {},
      log: () => {},
    });

    expect(result.state).toBe("PENDING_REVIEW");
    const calls = fetchImpl.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${url}`);
    expect(calls).toEqual([
      "POST https://oauth2.googleapis.com/token",
      "POST https://chromewebstore.googleapis.com/upload/v2/publishers/pub1/items/ext1:upload",
      "GET https://chromewebstore.googleapis.com/v2/publishers/pub1/items/ext1:fetchStatus",
      "GET https://chromewebstore.googleapis.com/v2/publishers/pub1/items/ext1:fetchStatus",
      "POST https://chromewebstore.googleapis.com/v2/publishers/pub1/items/ext1:publish",
    ]);
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe("Bearer tok");
    expect(String(fetchImpl.mock.calls[0][1].body)).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
  });

  it("stops before publishing when the upload fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: "tok" }))
      .mockResolvedValueOnce(json({ uploadState: "FAILED" }));

    await expect(
      publishChrome({ zip: Buffer.from("x"), publisherId: "p", extensionId: "e", serviceAccount, fetchImpl, sleep: async () => {}, log: () => {} }),
    ).rejects.toThrow(/FAILED/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces Google's error message", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ error: "invalid_grant" }, 400));

    await expect(
      publishChrome({ zip: Buffer.from("x"), publisherId: "p", extensionId: "e", serviceAccount, fetchImpl, log: () => {} }),
    ).rejects.toThrow(/Getting an access token failed \(400\).*invalid_grant/);
  });
});
