/**
 * Netlify Function: klaviyo
 * Flow + campaign (email) performance from the Klaviyo Reporting API for the
 * selected date window. Returns per-flow and per-campaign rows plus totals.
 *
 * Revenue = conversion_value attributed to each flow/campaign by Klaviyo, using
 * the "Placed Order" (Shopify) conversion metric.
 *
 * NOTE ON RATE LIMITS: the flow/campaign values-report endpoints are limited to
 * ~2 requests/minute. We therefore fetch the CURRENT window only (2 report
 * calls) and skip the previous-period comparison, so this stays well within one
 * function invocation and the API budget. Name lookups use the higher-limit
 * standard endpoints.
 *
 * Required env var:
 *   KLAVIYO_API_KEY              — private API key (pk_...) with read scopes for
 *                                  flows, campaigns, metrics, and reporting.
 * Optional:
 *   KLAVIYO_CONVERSION_METRIC_ID — defaults to RBBK6r (Placed Order / Shopify).
 */

import { verifyToken } from "./_auth-verify.mjs";
import { parseRange } from "./_range.mjs";

const API = "https://a.klaviyo.com/api";
const REVISION = "2024-10-15";
// Use UNIQUE opens/clicks over DELIVERED for rates (matches the Klaviyo UI and
// keeps rates ≤100%; the plain "opens" stat counts repeat opens).
const STATS = ["recipients", "delivered", "opens_unique", "clicks_unique", "conversions", "conversion_value", "unsubscribes"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json",
};

function kHeaders(key) {
  return { Authorization: `Klaviyo-API-Key ${key}`, revision: REVISION, "Content-Type": "application/json", accept: "application/json" };
}

