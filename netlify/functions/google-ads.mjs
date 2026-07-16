/**
 * Netlify Function: google-ads
 * Fetches last 30 days of Google Ads performance metrics.
 *
 * Uses the Google Ads REST API v21 (no npm dependencies — pure fetch).
 * NOTE: Google sunsets API versions ~yearly. If this 404s with an HTML page,
 * bump GOOGLE_ADS_API_VERSION to the current live version (was v19, now v21).
 * On each call:
 *   1. Exchanges GOOGLE_ADS_REFRESH_TOKEN for a short-lived access token
 *   2. Runs a GAQL query against the customer resource
 *   3. Returns: totalSpend, totalClicks, totalImpressions, cpc,
 *               acos (ad spend / ad-attributed revenue),
 *               dailySpend (time series for chart)
 *
 * Required env vars (set in Netlify > Build & Deploy > Environment Variables):
 *   GOOGLE_ADS_DEVELOPER_TOKEN   — from Google Ads > Tools > API Center
 *   GOOGLE_ADS_CLIENT_ID         — from Google Cloud OAuth 2.0 credentials
 *   GOOGLE_ADS_CLIENT_SECRET     — from Google Cloud OAuth 2.0 credentials
 *   GOOGLE_ADS_REFRESH_TOKEN     — from the get-google-refresh-token.mjs script
 *   GOOGLE_ADS_CUSTOMER_ID       — 10-digit account ID, digits only (no dashes)
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID — (optional) MCC manager account ID if applicable
 */

import { verifyToken } from "./_auth-verify.mjs";
import { parseRange } from "./_range.mjs";

const GOOGLE_ADS_API_VERSION = "v21";
// The account sums 2 Primary "Purchase" conversion actions (Shopify + GA4), ~1.8x
// inflating conversion value. Use ONLY this one so ACOS/ROAS are real. Override in
// Netlify via GOOGLE_ADS_PRIMARY_CONVERSION_ACTION if you keep a different action.
const PRIMARY_CONVERSION_ACTION = process.env.GOOGLE_ADS_PRIMARY_CONVERSION_ACTION || "Google Shopping App Purchase";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json",
};

// ─── Step 1: Exchange refresh token for access token ─────────────────────────
async function getAccessToken(clientId, clientSecret, refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Google OAuth token error: ${data.error_description || data.error || res.status}`);
  }
  return data.access_token;
}

// ─── Step 2: Run GAQL query ───────────────────────────────────────────────────
async function queryGoogleAds(accessToken, devToken, customerId, loginCustomerId, gaqlQuery) {
  const url = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${customerId}/googleAds:searchStream`;

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${accessToken}`,
    "developer-token": devToken,
  };

  // If using a Manager (MCC) account, set login-customer-id
  if (loginCustomerId) {
    headers["login-customer-id"] = loginCustomerId;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: gaqlQuery }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Ads API error ${res.status}: ${text}`);
  }

  // searchStream returns a JSON ARRAY of chunks: [{ results: [...] }, ...]
  // (NOT NDJSON — parsing it line-by-line silently yields zero rows.)
  const text = await res.text();
  const rows = [];
  let chunks;
  try {
    chunks = JSON.parse(text);
  } catch (e) {
    throw new Error(`Google Ads response parse error: ${e.message}: ${text.slice(0, 200)}`);
  }
  for (const chunk of Array.isArray(chunks) ? chunks : [chunks]) {
    if (chunk && chunk.results) rows.push(...chunk.results);
  }
  return rows;
}

// ─── Process rows into metrics ────────────────────────────────────────────────
function processRows(rows) {
  const dayMap = new Map();

  let totalCostMicros = 0;
  let totalClicks = 0;
  let totalImpressions = 0;
  let totalConversionsValue = 0;
  let totalConversions = 0;

  for (const row of rows) {
    const metrics = row.metrics || {};
    const costMicros = Number(metrics.costMicros || 0);
    const clicks = Number(metrics.clicks || 0);
    const impressions = Number(metrics.impressions || 0);
    const conversionsValue = Number(metrics.conversionsValue || 0);
    const conversions = Number(metrics.conversions || 0);
    const date = row.segments?.date || "unknown";

    totalCostMicros += costMicros;
    totalClicks += clicks;
    totalImpressions += impressions;
    totalConversionsValue += conversionsValue;
    totalConversions += conversions;

    if (!dayMap.has(date)) {
      dayMap.set(date, { date, costMicros: 0, clicks: 0, impressions: 0 });
    }
    const day = dayMap.get(date);
    day.costMicros += costMicros;
    day.clicks += clicks;
    day.impressions += impressions;
  }

  const totalSpend = totalCostMicros / 1_000_000;
  const cpc = totalClicks > 0 ? totalSpend / totalClicks : 0;
  const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;

  // ACOS = Ad Spend / Ad-Attributed Revenue * 100
  // (meaningful once shopping campaigns have conversion tracking set up)
  const acos = totalConversionsValue > 0 ? (totalSpend / totalConversionsValue) * 100 : null;

  // Daily time series for chart (sorted by date)
  const dailySpend = Array.from(dayMap.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ date, costMicros, clicks, impressions }) => ({
      date,
      spend: Math.round((costMicros / 1_000_000) * 100) / 100,
      clicks,
      impressions,
    }));

  return {
    totalSpend: Math.round(totalSpend * 100) / 100,
    totalClicks,
    totalImpressions,
    totalConversions: Math.round(totalConversions * 100) / 100,
    totalConversionsValue: Math.round(totalConversionsValue * 100) / 100,
    cpc: Math.round(cpc * 100) / 100,
    ctr: Math.round(ctr * 100) / 100,
    acos: acos !== null ? Math.round(acos * 100) / 100 : null,
    dailySpend,
    pulledAt: new Date().toISOString(),
    windowDays: 30,
  };
}

