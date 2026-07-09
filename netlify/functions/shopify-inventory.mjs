/**
 * Netlify Function: shopify-inventory
 * Fetches all product variants and returns those with inventory < threshold.
 * Threshold: 50 units (configurable via INVENTORY_THRESHOLD env var).
 */

import { verifyToken } from "./_auth-verify.mjs";

const STORE = "behappybeyou1.myshopify.com";
const API_VERSION = "2026-01";
const GQL_URL = `https://${STORE}/admin/api/${API_VERSION}/graphql.json`;

const INVENTORY_QUERY = `
  query GetInventory($cursor: String) {
    products(first: 250, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          status
          productType
          variants(first: 100) {
            edges {
              node {
                id
                sku
                title
                displayName
                inventoryQuantity
                price
                inventoryItem {
                  tracked
                }
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

async function fetchAllInventory(token) {
  const allProducts = [];
  let cursor = null;

  while (true) {
    const { data, cost } = await shopifyGraphQL(token, INVENTORY_QUERY, { cursor });
    const connection = data.products;

    for (const edge of connection.edges) {
      allProducts.push(edge.node);
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

  return allProducts;
}

// Only INDIVIDUAL single-bottle variants have real, non-derived stock. Multipack
// tiers ("3 Bottles" / "6 Bottles") and Bundle products get their inventory DERIVED
// by Simple Bundles (floor(individual / pack size)), so flagging them is misleading.
function isRealSingleStock(product, v) {
  if ((product.productType || "").toLowerCase() === "bundle") return false;
  const title = (v.title || "").toLowerCase().trim();
  const sku = (v.sku || "").toUpperCase();
  const ptitle = (product.title || "").toLowerCase();
  // "3 bottles", "6 bottles", "2-pack", "12 bottles"... = a multipack tier -> skip.
  if (/(^|\s)([2-9]|\d\d)\s*(bottle|pack|pk)/.test(title)) return false;
  // non-retail helpers: upgrade/swap products, bundle parents, mixes, samples, gifts
  if (/^(UPG|BNDL|MIX|SAMPLE|TEST|GIFT|SWAP)/.test(sku)) return false;
  if (/upgrade|display only|swap/.test(ptitle)) return false;
  return true; // "Individual" / "Default Title" / "1 Bottle" = real single-bottle stock
}

function buildWarnings(products, threshold) {
  const warnings = [];
  const stockOk = [];
  let totalVariants = 0;

  for (const product of products) {
    if (product.status !== "ACTIVE") continue;

    for (const edge of product.variants.edges) {
      const v = edge.node;
      // Skip untracked variants
      if (!v.inventoryItem?.tracked) continue;
      // Only real single-bottle stock — skip multipack tiers + bundles (derived inventory)
      if (!isRealSingleStock(product, v)) continue;
      totalVariants++;

      const qty = v.inventoryQuantity ?? 0;
      const entry = {
        productTitle: product.title,
        variantId: v.id,
        sku: v.sku || "",
        variantTitle: v.title === "Default Title" ? "" : v.title,
        displayName: v.displayName,
        price: parseFloat(v.price),
        inventoryQuantity: qty,
      };

      if (qty < threshold) {
        entry.status = qty <= 0 ? "out_of_stock" : qty < 10 ? "critical" : "low";
        warnings.push(entry);
      } else {
        stockOk.push(entry);
      }
    }
  }

  warnings.sort((a, b) => a.inventoryQuantity - b.inventoryQuantity);

  return {
    threshold,
    totalActiveVariantsTracked: totalVariants,
    warningCount: warnings.length,
    outOfStockCount: warnings.filter((w) => w.status === "out_of_stock").length,
    criticalCount: warnings.filter((w) => w.status === "critical").length,
    lowCount: warnings.filter((w) => w.status === "low").length,
    warnings,
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

  const threshold = parseInt(process.env.INVENTORY_THRESHOLD || "50", 10);

  try {
    const products = await fetchAllInventory(token);
    const result = buildWarnings(products, threshold);
    return new Response(JSON.stringify(result), { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error("[shopify-inventory]", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: corsHeaders }
    );
  }
}
