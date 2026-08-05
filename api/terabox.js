const CACHE_TTL_SECONDS = 30 * 60;

function json(res, status, body, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(extraHeaders)) {
    res.setHeader(name, value);
  }
  res.end(JSON.stringify(body));
}

function getRedisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
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
  return "terabox:" + Buffer.from(url).toString("base64url");
}

function isValidGeneratorResponse(data) {
  return Boolean(data && Array.isArray(data.list) && data.list.length > 0);
}

async function readCache(key) {
  const value = await redisCommand(["GET", key]);
  if (!value) return null;

  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return isValidGeneratorResponse(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Method not allowed" });
  }

  const auth = req.headers.authorization || "";
  if (!auth || auth !== process.env.SECRET_TOKEN) {
    return json(res, 401, { error: "Unauthorized" });
  }

  try {
    const url = normalizeUrl(req.body?.url);
    const forceRefresh = req.body?.forceRefresh === true;

    if (!url || !/^https?:\/\//i.test(url)) {
      return json(res, 400, { error: "Missing or invalid url" });
    }

    const cacheKey = cacheKeyFor(url);

    console.log("[terabox-cache] REQUEST", {
      forceRefresh,
      cacheKey
    });

    if (forceRefresh) {
      await redisCommand(["DEL", cacheKey]).catch((error) => {
        console.error("[terabox-cache] FORCE_REFRESH_DELETE_FAILED", error);
      });
      console.log("[terabox-cache] FORCE_REFRESH", { cacheKey });
    } else {
      const cached = await readCache(cacheKey);
      if (cached) {
        console.log("[terabox-cache] REDIS_HIT", { cacheKey });
        return json(
          res,
          200,
          {
            ...cached,
            cached: true,
            _bidamax_cache: "HIT"
          },
          { "X-Bidamax-Cache": "HIT" }
        );
      }
      console.log("[terabox-cache] REDIS_MISS", { cacheKey });
    }

    console.log("[terabox-cache] GENERATING_NEW_LINKS", {
      cacheKey,
      forceRefresh
    });

    const response = await fetch("https://xapiverse.com/api/terabox", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xAPIverse-Key": process.env.XAPIVERSE_KEY
      },
      body: JSON.stringify({ url })
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return json(res, 502, {
        error: "xAPIverse returned invalid JSON",
        status: response.status
      });
    }

    if (!response.ok || !isValidGeneratorResponse(data)) {
      return json(res, response.ok ? 502 : response.status, {
        error: data?.error || data?.message || "Terabox generator failed"
      });
    }

    await redisCommand([
      "SET",
      cacheKey,
      JSON.stringify(data),
      "EX",
      String(CACHE_TTL_SECONDS)
    ]);

    console.log("[terabox-cache] SAVED_TO_REDIS", {
      cacheKey,
      ttl: CACHE_TTL_SECONDS,
      forceRefresh
    });

    return json(
      res,
      200,
      {
        ...data,
        cached: false,
        _bidamax_cache: forceRefresh ? "FORCE_REFRESH" : "MISS"
      },
      {
        "X-Bidamax-Cache": forceRefresh ? "FORCE_REFRESH" : "MISS"
      }
    );
  } catch (error) {
    console.error("[terabox-cache] ERROR", error);
    return json(res, 500, {
      error: "Unable to generate stream",
      message: error?.message || String(error)
    });
  }
}
