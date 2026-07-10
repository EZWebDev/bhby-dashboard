/**
 * Netlify Function: shopify-abandoned
 * Fetches abandoned checkouts for the last 30 days.
 * Protected by dashboard auth token.
 */

import { verifyToken } from "./_auth-verify.mjs";

/*
 * Requires the read_checkouts scope.
 * Returns: checkoutAbandonmentRate, totalAbandoned, totalRecovered,
 *          totalAbandonedValue, recentAbandoned
 *
 * NOTE: Shopify does not have a "sessions" API in Admin GraphQL.
 * Cart abandonment rate here = open (unrecovered) checkouts / all checkouts.
 *
 * Sample/gift/test orders (excluded from shopify-orders metrics) do NOT leak in
 * here: those are placed/draft orders created in the admin, which never enter the
 * storefront checkout flow, so they never appear as abandonedCheckouts. The
 * abandonedCheckout node also has no order-tag field to filter on. No change needed.
 */

const STORE = "behappybeyou1.myshopify.com";
const API_VERSION = "2026-01";
const GQL_URL = `https://${STORE}/admin/api/${API_VERSION}/graphql.json`;

/*
 * Card-testing bots flood abandoned checkouts with fake "namedigits@freemail"
 * emails (e.g. umairhameed2026@outlook.com hit checkout 6x, klopez0802@gmail.com,
 * AndreaMannino12@hotmail.com). They never complete, so they push the abandonment
 * rate toward ~99% and inflate the "value at risk" with un-recoverable noise.
 * Filter them (plus internal test emails) out so the metrics reflect real
 * customers. Heuristic — the count is exposed and labeled in the UI so it's
 * auditable and tunable. Real customers (no trailing digits: monikaalban@,
 * randylhorner@, melisamonroe@) are NOT matched.
 */
const TEST_EMAIL_DOMAINS = ["ezweb.dev"];
// localpart = 4+ letters, optional single .-_ + more letters, then 2+ trailing digits, nothing else.
const BOT_LOCALPART_RE = /^[a-z]{4,}([._-][a-z]+)?\d{2,}$/i;
function isSuspectedBotCheckout(checkout) {
  const email = checkout.customer?.email;
  if (!email) return false; // keep no-email drops as genuine abandonment
  const at = email.indexOf("@");
  if (at < 1) return false;
  const localPart = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (TEST_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith("." + d))) return true;
  return BOT_LOCALPART_RE.test(localPart);
}
function maskEmail(email) {
  return email ? email.replace(/(?<=.).(?=[^@]*@)/g, "*") : null;
}

