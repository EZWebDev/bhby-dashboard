/**
 * Netlify Function: shopify-orders
 * Fetches the last 30 days of orders from Shopify Admin GraphQL API.
 * Returns: salesBySku, utmBreakdown, aovTimeSeries, aovOverall,
 *          totalShipping, newVsReturning, totalOrders, totalRevenue,
 *          totalUnitsSold
 */

import { verifyToken } from "./_auth-verify.mjs";
import { parseRange, zonedMidnightISO, SHOP_TIME_ZONE, ADS_TIME_ZONE } from "./_range.mjs";

const STORE = "behappybeyou1.myshopify.com";
const API_VERSION = "2026-01";
const GQL_URL = `https://${STORE}/admin/api/${API_VERSION}/graphql.json`;
const INVENTORY_THRESHOLD = 50;

/*
 * Non-sale orders (free samples, TikTok gifts, replacements, test/seed orders)
 * distort DTC revenue/AOV/units. Per data-hygiene rule, exclude by TAG (not just
 * $0 total — some carry a non-zero value). Word-boundary + case-insensitive so
 * "TikTok Shop", "Free Sample", "Gift Order", "test-order" all match, but
 * legit tags like "latest" or "contest" do not.
 */
const EXCLUDE_TAG_RE = /\b(sample|tiktok|gift|replacement|test|seed)\b/i;

function orderExcludeReason(order) {
  for (const tag of order.tags || []) {
    if (EXCLUDE_TAG_RE.test(tag)) return tag;
  }
  return null;
}

const ORDERS_QUERY = `
  query GetOrders($cursor: String) {
    orders(
      first: 250
      after: $cursor
      query: "created_at:>='{{ start }}' created_at:<'{{ endExclusive }}' financial_status:paid"
      sortKey: CREATED_AT
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          name
          createdAt
          tags
          totalPriceSet { shopMoney { amount } }
          subtotalPriceSet { shopMoney { amount } }
          totalShippingPriceSet { shopMoney { amount } }
          customer {
            numberOfOrders
          }
          customerJourneySummary {
            lastVisit {
              utmParameters {
                source
                medium
                campaign
              }
              referrerUrl
            }
          }
          lineItems(first: 50) {
            edges {
              node {
                sku
                title
                quantity
                variant {
                  title
                  displayName
                }
                originalTotalSet { shopMoney { amount } }
              }
            }
          }
        }
      }
    }
  }
`;