async function kGet(key, urlOrPath) {
  const url = urlOrPath.startsWith("http") ? urlOrPath : API + urlOrPath;
  const r = await fetch(url, { headers: kHeaders(key) });
  if (!r.ok) throw new Error(`Klaviyo GET ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// One values-report POST (flow or campaign) for a custom [start, endExclusive) window.
async function kReport(key, type, metricId, start, endExclusive) {
  const body = {
    data: {
      type,
      attributes: {
        timeframe: { start: `${start}T00:00:00`, end: `${endExclusive}T00:00:00` },
        conversion_metric_id: metricId,
        statistics: STATS,
      },
    },
  };
  // One retry on 429 (rate limit), then give up gracefully.
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`${API}/${type}s/`, { method: "POST", headers: kHeaders(key), body: JSON.stringify(body) });
    if (r.ok) return (await r.json()).data.attributes.results;
    if (r.status === 429 && attempt === 0) { await new Promise((s) => setTimeout(s, 3000)); continue; }
    throw new Error(`Klaviyo ${type} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  return [];
}

async function flowNameMap(key) {
  const map = {};
  // Default list excludes archived flows, but archived flows can still have had
  // sends inside the window, so pull both live and archived.
  for (const filter of ["", `&filter=${encodeURIComponent("equals(archived,true)")}`]) {
    let url = `/flows/?fields%5Bflow%5D=name,status,archived&page%5Bsize%5D=50${filter}`;
    for (let i = 0; i < 10 && url; i++) {
      const d = await kGet(key, url);
      for (const f of d.data) map[f.id] = { name: f.attributes.name, status: f.attributes.archived ? "archived" : f.attributes.status };
      url = d.links?.next || null;
    }
  }
  return map;
}

async function campaignNameMap(key) {
  const map = {};
  // Default campaign list returns non-archived; pull archived separately so we
  // can flag (and later drop) archived campaigns, mirroring the flow map.
  const passes = [
    { archived: false, filter: "equals(messages.channel,'email')" },
    { archived: true, filter: "and(equals(messages.channel,'email'),equals(archived,true))" },
  ];
  for (const pass of passes) {
    let url = `/campaigns/?filter=${encodeURIComponent(pass.filter)}&fields%5Bcampaign%5D=name,send_time`;
    for (let i = 0; i < 15 && url; i++) {
      const d = await kGet(key, url);
      for (const c of d.data) map[c.id] = { name: c.attributes.name, sendTime: c.attributes.send_time, status: pass.archived ? "archived" : "sent" };
      url = d.links?.next || null;
    }
  }
  return map;
}

const r2 = (n) => Math.round(n * 100) / 100;
const rate = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

// Aggregate report rows (grouped per message) up to the parent flow/campaign id.
function aggregate(results, idKey, nameMap) {
  const by = new Map();
  for (const row of results) {
    const id = row.groupings?.[idKey];
    if (!id) continue;
    const s = row.statistics || {};
    if (!by.has(id)) by.set(id, { id, recipients: 0, delivered: 0, opens: 0, clicks: 0, conversions: 0, revenue: 0, unsubs: 0 });
    const b = by.get(id);
    b.recipients += s.recipients || 0;
    b.delivered += s.delivered || 0;
    b.opens += s.opens_unique || 0;
    b.clicks += s.clicks_unique || 0;
    b.conversions += s.conversions || 0;
    b.revenue += s.conversion_value || 0;
    b.unsubs += s.unsubscribes || 0;
  }
  return Array.from(by.values()).map((b) => ({
    id: b.id,
    name: nameMap[b.id]?.name || b.id,
    status: nameMap[b.id]?.status || "",
    sendTime: nameMap[b.id]?.sendTime || null,
    recipients: Math.round(b.recipients),
    delivered: Math.round(b.delivered),
    opens: Math.round(b.opens),
    clicks: Math.round(b.clicks),
    conversions: r2(b.conversions),
    revenue: r2(b.revenue),
    unsubs: Math.round(b.unsubs),
    openRate: rate(b.opens, b.delivered),
    clickRate: rate(b.clicks, b.delivered),
  }));
}

function totalsOf(rows) {
  const t = rows.reduce(
    (a, r) => ({ recipients: a.recipients + r.recipients, delivered: a.delivered + r.delivered, opens: a.opens + r.opens, clicks: a.clicks + r.clicks, conversions: a.conversions + r.conversions, revenue: a.revenue + r.revenue }),
    { recipients: 0, delivered: 0, opens: 0, clicks: 0, conversions: 0, revenue: 0 }
  );
  return { recipients: t.recipients, revenue: r2(t.revenue), conversions: r2(t.conversions), openRate: rate(t.opens, t.delivered), clickRate: rate(t.clicks, t.delivered) };
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const authError = verifyToken(req);
  if (authError) return authError;

  const key = process.env.KLAVIYO_API_KEY;
  if (!key) {
    return new Response(JSON.stringify({ configured: false, error: "KLAVIYO_API_KEY not set" }), { status: 200, headers: CORS });
  }
  const metricId = process.env.KLAVIYO_CONVERSION_METRIC_ID || "RBBK6r";

  try {
    const range = parseRange(req);

    // Reports (rate-limited) run sequentially; name lookups can run alongside.
    const [flowRes, campRes, flowNames, campNames] = await Promise.all([
      kReport(key, "flow-values-report", metricId, range.start, range.endExclusive),
      kReport(key, "campaign-values-report", metricId, range.start, range.endExclusive),
      flowNameMap(key),
      campaignNameMap(key),
    ]);

    // Exclude ARCHIVED flows/campaigns from results and totals — the section
    // reflects the currently-active email program, not superseded automations.
    const allFlows = aggregate(flowRes, "flow_id", flowNames).filter((f) => f.recipients > 0 || f.revenue > 0);
    const allCampaigns = aggregate(campRes, "campaign_id", campNames).filter((c) => c.recipients > 0 || c.revenue > 0);

    const flows = allFlows
      .filter((f) => f.status !== "archived")
      .sort((a, b) => b.revenue - a.revenue || b.recipients - a.recipients);
    const campaigns = allCampaigns
      .filter((c) => c.status !== "archived")
      .sort((a, b) => (b.sendTime || "").localeCompare(a.sendTime || "") || b.revenue - a.revenue);

    const archivedExcluded = {
      flows: allFlows.length - flows.length,
      campaigns: allCampaigns.length - campaigns.length,
      revenue: r2(
        allFlows.filter((f) => f.status === "archived").reduce((s, f) => s + f.revenue, 0) +
        allCampaigns.filter((c) => c.status === "archived").reduce((s, c) => s + c.revenue, 0)
      ),
    };

    const flowTotals = totalsOf(flows);
    const campTotals = totalsOf(campaigns);

    return new Response(JSON.stringify({
      configured: true,
      range: { start: range.start, end: range.end },
      windowDays: range.days,
      conversionMetricId: metricId,
      totals: {
        emailRevenue: r2(flowTotals.revenue + campTotals.revenue),
        flowRevenue: flowTotals.revenue,
        campaignRevenue: campTotals.revenue,
        flowConversions: flowTotals.conversions,
        campaignConversions: campTotals.conversions,
        recipients: flowTotals.recipients + campTotals.recipients,
      },
      flowTotals,
      campaignTotals: campTotals,
      archivedExcluded,
      flows: flows.slice(0, 15),
      campaigns: campaigns.slice(0, 15),
      pulledAt: new Date().toISOString(),
    }), { status: 200, headers: CORS });
  } catch (err) {
    console.error("[klaviyo]", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}