// Shopify Admin GraphQL uses abandonedCheckouts on the QueryRoot
const ABANDONED_QUERY = `
  query GetAbandonedCheckouts($cursor: String, $since: String!) {
    abandonedCheckouts(
      first: 250
      after: $cursor
      query: $since
      sortKey: CREATED_AT
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          createdAt
          completedAt
          abandonedCheckoutUrl
          totalPriceSet { shopMoney { amount currencyCode } }
          lineItems(first: 20) {
            edges {
              node {
                title
                quantity
                variant {
                  sku
                  title
                }
              }
            }
          }
          customer {
            email
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

async function fetchAllAbandoned(token) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const sinceFilter = `created_at:>=${since}`;
  const allCheckouts = [];
  let cursor = null;

  while (true) {
    const { data, cost } = await shopifyGraphQL(token, ABANDONED_QUERY, {
      cursor,
      since: sinceFilter,
    });
    const connection = data.abandonedCheckouts;

    for (const edge of connection.edges) {
      allCheckouts.push(edge.node);
    }

    if (cost?.throttleStatus) {
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

  return allCheckouts;
}

function processAbandoned(checkouts) {
  // The fetch returns oldest-first (sortKey CREATED_AT, no reverse), so the
  // table was showing the 10 OLDEST carts in the window. Sort newest-first here
  // so "Recent Abandoned Checkouts" actually shows the most recent ones.
  checkouts = [...checkouts].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // Partition out suspected card-testing bots + internal test emails BEFORE any metric.
  const bots = [];
  const real = [];
  for (const c of checkouts) (isSuspectedBotCheckout(c) ? bots : real).push(c);
  checkouts = real;
  const suspectedBots = bots.length;
  const suspectedBotValue = Math.round(
    bots.reduce((s, c) => s + parseFloat(c.totalPriceSet?.shopMoney?.amount || 0), 0) * 100
  ) / 100;
  const suspectedBotSamples = bots.slice(0, 8).map((c) => maskEmail(c.customer?.email)).filter(Boolean);

  const total = checkouts.length;
  const recovered = checkouts.filter((c) => c.completedAt !== null).length;
  const abandoned = total - recovered;

  let totalAbandonedValue = 0;
  let totalRecoveredValue = 0;

  const recentAbandoned = [];

  // Group by day for time series
  const dayMap = new Map();

  for (const checkout of checkouts) {
    const value = parseFloat(checkout.totalPriceSet?.shopMoney?.amount || 0);
    const date = checkout.createdAt.split("T")[0];

    if (!dayMap.has(date)) dayMap.set(date, { abandoned: 0, recovered: 0, abandonedValue: 0 });
    const day = dayMap.get(date);

    if (checkout.completedAt) {
      totalRecoveredValue += value;
      day.recovered++;
    } else {
      totalAbandonedValue += value;
      day.abandoned++;
      day.abandonedValue += value;

      // Collect top 10 most recent for the table
      if (recentAbandoned.length < 10) {
        recentAbandoned.push({
          id: checkout.id,
          createdAt: checkout.createdAt,
          value: Math.round(value * 100) / 100,
          currency: checkout.totalPriceSet?.shopMoney?.currencyCode || "USD",
          url: checkout.abandonedCheckoutUrl || null,
          itemCount: checkout.lineItems.edges.reduce((s, e) => s + e.node.quantity, 0),
          firstItem: checkout.lineItems.edges[0]?.node?.title || "—",
          email: maskEmail(checkout.customer?.email),
        });
      }
    }
  }

  // Sort recent by createdAt desc
  recentAbandoned.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const timeSeries = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({
      date,
      abandoned: d.abandoned,
      recovered: d.recovered,
      abandonedValue: Math.round(d.abandonedValue * 100) / 100,
    }));

  const abandonmentRate = total > 0 ? Math.round((abandoned / total) * 10000) / 100 : 0;
  const recoveryRate = abandoned > 0 ? Math.round((recovered / total) * 10000) / 100 : 0;

  return {
    windowDays: 30,
    total,
    abandoned,
    recovered,
    abandonmentRate,
    recoveryRate,
    totalAbandonedValue: Math.round(totalAbandonedValue * 100) / 100,
    totalRecoveredValue: Math.round(totalRecoveredValue * 100) / 100,
    timeSeries,
    recentAbandoned,
    suspectedBots,
    suspectedBotValue,
    suspectedBotSamples,
    rawTotal: total + suspectedBots,
    pulledAt: new Date().toISOString(),
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
    const checkouts = await fetchAllAbandoned(token);
    const result = processAbandoned(checkouts);
    return new Response(JSON.stringify(result), { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error("[shopify-abandoned]", err);

    // Provide helpful message if scope is missing
    const isScopeMissing =
      err.message.includes("403") ||
      err.message.toLowerCase().includes("forbidden") ||
      err.message.toLowerCase().includes("access denied");

    return new Response(
      JSON.stringify({
        error: err.message,
        hint: isScopeMissing
          ? "Ensure read_checkouts scope is granted. Redeploy the app and have the merchant re-authorize via the OAuth flow."
          : undefined,
      }),
      { status: isScopeMissing ? 403 : 500, headers: corsHeaders }
    );
  }
}
