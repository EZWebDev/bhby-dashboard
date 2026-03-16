/**
 * One-time script to generate a Google OAuth2 Refresh Token for the Google Ads API.
 *
 * USAGE:
 *   1. Complete these steps first:
 *      a. Go to https://console.cloud.google.com/
 *      b. Create a project (or use existing), enable "Google Ads API"
 *      c. Go to APIs & Services > Credentials > Create > OAuth 2.0 Client ID
 *         - Application type: Web application
 *         - Authorized redirect URIs: add http://localhost:3456/oauth/callback
 *      d. Copy your Client ID and Client Secret below (or use env vars)
 *
 *   2. Run this script:
 *      node dashboard/scripts/get-google-refresh-token.mjs
 *
 *   3. Open the printed URL in your browser, log in with the Google account
 *      that owns (or has access to) the Google Ads account.
 *
 *   4. After approving, the script prints your REFRESH TOKEN.
 *      Save it as GOOGLE_ADS_REFRESH_TOKEN in Netlify environment variables.
 *
 * This script only needs to be run ONCE. The refresh token does not expire
 * unless you revoke it.
 */

import http from "http";
import { createHash } from "crypto";

// ─── Configuration ─────────────────────────────────────────────────────────
// Set these via environment variables or paste them directly (don't commit secrets):
const CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:3456/oauth/callback";
const PORT = 3456;

// Google Ads API requires these scopes
const SCOPES = ["https://www.googleapis.com/auth/adwords"];

// ─── Validate config ────────────────────────────────────────────────────────
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(`
ERROR: Missing GOOGLE_ADS_CLIENT_ID or GOOGLE_ADS_CLIENT_SECRET

Set them as environment variables before running:
  GOOGLE_ADS_CLIENT_ID=your-client-id \\
  GOOGLE_ADS_CLIENT_SECRET=your-client-secret \\
  node dashboard/scripts/get-google-refresh-token.mjs
`);
  process.exit(1);
}

// ─── Build auth URL ─────────────────────────────────────────────────────────
const state = createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 16);

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES.join(" "));
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent"); // forces refresh token to be returned
authUrl.searchParams.set("state", state);

console.log(`
╔══════════════════════════════════════════════════════════════════╗
║         BHBY — Google Ads OAuth2 Refresh Token Generator        ║
╚══════════════════════════════════════════════════════════════════╝

Step 1: Open this URL in your browser and log in with the Google account
        that has access to the Google Ads account:

  ${authUrl.toString()}

Step 2: After approving permissions, you will be redirected back to localhost.
        This script will automatically capture the code and exchange it.

Waiting for redirect on http://localhost:${PORT}/oauth/callback ...
`);

// ─── Local HTTP server to capture the OAuth callback ───────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname !== "/oauth/callback") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(`<h2>Error: ${error}</h2><p>Check the terminal for details.</p>`);
    console.error(`\nOAuth error: ${error}`);
    server.close();
    return;
  }

  if (returnedState !== state) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end("<h2>State mismatch. Possible CSRF. Try again.</h2>");
    server.close();
    return;
  }

  // Exchange code for tokens
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }).toString(),
    });

    const tokens = await tokenRes.json();

    if (tokens.error) {
      throw new Error(`${tokens.error}: ${tokens.error_description}`);
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
      <html><body style="font-family:monospace;padding:20px;background:#f5f6fa;">
        <h2 style="color:#16a34a;">✓ Success! Refresh token generated.</h2>
        <p>Check the terminal for your tokens. You can close this tab.</p>
      </body></html>
    `);

    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                        SUCCESS!                                  ║
╚══════════════════════════════════════════════════════════════════╝

Add these to your Netlify environment variables
(Build & Deploy > Environment Variables):

  GOOGLE_ADS_REFRESH_TOKEN=${tokens.refresh_token}

(Access token, expires in ~1 hour — for reference only, Netlify uses refresh token):
  Access Token: ${tokens.access_token?.slice(0, 40)}...

NOTE: If refresh_token is undefined, re-run the script. Google only returns
      the refresh token on the FIRST consent. If you've consented before,
      go to https://myaccount.google.com/permissions and revoke the app,
      then run this script again.
`);

  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end(`<h2>Token exchange failed</h2><pre>${err.message}</pre>`);
    console.error("\nToken exchange error:", err.message);
  }

  server.close();
});

server.listen(PORT, () => {
  // Server started, URL was already printed above
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\nPort ${PORT} is already in use. Kill the process using it and try again.`);
  } else {
    console.error("\nServer error:", err.message);
  }
  process.exit(1);
});