async function shopifyGraphQL(token, query, variables = {}) {
  const response = await fetch(GQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Shopify GraphQL HTTP ${response.status}: ${await response.text()}`);
  }

  const json = await response.json();
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return { data: json.data, cost: json.extensions?.cost };
}

/**
 * Fetch every paid order overlapping BOTH the shop-timezone window and the
 * Google-Ads-timezone window for the same calendar dates.
 *
 * Shop midnight (ET) is the EARLIER instant and ads midnight (PT) the LATER
 * one, so [shopStart, adsEnd) is the union of the two windows — one fetch
 * covers both and callers bucket in JS. Bare dates were previously resolved
 * implicitly in the shop timezone; the bounds are now explicit and DST-correct.
 */
async function fetchAllOrders(token, start, endExclusive) {
  const query = ORDERS_QUERY
    .replace("{{ start }}", zonedMidnightISO(start, SHOP_TIME_ZONE))
    .replace("{{ endExclusive }}", zonedMidnightISO(endExclusive, ADS_TIME_ZONE));
  const allOrders = [];
  let cursor = null;
  let page = 0;

  while (true) {
    page++;
    const { data, cost } = await shopifyGraphQL(token, query, { cursor });
    const connection = data.orders;

    for (const edge of connection.edges) {
      allOrders.push(edge.node);
    }

    // Respect throttle: if approaching limit, wait
    if (cost && cost.throttleStatus) {
      const { currentlyAvailable, restoreRate } = cost.throttleStatus;
      const queryActualCost = cost.actualQueryCost || 50;
      if (currentlyAvailable < queryActualCost * 2) {
        const waitMs = Math.ceil((queryActualCost * 2 - currentlyAvailable) / restoreRate) * 1000;
        await new Promise((r) => setTimeout(r, Math.min(waitMs, 2000)));
      }
    }

    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }

  return allOrders;
}

/** Orders whose createdAt falls in [startISO, endISO) — both offset-anchored. */
function windowOrders(orders, startISO, endISO) {
  const s = new Date(startISO).getTime();
  const e = new Date(endISO).getTime();
  return orders.filter((o) => {
    const t = new Date(o.createdAt).getTime();
    return t >= s && t < e;
  });
}

/** Revenue + order count for an arbitrary window, applying the same tag exclusion. */
function windowTotals(orders) {
  let revenue = 0;
  let count = 0;
  for (const order of orders) {
    if (orderExcludeReason(order)) continue;
    revenue += parseFloat(order.totalPriceSet?.shopMoney?.amount || 0);
    count++;
  }
  return { revenue: Math.round(revenue * 100) / 100, orders: count };
}

function processOrders(allOrders) {
  const skuMap = new Map();
  const utmMap = new Map();
  const dayMap = new Map();

  // Partition out non-sale orders (samples/gifts/tests) BEFORE any metric.
  const excludedTagCounts = {};
  const orders = [];
  let excludedCount = 0;
  let excludedRevenue = 0;
  for (const order of allOrders) {
    const reason = orderExcludeReason(order);
    if (reason) {
      excludedCount++;
      excludedRevenue += parseFloat(order.totalPriceSet?.shopMoney?.amount || 0);
      excludedTagCounts[reason] = (excludedTagCounts[reason] || 0) + 1;
      continue;
    }
    orders.push(order);
  }

  let totalRevenue = 0;
  let totalShipping = 0;
  let newCount = 0;
  let returningCount = 0;
  let totalUnitsSold = 0;

  for (const order of orders) {
    const price = parseFloat(order.totalPriceSet?.shopMoney?.amount || 0);
    const shipping = parseFloat(order.totalShippingPriceSet?.shopMoney?.amount || 0);

    totalRevenue += price;
    totalShipping += shipping;

    // New vs returning (numberOfOrders returns string in GraphQL)
    const ordersCount = parseInt(order.customer?.numberOfOrders ?? "1", 10);
    if (ordersCount <= 1) newCount++;
    else returningCount++;

    // AOV time series -- group by date
    const date = order.createdAt.split("T")[0];
    if (!dayMap.has(date)) dayMap.set(date, { revenue: 0, count: 0 });
    const day = dayMap.get(date);
    day.revenue += price;
    day.count++;

    // UTM breakdown
    const utm = order.customerJourneySummary?.lastVisit?.utmParameters;
    const utmKey = utm?.source
      ? `${utm.source}/${utm.medium || "none"}`
      : order.customerJourneySummary?.lastVisit?.referrerUrl
        ? "organic/referral"
        : "direct/none";

    if (!utmMap.has(utmKey)) {
      utmMap.set(utmKey, {
        source: utm?.source || (utmKey.startsWith("organic") ? "organic" : "direct"),
        medium: utm?.medium || utmKey.split("/")[1],
        campaign: utm?.campaign || "",
        orderCount: 0,
        revenue: 0,
      });
    }
    const utmEntry = utmMap.get(utmKey);
    utmEntry.orderCount++;
    utmEntry.revenue += price;

    // Sales by SKU
    for (const edge of order.lineItems.edges) {
      const li = edge.node;
      const sku = li.sku || `no-sku:${li.title}`;
      const lineTotal = parseFloat(li.originalTotalSet?.shopMoney?.amount || 0);

      if (!skuMap.has(sku)) {
        skuMap.set(sku, {
          sku,
          title: li.title,
          variant: li.variant?.title || li.variant?.displayName || "",
          totalRevenue: 0,
          unitsSold: 0,
        });
      }
      const entry = skuMap.get(sku);
      entry.totalRevenue += lineTotal;
      entry.unitsSold += li.quantity;
      totalUnitsSold += li.quantity;
    }
  }

  // Build AOV time series (sorted by date)
  const aovTimeSeries = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, { revenue, count }]) => ({
      date,
      aov: count > 0 ? Math.round((revenue / count) * 100) / 100 : 0,
      orderCount: count,
    }));

  // Sales by SKU sorted by revenue desc
  const salesBySku = Array.from(skuMap.values())
    .sort((a, b) => b.totalRevenue - a.totalRevenue)
    .map((s) => ({ ...s, totalRevenue: Math.round(s.totalRevenue * 100) / 100 }))
    .slice(0, 20);

  // UTM breakdown sorted by order count desc
  const utmBreakdown = Array.from(utmMap.values())
    .sort((a, b) => b.orderCount - a.orderCount)
    .map((u) => ({ ...u, revenue: Math.round(u.revenue * 100) / 100 }));

  return {
    totalOrders: orders.length,
    totalUnitsSold,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalShipping: Math.round(totalShipping * 100) / 100,
    aovOverall: orders.length > 0 ? Math.round((totalRevenue / orders.length) * 100) / 100 : 0,
    newVsReturning: { new: newCount, returning: returningCount },
    aovTimeSeries,
    salesBySku,
    utmBreakdown,
    excludedOrders: excludedCount,
    excludedRevenue: Math.round(excludedRevenue * 100) / 100,
    excludedTagCounts,
    pulledAt: new Date().toISOString(),
    windowDays: 30,
  };
}

export default async function handler(req, context) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const authError = verifyToken(req);
  if (authError) return authError;

  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!token) {
    return new Response(
      JSON.stringify({ error: "SHOPIFY_ACCESS_TOKEN not configured" }),
      { status: 500, headers: corsHeaders }
    );
  }

  try {
    const range = parseRange(req);
    const fetched = await fetchAllOrders(token, range.start, range.endExclusive);

    // Store KPIs stay bucketed on SHOP time so they keep matching Shopify admin.
    const result = processOrders(windowOrders(
      fetched,
      zonedMidnightISO(range.start, SHOP_TIME_ZONE),
      zonedMidnightISO(range.endExclusive, SHOP_TIME_ZONE)
    ));
    result.range = { start: range.start, end: range.end };
    result.windowDays = range.days;
    result.timeZone = SHOP_TIME_ZONE;

    // Like-for-like figure for the ads section: same calendar dates, bucketed on
    // the Google Ads account timezone so revenue and ad spend cover the same
    // instants. Google cannot report Eastern days (account TZ is immutable), so
    // the alignment has to happen on this side.
    result.adWindow = {
      timeZone: ADS_TIME_ZONE,
      ...windowTotals(windowOrders(
        fetched,
        zonedMidnightISO(range.start, ADS_TIME_ZONE),
        zonedMidnightISO(range.endExclusive, ADS_TIME_ZONE)
      )),
    };

    // Previous equal-length window, for delta comparison. Only the scalar KPIs
    // are needed downstream, so return a compact summary (not the full payload).
    if (range.prev) {
      const p = processOrders(windowOrders(
        await fetchAllOrders(token, range.prev.start, range.prev.endExclusive),
        zonedMidnightISO(range.prev.start, SHOP_TIME_ZONE),
        zonedMidnightISO(range.prev.endExclusive, SHOP_TIME_ZONE)
      ));
      result.previous = {
        range: { start: range.prev.start, end: range.prev.end },
        totalRevenue: p.totalRevenue,
        totalOrders: p.totalOrders,
        totalUnitsSold: p.totalUnitsSold,
        aovOverall: p.aovOverall,
        totalShipping: p.totalShipping,
        newVsReturning: p.newVsReturning,
      };
    }

    return new Response(JSON.stringify(result), { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error("[shopify-orders]", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: corsHeaders }
    );
  }
}
