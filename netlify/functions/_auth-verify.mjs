/**
 * Shared auth verification helper for Netlify Functions.
 * Import and call verifyToken(req) at the top of any protected function.
 *
 * Returns null if the token is valid.
 * Returns a Response (401) if the token is missing or invalid — return it immediately.
 */

import { createHmac, timingSafeEqual } from "crypto";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json",
};

export function verifyToken(req) {
  const secret = process.env.DASHBOARD_PASSWORD;

  // If no password is configured, allow all requests (dev / unconfigured)
  if (!secret) return null;

  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return new Response(JSON.stringify({ error: "Unauthorized: missing token" }), {
      status: 401, headers: CORS,
    });
  }

  // Must match auth.mjs: HMAC-SHA256(key=secret, data=secret)
  const expected = createHmac("sha256", secret).update(secret).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(token, "hex");

  const valid =
    providedBuf.length === expectedBuf.length &&
    timingSafeEqual(providedBuf, expectedBuf);

  if (!valid) {
    return new Response(JSON.stringify({ error: "Unauthorized: invalid token" }), {
      status: 401, headers: CORS,
    });
  }

  return null;
}
