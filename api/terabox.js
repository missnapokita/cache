import crypto from "node:crypto";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// 30 minutes by default. You can override this in Vercel with
// TERABOX_CACHE_TTL_SECONDS, for example 3600 for one hour.
const CACHE_TTL_SECONDS = Math.max(
  60,
  Number.parseInt(process.env.TERABOX_CACHE_TTL_SECONDS || "1800", 10) || 1800
);

function sendJson(res, status, body, cacheStatus) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (cacheStatus) {
    res.setHeader("X-Bidamax-Cache", cacheStatus);
  }
  return res.status(status).json(body);
}

function normalizeUrl(value) {
  return String(value || "").trim();
}

function cacheKeyFor(url) {
  const hash = crypto.createHash("sha256").update(url).digest("hex");
  return `terabox:v2:${hash}`;
}

function isValidGeneratorResponse(data) {
  return Boolean(data && Array.isArray(data.list) && data.list.length > 0);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  const auth = req.headers.authorization || "";
  if (!auth || auth !== process.env.SECRET_TOKEN) {
    return sendJson(res, 401, { error: "Unauthorized" });
  }

  try {
    const url = normalizeUrl(req.body?.url);
    const forceRefresh = req.body?.forceRefresh === true;

    if (!url || !/^https?:\/\//i.test(url)) {
      return sendJson(res, 400, { error: "A valid url is required" });
    }

    const cacheKey = cacheKeyFor(url);

    console.log("[terabox-cache] REQUEST", {
      cacheKey,
      forceRefresh,
    });

    // When the app detects that every cached stream is expired/stuck,
    // it calls this endpoint once with forceRefresh:true.
    if (forceRefresh) {
      await redis.del(cacheKey);
      console.log("[terabox-cache] FORCE_REFRESH deleted stale cache", {
        cacheKey,
      });
    } else {
      const cached = await redis.get(cacheKey);

      if (cached && isValidGeneratorResponse(cached)) {
        console.log("[terabox-cache] REDIS_HIT", { cacheKey });
        return sendJson(
          res,
          200,
          {
            ...cached,
            cached: true,
            _bidamax_cache: "HIT",
          },
          "HIT"
        );
      }

      // Remove an invalid/corrupted value instead of repeatedly returning it.
      if (cached) {
        await redis.del(cacheKey).catch(() => null);
        console.warn("[terabox-cache] INVALID_CACHE_DELETED", { cacheKey });
      }
    }

    console.log("[terabox-cache] GENERATING_NEW_LINKS", {
      cacheKey,
      forceRefresh,
    });

    // Only send the public xAPIverse fields. Do not forward forceRefresh.
    const response = await fetch("https://xapiverse.com/api/terabox", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xAPIverse-Key": process.env.XAPIVERSE_KEY,
      },
      body: JSON.stringify({ url }),
    });

    const text = await response.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch {
      console.error("[terabox-cache] INVALID_ORIGIN_JSON", {
        status: response.status,
        sample: text.slice(0, 250),
      });
      return sendJson(res, 502, {
        error: "Generator returned invalid JSON",
      });
    }

    if (!response.ok || !isValidGeneratorResponse(data)) {
      console.error("[terabox-cache] ORIGIN_FAILED", {
        status: response.status,
        message: data?.message || data?.error || "Invalid generator response",
      });
      return sendJson(res, response.ok ? 502 : response.status, {
        error: data?.error || "Unable to generate stream",
        message: data?.message || `Generator failed (${response.status})`,
      });
    }

    await redis.set(cacheKey, data, { ex: CACHE_TTL_SECONDS });

    const status = forceRefresh ? "FORCE-MISS" : "MISS";
    console.log("[terabox-cache] SAVED_TO_REDIS", {
      cacheKey,
      ttl: CACHE_TTL_SECONDS,
      status,
    });

    return sendJson(
      res,
      200,
      {
        ...data,
        cached: false,
        _bidamax_cache: status,
      },
      status
    );
  } catch (error) {
    console.error("[terabox-cache] UNHANDLED_ERROR", error);
    return sendJson(res, 500, {
      error: "Unable to generate stream",
      message: error?.message || String(error),
    });
  }
}
