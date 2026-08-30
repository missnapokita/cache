const DEFAULT_ALLOWED_ORIGINS = [
  "https://missnapokita.github.io",
  "https://player.bidamax.org"
];

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "X-Bidamax-Cache");
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
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

  const url = String(req.body?.url || "").trim();
  const forceRefresh = req.body?.forceRefresh === true;

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
    "X-Bidamax-Client": "hosted-player-v1"
  };

  if (upstreamAuthorization) {
    headers.Authorization = upstreamAuthorization;
  }

  try {
    const response = await fetch(internalUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ url, forceRefresh }),
      cache: "no-store"
    });

    const text = await response.text();
    const cacheState = response.headers.get("x-bidamax-cache");
    if (cacheState) res.setHeader("X-Bidamax-Cache", cacheState);

    res.statusCode = response.status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(text);
  } catch (error) {
    console.error("[player-stream]", error);
    return json(res, 502, {
      error: "Unable to reach stream service",
      message: error?.message || "Unknown error"
    });
  }
}
