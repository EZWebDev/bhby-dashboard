/**
 * Quick test script — runs the Google Ads API call directly.
 * Usage: node scripts/test-google-ads.mjs
 */

import { readFileSync } from "fs";

// Load .env manually
const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
for (const line of env.split("\n")) {
  const [k, ...v] = line.split("=");
  if (k && v.length) process.env[k.trim()] = v.join("=").trim();
}

const CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_ADS_REFRESH_TOKEN;
const DEV_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
const CUSTOMER_ID = process.env.GOOGLE_ADS_CUSTOMER_ID;
const LOGIN_CUSTOMER_ID = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
const API_VERSION = "v19";

console.log("Config:");
console.log("  CUSTOMER_ID:", CUSTOMER_ID);
console.log("  LOGIN_CUSTOMER_ID:", LOGIN_CUSTOMER_ID);
console.log("  DEV_TOKEN:", DEV_TOKEN?.slice(0, 8) + "...");

// Step 1: Get access token
console.log("\n1. Getting access token...");
const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
    grant_type: "refresh_token",
  }).toString(),
});
const tokenData = await tokenRes.json();
if (tokenData.error) {
  console.error("Token error:", tokenData);
  process.exit(1);
}
const accessToken = tokenData.access_token;
console.log("   Access token obtained:", accessToken.slice(0, 20) + "...");

// Step 2: Try FROM campaign query
console.log("\n2. Testing GAQL query FROM campaign using search endpoint...");
const url = `https://googleads.googleapis.com/${API_VERSION}/customers/${CUSTOMER_ID}/googleAds:search`;

const headers = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${accessToken}`,
  "developer-token": DEV_TOKEN,
};
if (LOGIN_CUSTOMER_ID) headers["login-customer-id"] = LOGIN_CUSTOMER_ID;

console.log("   URL:", url);
console.log("   Headers (redacted):", {
  ...headers,
  Authorization: "Bearer ...",
  "developer-token": DEV_TOKEN?.slice(0, 8) + "...",
});

const gaql = `
  SELECT
    segments.date,
    metrics.cost_micros,
    metrics.clicks,
    metrics.impressions,
    metrics.conversions,
    metrics.conversions_value
  FROM campaign
  WHERE segments.date DURING LAST_30_DAYS
  ORDER BY segments.date ASC
`;

const res = await fetch(url, {
  method: "POST",
  headers,
  body: JSON.stringify({ query: gaql }),
});

const text = await res.text();
console.log("\n   HTTP status:", res.status);
console.log("   Response body:", text.slice(0, 1000));
