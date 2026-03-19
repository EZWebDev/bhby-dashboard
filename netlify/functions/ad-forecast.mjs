/**
 * Netlify Function: ad-forecast
 *
 * Runs a blended multi-channel sales forecast for BHBY's Google Shopping +
 * Klaviyo email flow campaigns launching April 2026.
 *
 * Channels modeled:
 *   A. Google Shopping (non-branded, bottom-up CPC/CVR)
 *   B. Welcome Series (Klaviyo — new ad-driven subscribers)
 *   C. Cart Abandonment Recovery (Klaviyo)
 *   D. Win-Back Campaigns (Klaviyo — lapsed customer DB)
 *   E. Organic Abandoned Cart Recovery (Klaviyo)
 *   F. Branded Search (warm traffic — own CPC/CVR)
 *   G. Subscription Renewals (subscribe & save — cohort-based LTV)
 *
 * Returns projections for $5K/mo and $10K/mo budget scenarios, each with
 * conservative / base / aggressive estimates and Monte Carlo P10/P50/P90
 * confidence intervals.
 *
 * Inventory output shows INCREMENTAL DTC units to add to retail production
 * runs (retail/TJX channel is forecasted separately).
 */

import { verifyToken } from "./_auth-verify.mjs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json",
};

// ─── Store baseline (from analysis_orders.json + analysis_customers.json) ─────
const BASELINE = {
  // Current organic DTC performance (trailing 12 months / annualized from 60d API window)
  monthlyOrders: 79,           // avg orders/month (Feb 2025-Feb 2026: 949 orders / 12 months)
  monthlyRevenue: 3940,        // avg revenue/month ($47,279 / 12)
  aov: 49.82,                  // blended organic AOV (existing customers, returning + direct)
  unitsPerOrder: 1.7,          // blended organic units/order

  // VERIFIED PRICES (Shopify API 2026-03-18):
  //   1-bottle $19.99 + $5.99 ship = $25.98 | 3-pack $54.99 | 5-pack $89.99
  //   Bundle/CYO-3 $57.99 | CYO-5 $94.99 (planned)
  // PDP 3-offer anchoring: 1 / 3 / 5 tiers. 2-pack and 4-pack removed (92% rev was 1/3/5).
  // LIVE AT LAUNCH: Glow & Restore ($57.99), Performance Stack ($57.99),
  //   CYO 3-pack ($57.99 draft → going live). CYO 5-pack ($94.99) coming later.

  // Google Shopping AOV — pure non-branded cold traffic (product searches).
  // Non-branded (65% 1-bot $25.98, 10% 3pk $54.99, 10% bundle $57.99,
  //   5% 5pk $89.99, 5% CYO-5 $94.99, 5% other $25) = $38.69
  // Cold shoppers skew heavily to single-bottle trial.
  shoppingAov: 39.00,
  shoppingUnitsPerOrder: 1.35,

  // Branded search AOV — warm traffic, searched "behappybeyou" / "be happy be you gummies".
  // 6K+ TJX retail stores create brand familiarity → higher multi-pack/bundle rate.
  // Branded (50% 1-bot $25.98, 12% 3pk $54.99, 15% bundle $57.99,
  //   8% 5pk $89.99, 5% CYO-5 $94.99, 10% other $25) = $42.74
  brandedSearchAov: 43.00,
  brandedSearchUnitsPerOrder: 1.55,

  // Email-flow traffic (welcome series, cart recovery) — engaged visitors.
  // Klaviyo emails feature bundles with savings callouts → higher bundle attach.
  emailFlowAov: 44.00,
  emailFlowUnitsPerOrder: 1.60,

  // Win-back — lapsed customers, already purchased. Near-organic behavior.
  winbackAov: 47.00,
  winbackUnitsPerOrder: 1.70,

  // Subscription renewal AOV — subscribe & save (10% discount already baked in).
  // Blended across all channels: Shopping $35, Branded $39, Email $40, Winback $42.
  // Weighted by volume (Shopping + Branded dominate): ~$38.
  subscriptionRenewalAov: 38.00,
  subscriptionRenewalUnitsPerOrder: 1.40,
  // Blended GM% across product mix, including shipping costs/revenue.
  // Weighted by Shopping mix (65% 1-bot 43.6%, 10% 3pk 49.5%, 10% bundle 52.1%,
  //   5% 5pk 57.4%, 5% CYO-5 59.6%, 5% other ~41%) = 46.4%.
  // After Shopify payment processing (~3%): ~43%. Using 45% as product-level GM.
  blendedGmPct: 0.45,
  monthlyOrganicUnits: 134,    // 79 orders × 1.7 units/order

  // Customer data
  totalCustomers: 21307,
  returningRatePct: 0.0934,    // 9.34% returning rate
  lapsedOneTime: 5978,         // one-time buyers (addressable for win-back)
  lapsedReturning: 1991,       // returning customers who haven't bought recently

  // Abandoned carts
  abandonedCartsPerMonth: 385, // ~1,154 / 3 months
  emailRecoveryRateCurrent: 0, // 0% current recovery — all upside

  // Organic product mix (from top_products_by_revenue, % of units sold)
  organicProductMix: [
    { name: "Melatonin + B6",    handle: "melatonin",  share: 0.244 },
    { name: "Turmeric & Ginger", handle: "turmeric",   share: 0.174 },
    { name: "Biotin 10,000 MCG", handle: "biotin",     share: 0.164 },
    { name: "Calm & Stress",     handle: "calm",        share: 0.123 },
    { name: "Magnesium",         handle: "magnesium",   share: 0.060 },
    { name: "Mushroom Sea Moss", handle: "mushroom",    share: 0.044 },
    { name: "ACV Gummy",         handle: "acv",         share: 0.032 },
    { name: "Brain Support",     handle: "brain",       share: 0.032 },
    { name: "Beetroot",          handle: "beetroot",    share: 0.030 },
    { name: "Fiber Gummy",       handle: "fiber",       share: 0.025 },
    { name: "Other Products",    handle: "other",       share: 0.072 },
  ],

  // Ad-driven product mix — based on Google Shopping search volume for supplement keywords.
  // Biotin, Turmeric, ACV have massive Shopping search volume.
  // Beetroot is trending with low competition.  Melatonin has high volume but extreme competition.
  adDrivenProductMix: [
    { name: "Biotin 10,000 MCG", handle: "biotin",     share: 0.260 },
    { name: "Turmeric & Ginger", handle: "turmeric",   share: 0.200 },
    { name: "ACV Gummy",         handle: "acv",         share: 0.110 },
    { name: "Melatonin + B6",    handle: "melatonin",  share: 0.120 },
    { name: "Magnesium",         handle: "magnesium",   share: 0.090 },
    { name: "Beetroot",          handle: "beetroot",    share: 0.070 },
    { name: "Calm & Stress",     handle: "calm",        share: 0.060 },
    { name: "Mushroom Sea Moss", handle: "mushroom",    share: 0.040 },
    { name: "Brain Support",     handle: "brain",       share: 0.020 },
    { name: "Fiber Gummy",       handle: "fiber",       share: 0.015 },
    { name: "Other Products",    handle: "other",       share: 0.015 },
  ],
};

