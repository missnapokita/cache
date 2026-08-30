import crypto from "node:crypto";

const CACHE_TTL_SECONDS = 24 * 60 * 60;
const LOCK_TTL_SECONDS = 30;

// Local memory cache is only a short "hot cache" inside a warm Vercel instance.
// Redis remains the source of truth for the full 24-hour cache.
const MEMORY_TTL_MS = 30 * 1000;
const MEMORY_MAX_ITEMS = 500;

const FIRST_WAIT_MS = 5000;
const SECOND_WAIT_MS = 4000;

const ORIGIN_TIMEOUT_MS = 12000;
const REDIS_TIMEOUT_MS = 4000;
const ORIGIN_URL =
  process.env.TERABOX_ORIGIN_URL ||
  "https://terabox-proxy-theta.vercel.app/api/terabox";

const memoryCache = new Map();

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
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL;

  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN;

  return { url, token };
}

async function fetchWithTimeout(url, options, timeoutMs, timeoutMessage) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      const timeoutError = new Error(timeoutMessage || "Request timed out");
      timeoutError.status = 504;
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function redisCommand(command) {
  const { url, token } = getRedisConfig();

  if (!url || !token) {
    throw new Error("Redis REST environment variables are missing");
  }

  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(command)
    },
    REDIS_TIMEOUT_MS,
    "Redis request timed out"
  );

  const data = await response.json().catch(() => null);

  if (!response.ok || !data || data.error) {
    throw new Error(
      data?.error || `Redis command failed (${response.status})`
    );
  }

  return data.result;
}

function normalizeUrl(value) {
  return String(value || "").trim();
}

function cacheKeyFor(url) {
  const hash = crypto
    .createHash("sha256")
    .update(url)
    .digest("hex");

  return `bidamax:terabox:v1:${hash}`;
}

function isValidGeneratorResponse(data) {
  return Boolean(
    data &&
    Array.isArray(data.list) &&
    data.list.length > 0
  );
}

function isForceRefresh(value) {
  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    String(value || "").toLowerCase() === "true"
  );
}

function getMemoryCache(key) {
  const item = memoryCache.get(key);

  if (!item) return null;

  if (item.expiresAt <= Date.now()) {
    memoryCache.delete(key);
    return null;
  }

  return item.value;
}

function setMemoryCache(key, value) {
  if (memoryCache.size >= MEMORY_MAX_ITEMS) {
    const oldestKey = memoryCache.keys().next().value;

    if (oldestKey) {
      memoryCache.delete(oldestKey);
    }
  }

  memoryCache.set(key, {
    value,
    expiresAt: Date.now() + MEMORY_TTL_MS
  });
}

async function readCache(key) {
  const value = await redisCommand(["GET", key]);

  if (!value) return null;

  try {
    const parsed = JSON.parse(value);

    if (!isValidGeneratorResponse(parsed)) {
      return null;
    }

    setMemoryCache(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

async function clearCachedStream(key) {
  // Clear both cache layers. Redis is the source of truth, while the local
  // Map can otherwise keep returning the same broken link for ~30 seconds.
  memoryCache.delete(key);
  await redisCommand(["DEL", key]);
}

async function callOrigin(url, authorization) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (authorization) {
    headers.Authorization = authorization;
  }

  const response = await fetchWithTimeout(
    ORIGIN_URL,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ url })
    },
    ORIGIN_TIMEOUT_MS,
    "Terabox generator timed out"
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    const error = new Error(
      `Generator returned invalid JSON (${response.status})`
    );
    error.status = 502;
    throw error;
  }

  if (!response.ok || !isValidGeneratorResponse(data)) {
    const message =
      data?.message ||
      data?.error ||
      `Generator failed (${response.status})`;

    const error = new Error(message);
    error.status =
      response.status >= 400 ? response.status : 502;

    throw error;
  }

  return data;
}

async function acquireLock(lockKey, lockToken) {
  const result = await redisCommand([
    "SET",
    lockKey,
    lockToken,
    "NX",
    "EX",
    String(LOCK_TTL_SECONDS)
  ]);

  return result === "OK";
}

async function releaseOwnedLock(lockKey, lockToken) {
  // One Redis command instead of GET + DEL.
  // The lock is deleted only when its token still matches.
  await redisCommand([
    "EVAL",
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    "1",
    lockKey,
    lockToken
  ]).catch(() => null);
}

