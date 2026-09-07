/**
 * BHBY on-site CRO survey endpoint (2026-09-06).
 *
 * POST  (from the storefront widget, snippets/bhby-survey.liquid + assets/bhby-survey.js)
 *       Origin-allowlisted, schema-checked, one JSON blob per response in the
 *       "cro-survey" Netlify Blobs store. No email, no IP, no auth (public widget).
 * GET   ?since=YYYY-MM-DD   (dashboard / cro_funnel_pull.py)  Bearer token via _auth-verify.
 *
 * Deploy notes: dashboard/netlify/CRO_SURVEY_DEPLOY_NOTES.md
 */
import { getStore } from "@netlify/blobs";
import { verifyToken } from "./_auth-verify.mjs";

const ALLOWED_ORIGINS = new Set([
  "https://behappybeyou.net",
  "https://www.behappybeyou.net",
  "https://behappybeyou1.myshopify.com",
]);
const REASONS = new Set(["price", "shipping_cost", "not_sure_works", "wanted_more_info", "just_looking", "something_else"]);
const STR_KEYS = [
  "page_path", "template", "template_suffix", "product_handle", "variant_id", "pack_bottles",
  "purchase_mode", "device", "viewport", "ab_variant", "bhby_sid", "referrer", "trigger",
  "clarity_session_id", "clarity_click_id", "cart_token",
  "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
];
const NUM_KEYS = ["cart_item_count", "cart_subtotal_cents"];
const MAX_BODY = 8 * 1024;

function cors(origin) {
  const h = { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin" };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}
const json = (status, body, headers) => new Response(JSON.stringify(body), { status, headers });

function clean(raw) {
  const out = {};
  const score = Number(raw.score);
  if (!Number.isInteger(score) || score < 1 || score > 5) return null;
  out.score = score;
  out.reason_code = REASONS.has(raw.reason_code) ? raw.reason_code : null;
  out.free_text = typeof raw.free_text === "string" ? raw.free_text.trim().slice(0, 300) : null;
  for (const k of STR_KEYS) out[k] = typeof raw[k] === "string" ? raw[k].slice(0, 300) : null;
  for (const k of NUM_KEYS) out[k] = Number.isFinite(Number(raw[k])) && raw[k] !== null ? Number(raw[k]) : null;
  const ts = Date.parse(raw.ts);
  out.client_ts = Number.isFinite(ts) ? new Date(ts).toISOString() : null;
  out.received_ts = new Date().toISOString();
  return out;
}

export default async (req) => {
  const origin = req.headers.get("origin") || "";
  const headers = cors(origin);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

  if (req.method === "POST") {
    if (!ALLOWED_ORIGINS.has(origin)) return json(403, { error: "origin not allowed" }, headers);
    const len = Number(req.headers.get("content-length") || 0);
    if (len > MAX_BODY) return json(413, { error: "too large" }, headers);
    let raw;
    try {
      const text = await req.text();
      if (text.length > MAX_BODY) return json(413, { error: "too large" }, headers);
      raw = JSON.parse(text);
    } catch {
      return json(400, { error: "bad json" }, headers);
    }
    const row = clean(raw || {});
    if (!row) return json(400, { error: "score must be 1-5" }, headers);
    const day = row.received_ts.slice(0, 10);
    const key = `${day}/${row.received_ts.replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}.json`;
    try {
      await getStore("cro-survey").setJSON(key, row);
    } catch (e) {
      return json(500, { error: "store failed", detail: String(e).slice(0, 200) }, headers);
    }
    return json(202, { ok: true }, headers);
  }

  if (req.method === "GET") {
    const denied = verifyToken(req);
    if (denied) return denied;
    const url = new URL(req.url);
    const since = (url.searchParams.get("since") || "").slice(0, 10);
    const limit = Math.min(Number(url.searchParams.get("limit") || 2000), 5000);
    const store = getStore("cro-survey");
    const { blobs } = await store.list();
    const keys = blobs.map((b) => b.key).filter((k) => !since || k.slice(0, 10) >= since).sort().slice(-limit);
    const rows = await Promise.all(keys.map((k) => store.get(k, { type: "json" })));
    return json(200, { count: rows.length, since: since || null, rows }, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  }

  return json(405, { error: "method not allowed" }, headers);
};

export const config = { path: "/.netlify/functions/cro-survey" };
