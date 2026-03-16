/**
 * Netlify Function: auth
 * Validates a dashboard password and returns a stateless HMAC token.
 *
 * POST /.netlify/functions/auth
 * Body: { "password": "..." }
 *
 * Returns: { "token": "<hex>" }   on success (200)
 *          { "error": "..." }     on failure (401 / 400 / 500)
 *
 * The token is HMAC-SHA256(password, DASHBOARD_PASSWORD) — deterministic and
 * stateless. All other functions verify incoming tokens by recomputing the HMAC
 * and comparing. Changing DASHBOARD_PASSWORD instantly invalidates all tokens.
 */

import { createHmac, timingSafeEqual } from "crypto";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json",
};

function computeToken(password, secret) {
  return createHmac("sha256", secret).update(password).digest("hex");
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: CORS,
    });
  }

  const secret = process.env.DASHBOARD_PASSWORD;
  if (!secret) {
    return new Response(JSON.stringify({ error: "Server misconfigured: DASHBOARD_PASSWORD not set" }), {
      status: 500, headers: CORS,
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400, headers: CORS,
    });
  }

  const { password } = body;
  if (!password || typeof password !== "string") {
    return new Response(JSON.stringify({ error: "Missing password" }), {
      status: 400, headers: CORS,
    });
  }

  // Constant-time comparison to prevent timing attacks
  const expected = Buffer.from(secret, "utf8");
  const provided = Buffer.from(password, "utf8");

  let match = false;
  if (provided.length === expected.length) {
    match = timingSafeEqual(provided, expected);
  }

  if (!match) {
    // Small artificial delay to slow brute force
    await new Promise((r) => setTimeout(r, 400));
    return new Response(JSON.stringify({ error: "Invalid password" }), {
      status: 401, headers: CORS,
    });
  }

  const token = computeToken(password, secret);
  return new Response(JSON.stringify({ token }), { status: 200, headers: CORS });
}
