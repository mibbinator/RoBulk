// Uploads a zip to an existing Chrome Web Store item and submits it for
// review, using Chrome Web Store API v2 with a service account.
// https://developer.chrome.com/docs/webstore/using-api
//
//   CWS_PUBLISHER_ID=... CWS_EXTENSION_ID=... CWS_SERVICE_ACCOUNT='{"client_email":...,"private_key":...}' \
//     node scripts/publish-chrome.mjs release/robulk-chrome-1.0.1.zip
//
// The item must already exist (first upload is done by hand in the dashboard)
// and the service account must be added under Account in the dashboard.

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const API = "https://chromewebstore.googleapis.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/chromewebstore";

const base64url = (input) => Buffer.from(input).toString("base64url");

/** A signed JWT asserting the service account's identity (RFC 7523). */
export function serviceAccountJwt({ client_email, private_key }, now = Math.floor(Date.now() / 1000)) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(private_key, "base64url");
  return `${header}.${claims}.${signature}`;
}

async function expectOk(res, what) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what} failed (${res.status}): ${text}`);
  return text ? JSON.parse(text) : {};
}

export async function publishChrome({
  zip,
  publisherId,
  extensionId,
  serviceAccount,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console.log,
  pollMs = 5000,
  maxPolls = 60,
}) {
  const token = await expectOk(
    await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: serviceAccountJwt(serviceAccount) }),
    }),
    "Getting an access token",
  );
  const auth = { Authorization: `Bearer ${token.access_token}` };
  const item = `publishers/${publisherId}/items/${extensionId}`;

  log(`Uploading ${(zip.length / 1024).toFixed(1)} KB to ${extensionId}…`);
  const upload = await expectOk(
    await fetchImpl(`${API}/upload/v2/${item}:upload`, { method: "POST", headers: { ...auth, "Content-Type": "application/zip" }, body: zip }),
    "Upload",
  );
  let state = upload.uploadState;
  for (let i = 0; state === "IN_PROGRESS" && i < maxPolls; i++) {
    await sleep(pollMs);
    const status = await expectOk(await fetchImpl(`${API}/v2/${item}:fetchStatus`, { headers: auth }), "Checking upload status");
    state = status.lastAsyncUploadState;
  }
  if (state !== "SUCCEEDED") throw new Error(`Upload ended in state ${state}. Check the item in the Chrome Web Store dashboard.`);
  log(`Uploaded version ${upload.crxVersion ?? "(unknown)"}.`);

  const published = await expectOk(
    await fetchImpl(`${API}/v2/${item}:publish`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ publishType: "DEFAULT_PUBLISH" }),
    }),
    "Submitting for review",
  );
  for (const w of published.warningInfo?.warnings ?? []) log(`Warning: ${w.reason}: ${w.description}`);
  log(`Submitted. Store state: ${published.state}. It goes live automatically once Google's review passes.`);
  return published;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [zipPath] = process.argv.slice(2);
  const { CWS_PUBLISHER_ID, CWS_EXTENSION_ID, CWS_SERVICE_ACCOUNT } = process.env;
  if (!zipPath || !CWS_PUBLISHER_ID || !CWS_EXTENSION_ID || !CWS_SERVICE_ACCOUNT) {
    console.error("Usage: CWS_PUBLISHER_ID=… CWS_EXTENSION_ID=… CWS_SERVICE_ACCOUNT='<key json>' node scripts/publish-chrome.mjs <zip>");
    process.exit(2);
  }
  await publishChrome({
    zip: readFileSync(zipPath),
    publisherId: CWS_PUBLISHER_ID,
    extensionId: CWS_EXTENSION_ID,
    serviceAccount: JSON.parse(CWS_SERVICE_ACCOUNT),
  });
}
