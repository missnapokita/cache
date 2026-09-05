const DEFAULT_ALLOWED_ORIGINS = [
  "https://missnapokita.github.io",
  "https://player.bidamax.org",
  "https://mamamo-gray.vercel.app"
];

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

const INTERNAL_TIMEOUT_MS = boundedNumber(
  process.env.BIDAMAX_INTERNAL_TIMEOUT_MS,
  18000,
  5000,
  28000
);

function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

function allowedOrigins() {
  const extra = String(process.env.BIDAMAX_PLAYER_ORIGINS || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);
  return Array.from(new Set(DEFAULT_ALLOWED_ORIGINS.concat(extra)));
}

function applyCors(req, res) {
  const origin = normalizeOrigin(req.headers.origin);
  if (origin && allowedOrigins().includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Bidamax-Request-Id");
  res.setHeader("Access-Control-Expose-Headers", "X-Bidamax-Cache, X-Bidamax-Generation, X-Bidamax-Request-Id");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("CDN-Cache-Control", "no-store");
  res.setHeader("Vercel-CDN-Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function requestBody(req) {
  let raw;
  try {
    raw = req.body;
  } catch (_) {
    return null;
  }

  if (typeof raw !== "string") return raw || {};
  try {
    return JSON.parse(raw || "{}");
  } catch (_) {
    return null;
  }
}

function cleanRequestId(value) {
  return String(value || "")
    .replace(/[^0-9A-Za-z._-]/g, "")
    .slice(0, 80);
}

function createRequestId() {
  return `bmx-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return json(res, 405, { error: "Method not allowed" });
  }

  const origin = normalizeOrigin(req.headers.origin);
  if (!origin || !allowedOrigins().includes(origin)) {
    return json(res, 403, { error: "Player origin not allowed" });
  }

  const body = requestBody(req);
  if (!body) {
    return json(res, 400, { error: "Invalid JSON body" });
  }

  const url = String(body.url || "").trim();
  const forceRefresh = body.forceRefresh === true;
  const requestId =
    cleanRequestId(req.headers["x-bidamax-request-id"] || body.requestId) ||
    createRequestId();

  if (!/^https?:\/\//i.test(url)) {
    return json(res, 400, { error: "A valid url is required" });
  }

  const appKey = process.env.BIDAMAX_API_KEY;
  if (!appKey) {
    return json(res, 500, { error: "BIDAMAX_API_KEY is not configured" });
  }

  const upstreamAuthorization = process.env.TERABOX_ORIGIN_AUTHORIZATION || "";
  const internalUrl =
    process.env.BIDAMAX_TERABOX_INTERNAL_URL ||
    "https://cache-liart.vercel.app/api/terabox";

  const headers = {
    "Content-Type": "application/json",
    "X-Bidamax-Key": appKey,
    "X-Bidamax-Client": "hosted-player-v2",
    "X-Bidamax-Request-Id": requestId
  };

  if (forceRefresh) {
    headers["X-Bidamax-Force-Fresh"] = "1";
  }

  if (upstreamAuthorization) {
    headers.Authorization = upstreamAuthorization;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INTERNAL_TIMEOUT_MS);

  try {
    const response = await fetch(internalUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ url, forceRefresh, requestId }),
      cache: "no-store",
      signal: controller.signal
    });

    const text = await response.text();
    const cacheState = response.headers.get("x-bidamax-cache") || "DISABLED";
    const generation = response.headers.get("x-bidamax-generation") ||
      (response.ok ? "FRESH" : "FAILED");
    const upstreamRequestId = response.headers.get("x-bidamax-request-id") || requestId;

    res.setHeader("X-Bidamax-Cache", cacheState);
    res.setHeader("X-Bidamax-Generation", generation);
    res.setHeader("X-Bidamax-Request-Id", upstreamRequestId);

    res.statusCode = response.status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("CDN-Cache-Control", "no-store");
    res.setHeader("Vercel-CDN-Cache-Control", "no-store");
    return res.end(text);
  } catch (error) {
    console.error("[player-stream]", error);

    res.setHeader("X-Bidamax-Cache", "DISABLED");
    res.setHeader("X-Bidamax-Generation", "FAILED");
    res.setHeader("X-Bidamax-Request-Id", requestId);

    if (error && error.name === "AbortError") {
      return json(res, 504, {
        error: "Stream service timed out",
        message: "Fresh stream generation took too long"
      });
    }

    return json(res, 502, {
      error: "Unable to reach stream service",
      message: error?.message || "Unknown error"
    });
  } finally {
    clearTimeout(timer);
  }
}