// ─── Forecast assumptions (conservative / base / aggressive) ─────────────────
const ASSUMPTIONS = {
  // Google Shopping CPC — supplement DTC benchmarks
  // Sources: WordStream Health category, Tinuiti DTC Shopping report, Common Thread Collective
  cpc: { conservative: 1.80, base: 1.20, aggressive: 0.80 },

  // Shopping CVR — industry benchmark for supplement brands
  // Sources: Shopify Plus DTC benchmarks, Tinuiti supplement vertical data
  // Applied BEFORE store uplift multiplier
  shoppingCvr: { conservative: 0.018, base: 0.025, aggressive: 0.035 },

  // Store + retail halo CVR uplift multiplier
  // Accounts for: page speed, CRO PDPs, subscription, free ship threshold, 6K+ TJX retail stores
  storeUplift: { conservative: 1.45, base: 1.575, aggressive: 1.70 },

  // ── Learning phase ramp (months 1-3 only) ────────────────────────────────
  // Google PMax / Shopping campaigns need 2-3 months to exit learning phase.
  // During learning, the algorithm serves to suboptimal audiences → lower quality clicks.
  //                Apr   May   Jun   Jul–Mar (fully ramped)
  learningRamp:   [0.55, 0.72, 0.90, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00],

  // ── Demand seasonality (independent of campaign maturity) ────────────────
  // Supplement DTC demand patterns by month.
  //                   Apr  May  Jun  Jul  Aug  Sep  Oct  Nov  Dec  Jan  Feb  Mar
  demandSeasonality: [1.00, 0.90, 0.94, 0.90, 0.82, 1.05, 1.10, 1.20, 0.92, 1.35, 1.08, 1.00],
  // Jul/Aug: summer slump. Sep-Oct: back-to-wellness. Nov: BFCM boost.
  // Dec: post-BFCM hangover. Jan: New Year resolution peak. Feb: resolution tail.

  // CPC seasonality multiplier — Q4 competition inflates CPCs.
  //               Apr  May  Jun  Jul  Aug  Sep  Oct  Nov   Dec  Jan  Feb  Mar
  cpcSeasonality: [1.0, 1.0, 1.0, 0.95, 0.90, 1.0, 1.15, 1.55, 1.40, 1.15, 1.0, 1.0],
  // Nov CPC spike: BFCM competition across all advertisers.
  // Dec: lingering holiday competition. Jan: supplement brands bidding on resolutions.

  // Email capture rate — % of ad-driven site visitors who subscribe to email
  emailCaptureRate: { conservative: 0.10, base: 0.15, aggressive: 0.20 },

  // Welcome series CVR — % of new subscribers who purchase within 30 days
  // Source: Klaviyo benchmark reports
  welcomeCvr: { conservative: 0.05, base: 0.08, aggressive: 0.12 },

  // Cart abandonment recovery rate — % of ad-driven abandoned carts recovered by Klaviyo
  // Source: Klaviyo, Omnisend industry benchmarks
  cartRecoveryRate: { conservative: 0.05, base: 0.10, aggressive: 0.15 },

  // Add-to-cart rate — % of non-converting visitors who add a product to cart.
  // Industry average for Shopping PDP traffic: 8-15%. BHBY actual: 385 carts / ~2600 sessions = 14.8%.
  // Cold Shopping skews lower, branded/warm skews higher. Blended ~12%.
  addToCartRate: { conservative: 0.08, base: 0.12, aggressive: 0.18 },

  // Of cart starters, % who abandon (Baymard Institute: 69.99%, rounded to 70%).
  // This is the standard "cart abandonment rate" — NOT applied to all visitors.
  cartAbandonPct: 0.70,

  // Win-back reactivation rate — % of lapsed customers reactivated over 12 months
  // Source: Retention.com, Klaviyo lapsed customer benchmarks
  winbackRate: { conservative: 0.02, base: 0.035, aggressive: 0.05 },

  // ── Branded search (warm traffic) ──────────────────────────────────────────
  // Bidding on "behappybeyou", "be happy be you gummies", etc.
  // Much cheaper than Shopping — few competitors bid on your brand name.
  // Historical CPC: $0.56 (2021-2022). Inflation adds ~15-20% by 2026.
  brandedCpc: { conservative: 0.90, base: 0.65, aggressive: 0.50 },

  // Branded CVR — warm traffic already knows the brand from TJX retail.
  // Historical: 8.75% on unoptimized store. CRO improvements push this higher.
  // Conservative accounts for informational brand queries that don't intend to buy.
  // NO separate uplift multiplier — branded CVR already reflects the improved store.
  brandedCvr: { conservative: 0.05, base: 0.07, aggressive: 0.10 },

  // Monthly branded search budget — finite volume (limited by brand search queries).
  // At higher total budgets, branded share decreases because volume caps out.
  brandedBudgetAllocation: {
    5000:  1750,  // $1,750/mo branded + $3,250/mo Shopping
    10000: 2500,  // $2,500/mo branded + $7,500/mo Shopping
  },

  // Branded search click volume cap — brand query volume is finite.
  // Historical: 667 clicks/mo (2021-2022). With 6K+ TJX stores, volume should grow ~2-3×.
  // Unspent branded budget auto-rolls to Shopping.
  brandedClickCap: { conservative: 1000, base: 1500, aggressive: 2200 },

  // ── Subscription (subscribe & save) ──────────────────────────────────────
  // % of new purchasers who opt into subscribe & save.
  // Source: ReCharge, Bold Commerce — supplement brands see 15-30% adoption
  // with strong subscription UX. BHBY has ReCharge integrated.
  subscriptionAdoptionRate: { conservative: 0.12, base: 0.18, aggressive: 0.25 },

  // % of subscribers who renew each cycle. 75% → avg lifetime ~4 cycles (8 months).
  subscriptionRetentionRate: 0.75,

  // Days supply per bottle = 60 days → renewal every 2 months.
  subscriptionIntervalMonths: 2,

  // Budget-dependent efficiency penalties — diminishing returns at higher spend.
  // At $10K/mo you exhaust cheap inventory and bid into more competitive auctions.
  // Applied to Shopping only — branded search has its own volume cap.
  budgetEfficiency: {
    5000:  { cpcMultiplier: 1.00, cvrMultiplier: 1.00 },
    10000: { cpcMultiplier: 1.15, cvrMultiplier: 0.90 },
  },

  // Inventory safety stock multiplier
  safetyStockMultiplier: 1.25,

  // Manufacturing lead time
  leadTimeWeeks: 2,
  recommendedOrderLeadWeeks: 3,
};

