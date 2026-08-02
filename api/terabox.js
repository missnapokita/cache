import crypto from "node:crypto";

const CACHE_TTL_SECONDS = 24 * 60 * 60;
const LOCK_TTL_SECONDS = 45;
const WAIT_STEP_MS = 500;
const MAX_WAIT_MS = 30000;
const DEFAULT_ORIGIN = "https://terabox-proxy-theta.vercel.app/api/terabox";

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function stableKey(url) {
  return crypto.createHash("sha256").update(url.trim()).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function redis(command) {
  const baseUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!baseUrl || !token) throw new Error("Redis environment variables are missing");

  const response = await fetch(`${baseUrl}/${command.map(encodeURIComponent).join("/")}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Redis request failed: ${response.status}`);
  const json = await response.json();
  return json.result;
}

async function getCached(cacheKey) {
  return redis(["GET", cacheKey]);
}

async function acquireLock(lockKey, owner) {
  const result = await redis(["SET", lockKey, owner, "NX", "EX", String(LOCK_TTL_SECONDS)]);
  return result === "OK";
}

async function releaseLock(lockKey, owner) {
  // Delete only our own lock.
  const current = await redis(["GET", lockKey]);
  if (current === owner) await redis(["DEL", lockKey]);
}

async function generateFromOrigin(sourceUrl) {
  const originUrl = process.env.TERABOX_ORIGIN_URL || DEFAULT_ORIGIN;
  const originToken = process.env.TERABOX_ORIGIN_AUTH_TOKEN;
  const headers = { "Content-Type": "application/json" };
  if (originToken) headers.Authorization = originToken;

  const response = await fetch(originUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ url: sourceUrl }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Generator failed (${response.status}): ${text.slice(0, 300)}`);
  }

  // Only cache valid JSON responses containing a non-empty list.
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Generator returned invalid JSON");
  }
  if (!Array.isArray(parsed.list) || parsed.list.length === 0) {
    throw new Error("Generator returned no playable item");
  }
  return JSON.stringify(parsed);
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Bidamax-Key");
    return res.end();
  }
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });

  const expectedAppKey = process.env.BIDAMAX_APP_KEY;
  const suppliedKey = req.headers["x-bidamax-key"] || req.headers.authorization;
  if (expectedAppKey && suppliedKey !== expectedAppKey) {
    return send(res, 401, { error: "Unauthorized" });
  }

  const sourceUrl = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) {
    return send(res, 400, { error: "A valid source url is required" });
  }

  const id = stableKey(sourceUrl);
  const cacheKey = `bidamax:terabox:24h:${id}`;
  const lockKey = `bidamax:terabox:lock:${id}`;
  const owner = crypto.randomUUID();

  try {
    const cached = await getCached(cacheKey);
    if (cached) return send(res, 200, cached, { "X-Bidamax-Cache": "HIT" });

    const locked = await acquireLock(lockKey, owner);
    if (!locked) {
      const started = Date.now();
      while (Date.now() - started < MAX_WAIT_MS) {
        await sleep(WAIT_STEP_MS);
        const shared = await getCached(cacheKey);
        if (shared) return send(res, 200, shared, { "X-Bidamax-Cache": "WAIT-HIT" });
      }
      return send(res, 503, { error: "The stream is still being prepared. Please retry." }, { "Retry-After": "2" });
    }

    try {
      // Recheck after locking in case another request populated it just before the lock.
      const secondCheck = await getCached(cacheKey);
      if (secondCheck) return send(res, 200, secondCheck, { "X-Bidamax-Cache": "LOCK-HIT" });

      const generated = await generateFromOrigin(sourceUrl);
      await redis(["SET", cacheKey, generated, "EX", String(CACHE_TTL_SECONDS)]);
      return send(res, 200, generated, { "X-Bidamax-Cache": "MISS-GENERATED" });
    } finally {
      await releaseLock(lockKey, owner).catch(() => {});
    }
  } catch (error) {
    console.error("terabox cache error", error);
    return send(res, 502, { error: "Unable to prepare stream", details: String(error.message || error) });
  }
}