async function generateAndCache(
  url,
  authorization,
  key,
  lockKey,
  lockToken,
  res,
  cacheStatus = "MISS"
) {
  try {
    const generated = await callOrigin(url, authorization);

    // Save the newly generated response to Redis for 24 hours.
    await redisCommand([
      "SET",
      key,
      JSON.stringify(generated),
      "EX",
      String(CACHE_TTL_SECONDS)
    ]);

    // Also keep a tiny hot copy in the current warm Vercel instance.
    setMemoryCache(key, generated);

    return json(res, 200, generated, {
      "X-Bidamax-Cache": cacheStatus
    });
  } finally {
    await releaseOwnedLock(lockKey, lockToken);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return json(res, 405, {
      error: "Method not allowed"
    });
  }

  const expectedAppKey = process.env.BIDAMAX_API_KEY;

  if (
    expectedAppKey &&
    req.headers["x-bidamax-key"] !== expectedAppKey
  ) {
    return json(res, 401, {
      error: "Unauthorized"
    });
  }

  const url = normalizeUrl(req.body?.url);

  if (!url || !/^https?:\/\//i.test(url)) {
    return json(res, 400, {
      error: "A valid url is required"
    });
  }

  const forceRefresh = isForceRefresh(req.body?.forceRefresh);

  /*
   * Origin authentication belongs on the server.
   *
   * Hosted/public players must never contain the private xAPIverse
   * Authorization value. Existing Android builds can continue sending their
   * legacy Authorization header as a backwards-compatible fallback.
   */
  const originAuthorization =
    process.env.TERABOX_ORIGIN_AUTHORIZATION ||
    req.headers.authorization ||
    "";

  const key = cacheKeyFor(url);
  const lockKey = `${key}:lock`;
  const lockToken = crypto.randomUUID();

  try {
    /*
     * FORCE REFRESH
     *
     * Used by the Bidamax player only after a cached stream fails.
     * Important: acquire the same per-URL lock BEFORE deleting the cache.
     * This prevents many viewers from deleting/regenerating the same stream
     * at the same time.
     */
    if (forceRefresh) {
      const acquiredRefreshLock = await acquireLock(lockKey, lockToken);

      if (acquiredRefreshLock) {
        await clearCachedStream(key);

        return await generateAndCache(
          url,
          originAuthorization,
          key,
          lockKey,
          lockToken,
          res,
          "REFRESH"
        );
      }

      /*
       * Another request is already refreshing/generating this exact URL.
       * Do not return the old cached link here. Wait for the lock owner to
       * replace it, then return the fresh cache.
       */
      await sleep(FIRST_WAIT_MS);

      const firstRefreshWait =
        getMemoryCache(key) || await readCache(key);

      if (firstRefreshWait) {
        return json(res, 200, firstRefreshWait, {
          "X-Bidamax-Cache": "REFRESH-WAIT-HIT"
        });
      }

      await sleep(SECOND_WAIT_MS);

      const secondRefreshWait =
        getMemoryCache(key) || await readCache(key);

      if (secondRefreshWait) {
        return json(res, 200, secondRefreshWait, {
          "X-Bidamax-Cache": "REFRESH-WAIT-HIT-2"
        });
      }

      return json(
        res,
        503,
        {
          error: "Stream refresh is busy",
          message:
            "Another request is refreshing this stream. Please retry shortly."
        },
        {
          "Retry-After": "2",
          "X-Bidamax-Cache": "REFRESH-BUSY"
        }
      );
    }

    /*
     * 0 Redis commands on a warm-instance hot hit.
     * This is intentionally short-lived (30s); Redis still owns the 24h cache.
     */
    const hot = getMemoryCache(key);

    if (hot) {
      return json(res, 200, hot, {
        "X-Bidamax-Cache": "MEMORY-HIT"
      });
    }

    /*
     * Normal cached video:
     * exactly 1 Redis command (GET).
     */
    const cached = await readCache(key);

    if (cached) {
      return json(res, 200, cached, {
        "X-Bidamax-Cache": "HIT"
      });
    }

    /*
     * Cache miss:
     * only one request can call the Terabox generator.
     */
    const acquired = await acquireLock(lockKey, lockToken);

    if (acquired) {
      return await generateAndCache(
        url,
        originAuthorization,
        key,
        lockKey,
        lockToken,
        res
      );
    }

    /*
     * IMPORTANT COST FIX:
     *
     * The previous version polled Redis every 700ms up to 15 times.
     * Under heavy traffic, those GETs consumed the Upstash command quota
     * extremely quickly.
     *
     * Now a waiter checks Redis only twice.
     */
    await sleep(FIRST_WAIT_MS);

    const firstWait = getMemoryCache(key) || await readCache(key);

    if (firstWait) {
      return json(res, 200, firstWait, {
        "X-Bidamax-Cache": "WAIT-HIT"
      });
    }

    await sleep(SECOND_WAIT_MS);

    const secondWait = getMemoryCache(key) || await readCache(key);

    if (secondWait) {
      return json(res, 200, secondWait, {
        "X-Bidamax-Cache": "WAIT-HIT-2"
      });
    }

    /*
     * Do NOT directly call the upstream generator here.
     * That old fallback allowed many waiting viewers to regenerate the
     * exact same Terabox URL simultaneously.
     */
    return json(
      res,
      503,
      {
        error: "Stream generation is busy",
        message:
          "Another request is generating this stream. Please retry shortly."
      },
      {
        "Retry-After": "2",
        "X-Bidamax-Cache": "BUSY"
      }
    );
  } catch (error) {
    console.error("[terabox-cache]", error);

    return json(res, error.status || 500, {
      error: "Unable to generate stream",
      message: error.message || "Unknown error"
    });
  }
}