// ─── Monthly labels (April 2026 launch) ──────────────────────────────────────
// Use explicit UTC to avoid timezone drift (e.g. midnight UTC-5 → March 31).
const LAUNCH_DATE = new Date(Date.UTC(2026, 3, 1));
const MONTHS = Array.from({ length: 12 }, (_, i) => {
  const d = new Date(LAUNCH_DATE);
  d.setUTCMonth(d.getUTCMonth() + i);
  return d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
});

// ─── Monte Carlo simulation ───────────────────────────────────────────────────
function triangularSample(min, mode, max) {
  if (min >= max) return mode;
  const m = Math.max(min, Math.min(max, mode));
  const u = Math.random();
  const fc = (m - min) / (max - min);
  if (u < fc) return min + Math.sqrt(u * (max - min) * (m - min));
  return max - Math.sqrt((1 - u) * (max - min) * (max - m));
}

// A = per-request assumptions copy (never the module-level const)
function runMonteCarlo(budgetPerMonth, A, iterations = 10000) {
  const annualRevenues = [];
  const annualUnits = [];
  const eff = A.budgetEfficiency?.[budgetPerMonth] ?? { cpcMultiplier: 1, cvrMultiplier: 1 };
  const nominalBrandedBudget = A.brandedBudgetAllocation?.[budgetPerMonth] ?? 0;

  for (let i = 0; i < iterations; i++) {
    // Shopping params (cold traffic — efficiency penalties apply)
    const cpc         = triangularSample(A.cpc.aggressive, A.cpc.base, A.cpc.conservative) * eff.cpcMultiplier;
    const cvr         = triangularSample(A.shoppingCvr.conservative, A.shoppingCvr.base, A.shoppingCvr.aggressive) * eff.cvrMultiplier;
    const uplift      = triangularSample(A.storeUplift.conservative, A.storeUplift.base, A.storeUplift.aggressive);

    // Branded search params (warm traffic — no efficiency penalty, volume-capped instead)
    const bCpc        = triangularSample(A.brandedCpc.aggressive, A.brandedCpc.base, A.brandedCpc.conservative);
    const bCvr        = triangularSample(A.brandedCvr.conservative, A.brandedCvr.base, A.brandedCvr.aggressive);
    const bClickCap   = triangularSample(A.brandedClickCap.conservative, A.brandedClickCap.base, A.brandedClickCap.aggressive);

    // Email / cart / win-back
    const emailCapt   = triangularSample(A.emailCaptureRate.conservative, A.emailCaptureRate.base, A.emailCaptureRate.aggressive);
    const welcomeCvr  = triangularSample(A.welcomeCvr.conservative, A.welcomeCvr.base, A.welcomeCvr.aggressive);
    const cartRecovery= triangularSample(A.cartRecoveryRate.conservative, A.cartRecoveryRate.base, A.cartRecoveryRate.aggressive);
    const atcRate     = triangularSample(A.addToCartRate.conservative, A.addToCartRate.base, A.addToCartRate.aggressive);
    const winback     = triangularSample(A.winbackRate.conservative, A.winbackRate.base, A.winbackRate.aggressive);

    // Subscription
    const subAdopt    = triangularSample(A.subscriptionAdoptionRate.conservative, A.subscriptionAdoptionRate.base, A.subscriptionAdoptionRate.aggressive);

    let totalRev = 0;
    let totalUnits = 0;
    const monthlySubs = [];

    for (let m = 0; m < 12; m++) {
      const ramp        = A.learningRamp[m] * A.demandSeasonality[m];
      const cpcSeason   = A.cpcSeasonality?.[m] ?? 1.0;

      // Channel F: Branded Search — cap clicks by query volume, roll unspent to Shopping
      const brandedSeasonalCpc  = bCpc * cpcSeason;
      const rawBrandedClicks    = nominalBrandedBudget / brandedSeasonalCpc;
      const brandedClicks       = Math.min(rawBrandedClicks, bClickCap);
      const actualBrandedSpend  = brandedClicks * brandedSeasonalCpc;
      const brandedConversions  = brandedClicks * bCvr * ramp;
      const brandedRev          = brandedConversions * BASELINE.brandedSearchAov;

      // Channel A: Google Shopping — gets base budget + any unspent branded
      const effectiveShoppingBudget = (budgetPerMonth - nominalBrandedBudget) + (nominalBrandedBudget - actualBrandedSpend);
      const seasonalCpc         = cpc * cpcSeason;
      const shoppingClicks      = effectiveShoppingBudget / seasonalCpc;
      const effectiveCvr        = cvr * uplift;
      const shoppingConversions = shoppingClicks * effectiveCvr * ramp;
      const shoppingRev         = shoppingConversions * BASELINE.shoppingAov;

      // Non-converters from both channels feed into email/cart funnels
      const shoppingNonConvert  = shoppingClicks * Math.max(0, 1 - effectiveCvr) * ramp;
      const brandedNonConvert   = brandedClicks  * Math.max(0, 1 - bCvr) * ramp;
      const totalNonConvert     = shoppingNonConvert + brandedNonConvert;

      // Channel B: Welcome series — deduct overlap with cart flow (Klaviyo suppresses welcome
      // for contacts who also have an active cart abandonment flow)
      const newEmailSubs       = totalNonConvert * emailCapt * (1 - atcRate);
      const welcomeConversions = newEmailSubs * welcomeCvr;
      const welcomeRev         = welcomeConversions * BASELINE.emailFlowAov;

      // Channel C: Ad-driven cart abandonment recovery
      // Funnel: non-converters → add to cart (atcRate) → abandon (70% Baymard) → recover
      const adAbandonedCarts   = totalNonConvert * atcRate * A.cartAbandonPct;
      const cartConversions    = adAbandonedCarts * cartRecovery;
      const cartRev            = cartConversions * BASELINE.emailFlowAov;

      // Channel D: Win-back (lapsed customers)
      const addressableLapsed  = BASELINE.lapsedOneTime + BASELINE.lapsedReturning;
      const winbackConversions = m === 0 ? addressableLapsed * winback * 0.6
        : m < 3 ? addressableLapsed * winback * 0.2 / 2
        : addressableLapsed * winback * 0.2 / 9;
      const winbackRev = winbackConversions * BASELINE.winbackAov;

      // Channel E: Organic abandoned cart recovery
      // Small ramp for Klaviyo flow optimization: 70% month 1, 90% month 2, 100% month 3+
      const organicFlowRamp          = m === 0 ? 0.70 : m === 1 ? 0.90 : 1.0;
      const organicCartConversions   = BASELINE.abandonedCartsPerMonth * cartRecovery * organicFlowRamp;
      const organicCartRev           = organicCartConversions * BASELINE.emailFlowAov;

      // Channel G: Subscription renewals from past cohorts
      const monthConversions = shoppingConversions + brandedConversions + welcomeConversions
                             + cartConversions + winbackConversions + organicCartConversions;
      monthlySubs.push(monthConversions * subAdopt);

      let subRenewalRev = 0, subRenewalUnits = 0;
      for (let c = 0; c < m; c++) {
        const gap = m - c;
        if (gap > 0 && gap % A.subscriptionIntervalMonths === 0) {
          const cycle     = gap / A.subscriptionIntervalMonths;
          const surviving = monthlySubs[c] * Math.pow(A.subscriptionRetentionRate, cycle);
          subRenewalRev   += surviving * BASELINE.subscriptionRenewalAov;
          subRenewalUnits += surviving * BASELINE.subscriptionRenewalUnitsPerOrder;
        }
      }

      totalRev   += shoppingRev + brandedRev + welcomeRev + cartRev + winbackRev + organicCartRev + subRenewalRev;
      totalUnits += shoppingConversions * BASELINE.shoppingUnitsPerOrder
                  + brandedConversions  * BASELINE.brandedSearchUnitsPerOrder
                  + welcomeConversions  * BASELINE.emailFlowUnitsPerOrder
                  + cartConversions     * BASELINE.emailFlowUnitsPerOrder
                  + winbackConversions  * BASELINE.winbackUnitsPerOrder
                  + organicCartConversions * BASELINE.emailFlowUnitsPerOrder
                  + subRenewalUnits;
    }

    annualRevenues.push(totalRev);
    annualUnits.push(totalUnits);
  }

  annualRevenues.sort((a, b) => a - b);
  annualUnits.sort((a, b) => a - b);

  const p = (arr, pct) => arr[Math.floor(arr.length * pct)];

  return {
    revenue: {
      p10: Math.round(p(annualRevenues, 0.10)),
      p50: Math.round(p(annualRevenues, 0.50)),
      p90: Math.round(p(annualRevenues, 0.90)),
    },
    units: {
      p10: Math.round(p(annualUnits, 0.10)),
      p50: Math.round(p(annualUnits, 0.50)),
      p90: Math.round(p(annualUnits, 0.90)),
    },
  };
}

