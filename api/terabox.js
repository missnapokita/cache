import crypto from "node:crypto";

const CACHE_TTL_SECONDS = 24 * 60 * 60;
const LOCK_TTL_SECONDS = 30;
const WAIT_ATTEMPTS = 15;
const WAIT_DELAY_MS = 700;
const ORIGIN_URL = process.env.TERABOX_ORIGIN_URL ||
  "https://terabox-proxy-theta.vercel.app/api/terabox";

function json(res, status, body, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(extraHeaders)) {
    res.setHeader(name, value);
  }
  res.end(JSON.stringify(body));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRedisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

async function redisCommand(command) {
  const { url, token } = getRedisConfig();
  if (!url || !token) {
    throw new Error("Redis REST environment variables are missing");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.error) {
    throw new Error(data?.error || `Redis command failed (${response.status})`);
  }
  return data.result;
}

function normalizeUrl(value) {
  return String(value || "").trim();
}

function cacheKeyFor(url) {
  const hash = crypto.createHash("sha256").update(url).digest("hex");
  return `bidamax:terabox:v1:${hash}`;
}

function isValidGeneratorResponse(data) {
  return Boolean(data && Array.isArray(data.list) && data.list.length > 0);
}

async function readCache(key) {
  const value = await redisCommand(["GET", key]);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return isValidGeneratorResponse(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function callOrigin(url, authorization) {
  const headers = { "Content-Type": "application/json" };
  if (authorization) headers.Authorization = authorization;

  const response = await fetch(ORIGIN_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ url })
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Generator returned invalid JSON (${response.status})`);
  }

  if (!response.ok || !isValidGeneratorResponse(data)) {
    const message = data?.message || data?.error || `Generator failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status >= 400 ? response.status : 502;
    throw error;
  }
  return data;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Method not allowed" });
  }

  // Use the existing Authorization header from the app.
  // If TERABOX_APP_AUTH is configured, it must match.
  const expectedAuthorization = process.env.TERABOX_APP_AUTH;
  const incomingAuthorization = req.headers.authorization || "";

  if (expectedAuthorization && incomingAuthorization !== expectedAuthorization) {
    return json(res, 401, { error: "Unauthorized" });
  }

  const url = normalizeUrl(req.body?.url);
  if (!url || !/^https?:\/\//i.test(url)) {
    return json(res, 400, { error: "A valid url is required" });
  }

  const key = cacheKeyFor(url);
  const lockKey = `${key}:lock`;
  const lockToken = crypto.randomUUID();

  try {
    const cached = await readCache(key);
    if (cached) {
      return json(res, 200, cached, { "X-Bidamax-Cache": "HIT" });
    }

    const acquired = await redisCommand([
      "SET", lockKey, lockToken, "NX", "EX", String(LOCK_TTL_SECONDS)
    ]);

    if (acquired === "OK") {
      try {
        const generated = await callOrigin(url, req.headers.authorization);
        await redisCommand([
          "SET", key, JSON.stringify(generated), "EX", String(CACHE_TTL_SECONDS)
        ]);
        return json(res, 200, generated, { "X-Bidamax-Cache": "MISS" });
      } finally {
        const currentToken = await redisCommand(["GET", lockKey]).catch(() => null);
        if (currentToken === lockToken) {
          await redisCommand(["DEL", lockKey]).catch(() => null);
        }
      }
    }

    for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
      await sleep(WAIT_DELAY_MS);
      const waitingResult = await readCache(key);
      if (waitingResult) {
        return json(res, 200, waitingResult, { "X-Bidamax-Cache": "WAIT-HIT" });
      }
    }

    // The first request may have failed or its lock may still be stale.
    // Generate once as a safe fallback and overwrite the cache.
    const generated = await callOrigin(url, req.headers.authorization);
    await redisCommand([
      "SET", key, JSON.stringify(generated), "EX", String(CACHE_TTL_SECONDS)
    ]);
    return json(res, 200, generated, { "X-Bidamax-Cache": "FALLBACK-MISS" });
  } catch (error) {
    console.error("[terabox-cache]", error);
    return json(res, error.status || 500, {
      error: "Unable to generate stream",
      message: error.message || "Unknown error"
    });
  }
}
