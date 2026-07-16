/**
 * Shared date-range parsing for the date-windowed dashboard functions
 * (shopify-orders, shopify-abandoned, google-ads).
 *
 * Query params (all optional):
 *   start, end         — YYYY-MM-DD inclusive window. Default: rolling last 30 days.
 *   prevStart, prevEnd — YYYY-MM-DD previous window for comparison.
 *   compare=0          — disable the previous-period comparison.
 *
 * The frontend normally sends explicit start/end (computed in the user's local
 * timezone) plus prevStart/prevEnd, so the server-side defaults below are only a
 * fallback for direct API calls. All dates are treated as calendar days (UTC).
 */
const DAY_MS = 86400000;
const toISO = (d) => d.toISOString().split("T")[0];

export function parseRange(req) {
  let params;
  try {
    params = new URL(req.url).searchParams;
  } catch {
    params = new URLSearchParams();
  }

  let start = params.get("start");
  let end = params.get("end");

  // Fallback default: rolling last 30 days ending today.
  if (!start || !end) {
    const e = new Date();
    const s = new Date(e.getTime() - 29 * DAY_MS);
    start = start || toISO(s);
    end = end || toISO(e);
  }

  const sD = new Date(start + "T00:00:00Z");
  const eD = new Date(end + "T00:00:00Z");
  const days = Math.max(1, Math.round((eD - sD) / DAY_MS) + 1);
  // Shopify created_at:<X and GAQL both want the day AFTER the last day for an
  // inclusive end, so expose an exclusive upper bound too.
  const endExclusive = toISO(new Date(eD.getTime() + DAY_MS));

  let prev = null;
  if (params.get("compare") !== "0") {
    let ps = params.get("prevStart");
    let pe = params.get("prevEnd");
    if (!ps || !pe) {
      // Immediately-preceding, equal-length window.
      const peD = new Date(sD.getTime() - DAY_MS);
      const psD = new Date(peD.getTime() - (days - 1) * DAY_MS);
      ps = toISO(psD);
      pe = toISO(peD);
    }
    const peD = new Date(pe + "T00:00:00Z");
    prev = { start: ps, end: pe, endExclusive: toISO(new Date(peD.getTime() + DAY_MS)) };
  }

  return { start, end, endExclusive, days, prev };
}