// ─── Deterministic forecast for a given scenario tier ────────────────────────
// A = per-request assumptions copy
function forecastScenario(budgetPerMonth, tier, A) {
  const eff          = A.budgetEfficiency?.[budgetPerMonth] ?? { cpcMultiplier: 1, cvrMultiplier: 1 };
  const cpc          = A.cpc[tier] * eff.cpcMultiplier;
  const cvr          = A.shoppingCvr[tier] * eff.cvrMultiplier;
  const uplift       = A.storeUplift[tier];
  const bCpc         = A.brandedCpc[tier];
  const bCvr         = A.brandedCvr[tier];
  const bClickCap    = A.brandedClickCap[tier];
  const emailCapture = A.emailCaptureRate[tier];
  const welcomeCvr   = A.welcomeCvr[tier];
  const cartRecovery = A.cartRecoveryRate[tier];
  const atcRate      = A.addToCartRate[tier];
  const winbackRt    = A.winbackRate[tier];
  const subAdopt     = A.subscriptionAdoptionRate[tier];

  const nominalBrandedBudget = A.brandedBudgetAllocation?.[budgetPerMonth] ?? 0;
  const addressableLapsed = BASELINE.lapsedOneTime + BASELINE.lapsedReturning;
  const monthly = [];
  const monthlySubs = [];

  for (let m = 0; m < 12; m++) {
    const ramp      = A.learningRamp[m] * A.demandSeasonality[m];
    const cpcSeason = A.cpcSeasonality?.[m] ?? 1.0;

    // Channel F: Branded Search — cap clicks by query volume, roll unspent to Shopping
    const brandedSeasonalCpc  = bCpc * cpcSeason;
    const rawBrandedClicks    = nominalBrandedBudget / brandedSeasonalCpc;
    const brandedClicks       = Math.min(rawBrandedClicks, bClickCap);
    const actualBrandedSpend  = brandedClicks * brandedSeasonalCpc;
    const brandedConversions  = brandedClicks * bCvr * ramp;
    const brandedOrders       = Math.round(brandedConversions);
    const brandedRev          = brandedConversions * BASELINE.brandedSearchAov;
    const brandedUnits        = brandedConversions * BASELINE.brandedSearchUnitsPerOrder;

    // Channel A: Google Shopping — gets base budget + any unspent branded
    const effectiveShoppingBudget = (budgetPerMonth - nominalBrandedBudget) + (nominalBrandedBudget - actualBrandedSpend);
    const seasonalCpc         = cpc * cpcSeason;
    const shoppingClicks      = effectiveShoppingBudget / seasonalCpc;
    const effectiveCvr        = cvr * uplift;
    const shoppingConversions = shoppingClicks * effectiveCvr * ramp;
    const shoppingOrders      = Math.round(shoppingConversions);
    const shoppingRev         = shoppingConversions * BASELINE.shoppingAov;
    const shoppingUnits       = shoppingConversions * BASELINE.shoppingUnitsPerOrder;

    // Non-converters from both channels feed email/cart funnels
    const shoppingNonConvert  = shoppingClicks * Math.max(0, 1 - effectiveCvr) * ramp;
    const brandedNonConvert   = brandedClicks  * Math.max(0, 1 - bCvr) * ramp;
    const totalNonConvert     = shoppingNonConvert + brandedNonConvert;

    // Channel B: Welcome series — deduct overlap with cart flow
    const newEmailSubs       = totalNonConvert * emailCapture * (1 - atcRate);
    const welcomeConversions = newEmailSubs * welcomeCvr;
    const welcomeOrders      = Math.round(welcomeConversions);
    const welcomeRev         = welcomeConversions * BASELINE.emailFlowAov;
    const welcomeUnits       = welcomeConversions * BASELINE.emailFlowUnitsPerOrder;

    // Channel C: Ad-driven cart abandonment recovery
    // Funnel: non-converters → add to cart (atcRate) → abandon (70% Baymard) → recover
    const adAbandonedCarts = totalNonConvert * atcRate * A.cartAbandonPct;
    const cartConversions  = adAbandonedCarts * cartRecovery;
    const cartOrders       = Math.round(cartConversions);
    const cartRev          = cartConversions * BASELINE.emailFlowAov;
    const cartUnits        = cartConversions * BASELINE.emailFlowUnitsPerOrder;

    // Channel D: Win-back (lapsed customers)
    const winbackConversions = m === 0 ? addressableLapsed * winbackRt * 0.6
      : m < 3 ? addressableLapsed * winbackRt * 0.2 / 2
      : addressableLapsed * winbackRt * 0.2 / 9;
    const winbackOrders = Math.round(winbackConversions);
    const winbackRev    = winbackConversions * BASELINE.winbackAov;
    const winbackUnits  = winbackConversions * BASELINE.winbackUnitsPerOrder;

    // Channel E: Organic abandoned cart recovery
    const organicFlowRamp          = m === 0 ? 0.70 : m === 1 ? 0.90 : 1.0;
    const organicCartConversions   = BASELINE.abandonedCartsPerMonth * cartRecovery * organicFlowRamp;
    const organicCartOrders        = Math.round(organicCartConversions);
    const organicCartRev           = organicCartConversions * BASELINE.emailFlowAov;
    const organicCartUnits         = organicCartConversions * BASELINE.emailFlowUnitsPerOrder;

    // Channel G: Subscription renewals from past cohorts
    const monthConversions = shoppingConversions + brandedConversions + welcomeConversions
                           + cartConversions + winbackConversions + organicCartConversions;
    monthlySubs.push(monthConversions * subAdopt);

    let subRenewalRev = 0, subRenewalUnits = 0, subRenewalOrders = 0;
    for (let c = 0; c < m; c++) {
      const gap = m - c;
      if (gap > 0 && gap % A.subscriptionIntervalMonths === 0) {
        const cycle     = gap / A.subscriptionIntervalMonths;
        const surviving = monthlySubs[c] * Math.pow(A.subscriptionRetentionRate, cycle);
        subRenewalRev   += surviving * BASELINE.subscriptionRenewalAov;
        subRenewalUnits += surviving * BASELINE.subscriptionRenewalUnitsPerOrder;
        subRenewalOrders += surviving;
      }
    }

    const totalConversions = shoppingConversions + brandedConversions + welcomeConversions
                           + cartConversions + winbackConversions + organicCartConversions + subRenewalOrders;
    const totalOrders = Math.round(totalConversions);
    const totalRev = shoppingRev + brandedRev + welcomeRev + cartRev + winbackRev + organicCartRev + subRenewalRev;
    const totalUn  = Math.round(shoppingUnits + brandedUnits + welcomeUnits + cartUnits
                              + winbackUnits + organicCartUnits + subRenewalUnits);
    const gp   = totalRev * BASELINE.blendedGmPct;
    const roas = budgetPerMonth > 0 ? totalRev / budgetPerMonth : 0;

    monthly.push({
      monthIndex: m + 1,
      monthLabel: MONTHS[m],
      rampFactor: ramp,
      totalOrders,
      totalRevenue: Math.round(totalRev),
      totalUnits: totalUn,
      grossProfit: Math.round(gp),
      roas: Math.round(roas * 100) / 100,
      byChannel: {
        shopping:         { orders: shoppingOrders,            revenue: Math.round(shoppingRev),       units: Math.round(shoppingUnits) },
        brandedSearch:    { orders: brandedOrders,             revenue: Math.round(brandedRev),        units: Math.round(brandedUnits) },
        welcomeSeries:    { orders: welcomeOrders,             revenue: Math.round(welcomeRev),        units: Math.round(welcomeUnits) },
        cartRecovery:     { orders: cartOrders,                revenue: Math.round(cartRev),           units: Math.round(cartUnits) },
        winback:          { orders: winbackOrders,             revenue: Math.round(winbackRev),        units: Math.round(winbackUnits) },
        organicCartRecov: { orders: organicCartOrders,         revenue: Math.round(organicCartRev),    units: Math.round(organicCartUnits) },
        subscriptionRenewals: { orders: Math.round(subRenewalOrders), revenue: Math.round(subRenewalRev), units: Math.round(subRenewalUnits) },
      },
    });
  }

  // Steady state = average of months 4-12 (post-ramp)
  const steadyStateMonths  = monthly.slice(3);
  const steadyStateRevenue = Math.round(steadyStateMonths.reduce((s, m) => s + m.totalRevenue, 0) / steadyStateMonths.length);
  const steadyStateOrders  = Math.round(steadyStateMonths.reduce((s, m) => s + m.totalOrders, 0)  / steadyStateMonths.length);
  const steadyStateUnits   = Math.round(steadyStateMonths.reduce((s, m) => s + m.totalUnits, 0)   / steadyStateMonths.length);
  const steadyStateRoas    = Math.round(steadyStateMonths.reduce((s, m) => s + m.roas, 0)         / steadyStateMonths.length * 100) / 100;

  const annualTotals = {
    revenue: monthly.reduce((s, m) => s + m.totalRevenue, 0),
    orders:  monthly.reduce((s, m) => s + m.totalOrders, 0),
    units:   monthly.reduce((s, m) => s + m.totalUnits, 0),
    gp:      monthly.reduce((s, m) => s + m.grossProfit, 0),
    adSpend: budgetPerMonth * 12,
    roas:    Math.round((monthly.reduce((s, m) => s + m.totalRevenue, 0) / (budgetPerMonth * 12)) * 100) / 100,
  };

  return { monthly, steadyState: { revenue: steadyStateRevenue, orders: steadyStateOrders, units: steadyStateUnits, roas: steadyStateRoas }, annualTotals };
}