// ─── Compute all ad metrics for one date window [start, end] (inclusive) ─────
async function computeAdMetrics(accessToken, devToken, customerId, loginCustomerId, start, end) {
  const dateFilter = `segments.date BETWEEN '${start}' AND '${end}'`;

  const rows = await queryGoogleAds(accessToken, devToken, customerId, loginCustomerId, `
    SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions,
           metrics.conversions, metrics.conversions_value
    FROM campaign WHERE ${dateFilter} ORDER BY segments.date ASC
  `);
  const result = processRows(rows);

  // De-double conversion value: segment by conversion action and keep only the
  // primary one, so ACOS + ROAS reflect real (non-double-counted) ad revenue.
  try {
    const convRows = await queryGoogleAds(accessToken, devToken, customerId, loginCustomerId,
      `SELECT segments.conversion_action_name, metrics.conversions, metrics.conversions_value
       FROM campaign WHERE ${dateFilter}`);
    let keptVal = 0, keptConv = 0;
    const seen = new Set();
    for (const r of convRows) {
      const name = r.segments?.conversionActionName || "";
      seen.add(name);
      if (name === PRIMARY_CONVERSION_ACTION) {
        keptVal += Number(r.metrics?.conversionsValue || 0);
        keptConv += Number(r.metrics?.conversions || 0);
      }
    }
    if (seen.has(PRIMARY_CONVERSION_ACTION)) {
      result.totalConversionsValue = Math.round(keptVal * 100) / 100;
      result.totalConversions = Math.round(keptConv * 100) / 100;
      result.acos = keptVal > 0 ? Math.round((result.totalSpend / keptVal) * 10000) / 100 : null;
    }
    result.conversionAction = PRIMARY_CONVERSION_ACTION;
    result.conversionActionsSeen = Array.from(seen);
  } catch (e) {
    result.conversionActionError = e.message;
  }

  result.roas = (result.totalConversionsValue > 0 && result.totalSpend > 0)
    ? Math.round((result.totalConversionsValue / result.totalSpend) * 100) / 100
    : null;
  result.costPerConversion = result.totalConversions > 0
    ? Math.round((result.totalSpend / result.totalConversions) * 100) / 100
    : null;
  result.adAov = result.totalConversions > 0
    ? Math.round((result.totalConversionsValue / result.totalConversions) * 100) / 100
    : null;
  result.convRate = result.totalClicks > 0
    ? Math.round((result.totalConversions / result.totalClicks) * 10000) / 100
    : null;

  return result;
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  // Auth check
  const authError = verifyToken(req);
  if (authError) return authError;

  // Check required env vars
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_ADS_REFRESH_TOKEN;
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID;
  const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || null;

  const missing = ["GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN", "GOOGLE_ADS_CUSTOMER_ID"]
    .filter((k) => !process.env[k]);

  if (missing.length > 0) {
    return new Response(
      JSON.stringify({ error: `Missing env vars: ${missing.join(", ")}`, configured: false }),
      { status: 200, headers: CORS } // 200 so the frontend can show a "not configured" state
    );
  }

  try {
    const accessToken = await getAccessToken(clientId, clientSecret, refreshToken);
    const range = parseRange(req);

    const result = await computeAdMetrics(accessToken, devToken, customerId, loginCustomerId, range.start, range.end);
    result.range = { start: range.start, end: range.end };
    result.windowDays = range.days;

    if (range.prev) {
      const p = await computeAdMetrics(accessToken, devToken, customerId, loginCustomerId, range.prev.start, range.prev.end);
      result.previous = {
        range: { start: range.prev.start, end: range.prev.end },
        totalSpend: p.totalSpend,
        totalClicks: p.totalClicks,
        totalConversions: p.totalConversions,
        totalConversionsValue: p.totalConversionsValue,
        roas: p.roas,
        acos: p.acos,
        costPerConversion: p.costPerConversion,
        adAov: p.adAov,
        convRate: p.convRate,
        cpc: p.cpc,
      };
    }

    return new Response(JSON.stringify(result), { status: 200, headers: CORS });
  } catch (err) {
    console.error("[google-ads]", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: CORS }
    );
  }
}
