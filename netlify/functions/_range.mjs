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
 * fallback for direct API calls.
 *
 * TIMEZONES — the one thing that makes Shopify and Google Ads disagree.
 * A "calendar day" is not the same instant in both systems:
 *   - Shopify buckets orders by the SHOP timezone (America/New_York).
 *   - Google Ads buckets segments.date by the ACCOUNT timezone
 *     (America/Los_Angeles). This is set at account creation and CANNOT be
 *     changed afterwards, so we cannot make Google report Eastern days.
 * They are 3 hours apart, which means an order placed 9pm-midnight Eastern
 * lands in Google Ads' PREVIOUS day. On a 1-day window that can move a whole
 * order and look like a missing conversion; on 7d+ it is a sub-2% edge effect.
 *
 * Consumers therefore resolve a date string to an explicit instant in a named
 * zone via zonedMidnightISO() rather than relying on implicit bare-date
 * behaviour. See SHOP_TIME_ZONE / ADS_TIME_ZONE below.
 */
const DAY_MS = 86400000;
const toISO = (d) => d.toISOString().split("T")[0];

export const SHOP_TIME_ZONE = "America/New_York";
export const ADS_TIME_ZONE = "America/Los_Angeles";

/** UTC offset ("-04:00") that `timeZone` is on at a given instant. */
export function tzOffsetAt(instant, timeZone) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(instant)
    .find((p) => p.type === "timeZoneName")?.value || "GMT+00:00";
  const offset = name.replace("GMT", "").trim();
  return offset === "" ? "+00:00" : offset;
}

/**
 * Midnight at the start of `dateStr` in `timeZone`, as an offset-anchored ISO string.
 *
 * Two passes: probe the offset as if the wall clock were UTC, then re-resolve at
 * the resulting instant. A single noon-probe is WRONG on DST transition days —
 * on 2026-03-08 it reports -04:00 for a midnight that is still -05:00, moving the
 * window boundary by an hour. The second pass converges on the true offset.
 */
export function zonedMidnightISO(dateStr, timeZone) {
  let offset = tzOffsetAt(new Date(`${dateStr}T00:00:00Z`), timeZone);
  offset = tzOffsetAt(new Date(`${dateStr}T00:00:00${offset}`), timeZone);
  return `${dateStr}T00:00:00${offset}`;
}

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