// ─── Inventory forecast ───────────────────────────────────────────────────────
// Uses organic mix for organic units, ad-driven mix for ad units, then merges per product.
function buildInventoryForecast(baseMonthly, A) {
  // Build a lookup: handle → ad share
  const adMixByHandle = {};
  for (const p of BASELINE.adDrivenProductMix) adMixByHandle[p.handle] = p.share;

  return BASELINE.organicProductMix.map(product => {
    const adShare = adMixByHandle[product.handle] ?? 0;

    const monthlyBreakdown = MONTHS.map((label, i) => {
      const organicUnits  = Math.round(BASELINE.monthlyOrganicUnits * product.share);
      const adUnits       = Math.round(baseMonthly[i].totalUnits * adShare);
      const totalDtcUnits = organicUnits + adUnits;
      const safetyStock   = Math.round(totalDtcUnits * A.safetyStockMultiplier);
      return {
        monthLabel: label,
        organicUnits,
        adDrivenUnits: adUnits,
        totalDtcUnits,
        safetyStock,
        addToProductionRun: safetyStock,
      };
    });

    const peakMonth = monthlyBreakdown.reduce((max, m) => m.addToProductionRun > max.addToProductionRun ? m : max);
    const avgMonthlyDtcUnits = Math.round(monthlyBreakdown.reduce((s, m) => s + m.totalDtcUnits, 0) / 12);

    return {
      ...product,
      adShare,
      monthlyBreakdown,
      peakMonth: peakMonth.monthLabel,
      peakUnits: peakMonth.addToProductionRun,
      avgMonthlyDtcUnits,
      annualDtcUnits: monthlyBreakdown.reduce((s, m) => s + m.totalDtcUnits, 0),
    };
  });
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    const authError = verifyToken(req);
    if (authError) return authError;
    // Allow overriding assumptions via query params (for interactive sliders).
    // IMPORTANT: we build a per-request deep copy of ASSUMPTIONS so that module-level
    // state is never mutated — Netlify reuses warm function instances across requests.
    const url = new URL(req.url);
    const overrides = {
      cpcBase:      parseFloat(url.searchParams.get("cpcBase"))      || null,
      cvrBase:      parseFloat(url.searchParams.get("cvrBase"))      || null,
      emailCapture: parseFloat(url.searchParams.get("emailCapture")) || null,
      cartRecovery: parseFloat(url.searchParams.get("cartRecovery")) || null,
      winbackRate:  parseFloat(url.searchParams.get("winbackRate"))  || null,
      subAdoption:  parseFloat(url.searchParams.get("subAdoption"))  || null,
      safetyStock:  parseFloat(url.searchParams.get("safetyStock"))  || null,
    };

    // Deep-copy mutable assumption tiers so concurrent requests don't bleed into each other.
    const A = {
      cpc:              { ...ASSUMPTIONS.cpc },
      shoppingCvr:      { ...ASSUMPTIONS.shoppingCvr },
      storeUplift:      { ...ASSUMPTIONS.storeUplift },
      brandedCpc:       { ...ASSUMPTIONS.brandedCpc },
      brandedCvr:       { ...ASSUMPTIONS.brandedCvr },
      brandedBudgetAllocation: ASSUMPTIONS.brandedBudgetAllocation,  // read-only
      brandedClickCap:  { ...ASSUMPTIONS.brandedClickCap },
      emailCaptureRate: { ...ASSUMPTIONS.emailCaptureRate },
      welcomeCvr:       { ...ASSUMPTIONS.welcomeCvr },
      cartRecoveryRate: { ...ASSUMPTIONS.cartRecoveryRate },
      addToCartRate:    { ...ASSUMPTIONS.addToCartRate },
      cartAbandonPct:   ASSUMPTIONS.cartAbandonPct,
      winbackRate:      { ...ASSUMPTIONS.winbackRate },
      subscriptionAdoptionRate: { ...ASSUMPTIONS.subscriptionAdoptionRate },
      subscriptionRetentionRate: ASSUMPTIONS.subscriptionRetentionRate,
      subscriptionIntervalMonths: ASSUMPTIONS.subscriptionIntervalMonths,
      learningRamp:      ASSUMPTIONS.learningRamp,       // read-only, safe to share
      demandSeasonality: ASSUMPTIONS.demandSeasonality,  // read-only, safe to share
      cpcSeasonality:    ASSUMPTIONS.cpcSeasonality,     // read-only, safe to share
      budgetEfficiency:  ASSUMPTIONS.budgetEfficiency,    // read-only, safe to share
      safetyStockMultiplier:        ASSUMPTIONS.safetyStockMultiplier,
      leadTimeWeeks:                ASSUMPTIONS.leadTimeWeeks,
      recommendedOrderLeadWeeks:    ASSUMPTIONS.recommendedOrderLeadWeeks,
    };

    // Apply overrides to the per-request copy only.
    if (overrides.cpcBase) {
      const delta = overrides.cpcBase - A.cpc.base;
      A.cpc.conservative += delta;
      A.cpc.base = overrides.cpcBase;
      A.cpc.aggressive = Math.max(0.40, A.cpc.aggressive + delta);
    }
    if (overrides.cvrBase) {
      A.shoppingCvr.base = overrides.cvrBase / 100;
      A.shoppingCvr.conservative = Math.max(0.005, overrides.cvrBase / 100 * 0.72);
      A.shoppingCvr.aggressive   = Math.min(0.08,  overrides.cvrBase / 100 * 1.40);
    }
    if (overrides.emailCapture) {
      const ratio = (overrides.emailCapture / 100) / ASSUMPTIONS.emailCaptureRate.base;
      A.emailCaptureRate.conservative = Math.max(0.01, ASSUMPTIONS.emailCaptureRate.conservative * ratio);
      A.emailCaptureRate.base         = overrides.emailCapture / 100;
      A.emailCaptureRate.aggressive   = Math.min(0.50, ASSUMPTIONS.emailCaptureRate.aggressive * ratio);
    }
    if (overrides.cartRecovery) {
      const ratio = (overrides.cartRecovery / 100) / ASSUMPTIONS.cartRecoveryRate.base;
      A.cartRecoveryRate.conservative = Math.max(0.005, ASSUMPTIONS.cartRecoveryRate.conservative * ratio);
      A.cartRecoveryRate.base         = overrides.cartRecovery / 100;
      A.cartRecoveryRate.aggressive   = Math.min(0.40, ASSUMPTIONS.cartRecoveryRate.aggressive * ratio);
    }
    if (overrides.winbackRate) {
      const ratio = (overrides.winbackRate / 100) / ASSUMPTIONS.winbackRate.base;
      A.winbackRate.conservative = Math.max(0.002, ASSUMPTIONS.winbackRate.conservative * ratio);
      A.winbackRate.base         = overrides.winbackRate / 100;
      A.winbackRate.aggressive   = Math.min(0.15, ASSUMPTIONS.winbackRate.aggressive * ratio);
    }
    if (overrides.subAdoption) {
      const ratio = (overrides.subAdoption / 100) / ASSUMPTIONS.subscriptionAdoptionRate.base;
      A.subscriptionAdoptionRate.conservative = Math.max(0.02, ASSUMPTIONS.subscriptionAdoptionRate.conservative * ratio);
      A.subscriptionAdoptionRate.base         = overrides.subAdoption / 100;
      A.subscriptionAdoptionRate.aggressive   = Math.min(0.50, ASSUMPTIONS.subscriptionAdoptionRate.aggressive * ratio);
    }
    if (overrides.safetyStock)  A.safetyStockMultiplier = overrides.safetyStock;

    // Run deterministic scenarios for both budgets
    const budgets = { "5k": 5000, "10k": 10000 };
    const scenarios = {};

    for (const [key, budget] of Object.entries(budgets)) {
      const conservative = forecastScenario(budget, "conservative", A);
      const base         = forecastScenario(budget, "base",         A);
      const aggressive   = forecastScenario(budget, "aggressive",   A);
      const monteCarlo   = runMonteCarlo(budget, A, 10000);

      // Inventory based on base scenario
      const inventory = buildInventoryForecast(base.monthly, A);

      scenarios[key] = {
        budgetPerMonth: budget,
        conservative,
        base,
        aggressive,
        monteCarlo,
        inventory,
        // Convenience: combined monthly arrays for charting (conservative/base/aggressive revenue)
        chartData: {
          months: MONTHS,
          revenue: {
            conservative: conservative.monthly.map(m => m.totalRevenue),
            base:         base.monthly.map(m => m.totalRevenue),
            aggressive:   aggressive.monthly.map(m => m.totalRevenue),
          },
          channelBreakdown: base.monthly.map(m => ({
            month: m.monthLabel,
            shopping:             m.byChannel.shopping.revenue,
            brandedSearch:        m.byChannel.brandedSearch.revenue,
            welcomeSeries:        m.byChannel.welcomeSeries.revenue,
            cartRecovery:         m.byChannel.cartRecovery.revenue,
            winback:              m.byChannel.winback.revenue,
            organicCartRecov:     m.byChannel.organicCartRecov.revenue,
            subscriptionRenewals: m.byChannel.subscriptionRenewals.revenue,
          })),
        },
      };
    }

    const result = {
      generatedAt: new Date().toISOString(),
      launchDate: "2026-04-01",
      forecastHorizon: "Apr 2026 – Mar 2027 (12 months)",
      baseline: {
        monthlyOrders: BASELINE.monthlyOrders,
        monthlyRevenue: BASELINE.monthlyRevenue,
        aov: BASELINE.aov,
        unitsPerOrder: BASELINE.unitsPerOrder,
        blendedGmPct: BASELINE.blendedGmPct,
        monthlyOrganicUnits: BASELINE.monthlyOrganicUnits,
        lapsedCustomers: BASELINE.lapsedOneTime + BASELINE.lapsedReturning,
        abandonedCartsPerMonth: BASELINE.abandonedCartsPerMonth,
        dataSource: "Shopify Admin API — 949 paid orders, Feb 2025–Feb 2026",
      },
      assumptions: {
        cpc: A.cpc,
        shoppingCvr: A.shoppingCvr,
        storeUplift: A.storeUplift,
        brandedCpc: A.brandedCpc,
        brandedCvr: A.brandedCvr,
        brandedBudgetAllocation: A.brandedBudgetAllocation,
        brandedClickCap: A.brandedClickCap,
        emailCaptureRate: A.emailCaptureRate,
        welcomeCvr: A.welcomeCvr,
        cartRecoveryRate: A.cartRecoveryRate,
        addToCartRate: A.addToCartRate,
        cartAbandonPct: A.cartAbandonPct,
        winbackRate: A.winbackRate,
        subscriptionAdoptionRate: A.subscriptionAdoptionRate,
        subscriptionRetentionRate: A.subscriptionRetentionRate,
        subscriptionIntervalMonths: A.subscriptionIntervalMonths,
        safetyStockMultiplier: A.safetyStockMultiplier,
        leadTimeWeeks: A.leadTimeWeeks,
        recommendedOrderLeadWeeks: A.recommendedOrderLeadWeeks,
      },
      scenarios,
      methodology: {
        model: "Blended 7-Channel with Monte Carlo Simulation",
        channels: "A: Google Shopping, B: Welcome Series, C: Cart Recovery, D: Win-Back, E: Organic Cart Recovery, F: Branded Search, G: Subscription Renewals",
        monteCarlo: {
          iterations: 10000,
          distributionType: "Triangular (min=conservative, mode=base, max=aggressive)",
          outputs: "P10 (pessimistic), P50 (most likely), P90 (optimistic) annual revenue and units",
        },
        historicalData: {
          source: "Client-provided screenshot + CSV export (API pending production approval)",
          totalSpend: 6712.42,
          totalClicks: 12000,
          totalImpressions: 234388,
          totalConversions: 1050,
          campaignType: "BRANDED_SEARCH — modeled as separate channel (F) with own CPC/CVR",
        },
        brandedSearchNote: "Branded search is modeled as a separate channel with its own CPC ($0.50-$0.90) and CVR (5-10%) based on historical performance on the unoptimized store ($0.56 CPC, 8.75% CVR in 2021-2022) adjusted for 2026. Click volume is capped at 1,000-2,200 clicks/month (historical 667/mo × 1.5-3.3× for retail expansion). Unspent branded budget auto-rolls to Shopping.",
        cartRecoveryNote: "Cart recovery uses a 3-step funnel: (1) non-converters → add to cart (8-18%, base 12%), (2) cart starters → abandon (70% Baymard standard), (3) abandoners → email recovery (5-15%). Welcome series deducts the cart overlap since Klaviyo suppresses welcome emails for contacts in the cart abandonment flow.",
        gmNote: "Blended gross margin of 45% is product-level GM after COGS and shipping costs, weighted by the ad-driven product mix. Before payment processing fees (~3%). Verified against pricing spreadsheet (individual SKU GM% ranges from 43.6% for 1-bottle to 59.6% for CYO-5).",
        subscriptionNote: "Subscription renewals are modeled using cohort-based LTV: each month's new subscribers (18% adoption rate) generate renewals every 2 months with 75% retention per cycle (avg lifetime ~8 months). Only renewals within the 12-month forecast horizon are counted.",
        storeImprovementsNote: "CVR uplifts are cumulative since 2022 campaigns. Store is now CRO-optimized on Botanical OS 2.0 with subscription, lower free ship threshold, and better PDPs.",
        retailHaloNote: "6,000+ TJX retail stores (TJ Maxx, Marshalls, HomeGoods, Sierra) create brand recognition that increases online CVR for shoppers who've seen the product in-store.",
        moqNote: "Manufacturer MOQ is 6,000 units per SKU. Incremental DTC units should be added to retail production runs — if combined DTC + retail demand exceeds 6K, no separate MOQ run is required.",
      },
    };

    return new Response(JSON.stringify(result), { status: 200, headers: CORS });
  } catch (err) {
    console.error("[ad-forecast]", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}
