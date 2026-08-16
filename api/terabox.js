import crypto from "node:crypto";

// One generated stream response is shared by every user for one full 24-hour
// window. Redis expires the record automatically; reads never extend the TTL.
const CACHE_TTL_SECONDS = 24 * 60 * 60;
const LOCK_TTL_SECONDS = 30;
// Keep the lock wait below vercel.json's 10-second function limit.
const WAIT_ATTEMPTS = 8;
const WAIT_DELAY_MS = 700;
const CACHE_NAMESPACE = "terabox:v2";
const LEGACY_GENERATOR_URL =
  "https://terabox-proxy-theta.vercel.app/api/terabox";
const XAPIVERSE_GENERATOR_URL =
  "https://xapiverse.com/api/terabox";
const GENERATOR_TIMEOUT_MS = 6500;

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
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL;

  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN;

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
    throw new Error(
      data?.error || `Redis command failed (${response.status})`
    );
  }

  return data.result;
}

function normalizeUrl(value) {
  return String(value || "").trim();
}

function canonicalUrlForCache(value) {
  const parsed = new URL(value);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Unsupported URL protocol");
  }

  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");

  if (
    (parsed.protocol === "https:" && parsed.port === "443") ||
    (parsed.protocol === "http:" && parsed.port === "80")
  ) {
    parsed.port = "";
  }

  if (parsed.pathname.length > 1) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }

  const sortedQuery = Array.from(parsed.searchParams.entries()).sort(
    ([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
  );

  parsed.search = "";
  for (const [name, queryValue] of sortedQuery) {
    parsed.searchParams.append(name, queryValue);
  }

  return parsed.toString();
}

function cacheKeyFor(url) {
  const hash = crypto
    .createHash("sha256")
    .update(canonicalUrlForCache(url))
    .digest("hex");

  return `${CACHE_NAMESPACE}:${hash}`;
}

function isValidGeneratorResponse(data) {
  return Boolean(
    data &&
    Array.isArray(data.list) &&
    data.list.length > 0
  );
}

async function readCache(key) {
  const value = await redisCommand(["GET", key]);

  if (!value) {
    return null;
  }

  try {
    const parsed =
      typeof value === "string"
        ? JSON.parse(value)
        : value;

    return isValidGeneratorResponse(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function requestGenerator(
  endpoint,
  headers,
  url,
  source
) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    GENERATOR_TIMEOUT_MS
  );

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers
      },
      body: JSON.stringify({ url }),
      signal: controller.signal
    });

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const error = new Error(
        `${source} returned invalid JSON (${response.status})`
      );
      error.status = 502;
      throw error;
    }

    if (!response.ok || !isValidGeneratorResponse(data)) {
      const error = new Error(
        data?.error ||
        data?.message ||
        `${source} failed (${response.status})`
      );

      error.status = response.ok ? 502 : response.status;
      throw error;
    }

    return {
      ...data,
      _bidamax_generator: source
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(`${source} timed out`);
      timeoutError.status = 504;
      timeoutError.generatorTimedOut = true;
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function generateLinks(url, requestAuthorization) {
  const proxyAuthorization = String(
    process.env.TERABOX_PROXY_TOKEN ||
    requestAuthorization ||
    ""
  ).trim();

  let proxyError = null;

  // The Android app already has a working authorization token for this
  // endpoint. Using that generator first also keeps this cache service
  // independent from an optional XAPIVERSE_KEY on Vercel.
  if (proxyAuthorization) {
    try {
      return await requestGenerator(
        LEGACY_GENERATOR_URL,
        { Authorization: proxyAuthorization },
        url,
        "legacy-proxy"
      );
    } catch (error) {
      proxyError = error;
      console.warn(
        "[terabox-cache] LEGACY_GENERATOR_FAILED",
        error?.message || String(error)
      );

      // A timeout has already consumed most of this function's Vercel budget.
      if (error?.generatorTimedOut) throw error;
    }
  }

  const xapiverseKey = String(
    process.env.XAPIVERSE_KEY || ""
  ).trim();

  if (xapiverseKey) {
    return requestGenerator(
      XAPIVERSE_GENERATOR_URL,
      { "xAPIverse-Key": xapiverseKey },
      url,
      "xapiverse"
    );
  }

  const error = new Error(
    proxyError?.message ||
    "No working Terabox generator is configured"
  );
  error.status = proxyError?.status || 502;
  throw error;
}

function createCacheRecord(data) {
  const generatedAt = Date.now();

  return {
    ...data,
    _bidamax_generated_at: new Date(generatedAt).toISOString(),
    _bidamax_expires_at: new Date(
      generatedAt + CACHE_TTL_SECONDS * 1000
    ).toISOString()
  };
}

async function saveCache(key, data) {
  const record = createCacheRecord(data);

  await redisCommand([
    "SET",
    key,
    JSON.stringify(record),
    "EX",
    String(CACHE_TTL_SECONDS)
  ]);

  return record;
}

async function acquireLock(lockKey, lockToken) {
  const acquired = await redisCommand([
    "SET",
    lockKey,
    lockToken,
    "NX",
    "EX",
    String(LOCK_TTL_SECONDS)
  ]);

  return acquired === "OK";
}

function isFreshEnoughForRequest(record, forceRefresh, requestedAt) {
  if (!record) return false;
  if (!forceRefresh) return true;

  const generatedAt = Date.parse(record._bidamax_generated_at || "");
  return Number.isFinite(generatedAt) && generatedAt >= requestedAt;
}

function isAuthorized(req) {
  const authorization = String(
    req.headers.authorization || ""
  ).trim();
  const clientApiKey = String(
    req.headers["x-bidamax-key"] ||
    req.headers["x-api-key"] ||
    ""
  ).trim();

  const secretToken = String(
    process.env.SECRET_TOKEN || ""
  ).trim();
  const bidamaxApiKey = String(
    process.env.BIDAMAX_API_KEY || ""
  ).trim();

  const validSecret =
    secretToken.length > 0 && authorization === secretToken;
  const validApiKey =
    bidamaxApiKey.length > 0 && clientApiKey === bidamaxApiKey;

  return validSecret || validApiKey;
}

async function releaseLock(lockKey, lockToken) {
  try {
    const currentToken = await redisCommand(["GET", lockKey]);

    if (currentToken === lockToken) {
      await redisCommand(["DEL", lockKey]);
    }
  } catch (error) {
    console.error("[terabox-cache] LOCK_RELEASE_FAILED", error);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Method not allowed" });
  }

  if (!isAuthorized(req)) {
    return json(res, 401, { error: "Unauthorized" });
  }

  try {
    const url = normalizeUrl(req.body?.url);
    const forceRefresh = req.body?.forceRefresh === true;
    const requestedAt = Date.now();

    if (!url || !/^https?:\/\//i.test(url)) {
      return json(res, 400, { error: "Missing or invalid url" });
    }

    let cacheKey;
    try {
      cacheKey = cacheKeyFor(url);
    } catch {
      return json(res, 400, { error: "Missing or invalid url" });
    }

    const lockKey = `${cacheKey}:lock`;
    const lockToken = crypto.randomUUID();

    console.log("[terabox-cache] REQUEST", {
      forceRefresh,
      cacheKey
    });

    if (!forceRefresh) {
      const cached = await readCache(cacheKey);

      if (cached) {
        console.log("[terabox-cache] REDIS_HIT", { cacheKey });

        return json(
          res,
          200,
          {
            ...cached,
            cached: true,
            _bidamax_cache: "HIT",
            _bidamax_ttl_seconds: CACHE_TTL_SECONDS
          },
          { "X-Bidamax-Cache": "HIT" }
        );
      }

      console.log("[terabox-cache] REDIS_MISS", { cacheKey });
    }

    const acquired = await acquireLock(lockKey, lockToken);

    if (acquired) {
      try {
        if (forceRefresh) {
          await redisCommand(["DEL", cacheKey]);
          console.log("[terabox-cache] FORCE_REFRESH", { cacheKey });
        } else {
          // A second check closes the small race between the first GET and lock.
          const cachedAfterLock = await readCache(cacheKey);

          if (cachedAfterLock) {
            return json(
              res,
              200,
              {
                ...cachedAfterLock,
                cached: true,
                _bidamax_cache: "HIT-AFTER-LOCK",
                _bidamax_ttl_seconds: CACHE_TTL_SECONDS
              },
              { "X-Bidamax-Cache": "HIT-AFTER-LOCK" }
            );
          }
        }

        console.log("[terabox-cache] GENERATING_NEW_LINKS", {
          cacheKey,
          forceRefresh
        });

        const data = await generateLinks(
          url,
          req.headers.authorization
        );
        const record = await saveCache(cacheKey, data);

        console.log("[terabox-cache] SAVED_TO_REDIS", {
          cacheKey,
          ttl: CACHE_TTL_SECONDS,
          forceRefresh
        });

        return json(
          res,
          200,
          {
            ...record,
            cached: false,
            _bidamax_cache: forceRefresh
              ? "FORCE_REFRESH"
              : "MISS",
            _bidamax_ttl_seconds: CACHE_TTL_SECONDS
          },
          {
            "X-Bidamax-Cache": forceRefresh
              ? "FORCE_REFRESH"
              : "MISS"
          }
        );
      } finally {
        await releaseLock(lockKey, lockToken);
      }
    }

    console.log("[terabox-cache] LOCK_WAIT", { cacheKey });

    for (let attempt = 1; attempt <= WAIT_ATTEMPTS; attempt += 1) {
      await sleep(WAIT_DELAY_MS);

      const waitingResult = await readCache(cacheKey);

      if (
        isFreshEnoughForRequest(
          waitingResult,
          forceRefresh,
          requestedAt
        )
      ) {
        console.log("[terabox-cache] WAIT_HIT", {
          cacheKey,
          attempt
        });

        return json(
          res,
          200,
          {
            ...waitingResult,
            cached: true,
            _bidamax_cache: "WAIT-HIT",
            _bidamax_ttl_seconds: CACHE_TTL_SECONDS
          },
          { "X-Bidamax-Cache": "WAIT-HIT" }
        );
      }
    }

    // Never generate in parallel after a lock wait. This preserves the rule
    // that one first viewer creates one shared link for the whole 24-hour window.
    return json(
      res,
      503,
      {
        error: "Generation in progress",
        retryAfterMs: 2000,
        _bidamax_cache: "LOCKED"
      },
      {
        "Retry-After": "2",
        "X-Bidamax-Cache": "LOCKED"
      }
    );
  } catch (error) {
    console.error("[terabox-cache] ERROR", error);

    return json(
      res,
      error?.status || 500,
      {
        error: "Unable to generate stream",
        message: error?.message || String(error)
      }
    );
  }
}
