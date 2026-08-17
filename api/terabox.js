import crypto from "node:crypto";

// One generated stream response is shared by every user for a maximum 24-hour
// window. Redis reads never extend the TTL, but an explicitly expired signed
// stream is replaced early so clients are never forced to keep a dead link.
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
// TeraBox fast-stream tokens can expire well before Redis' 24-hour record.
// Start validating only after four hours, then remember a successful check
// for 30 minutes so popular videos do not probe the upstream on every view.
const STREAM_CHECK_START_MS = 4 * 60 * 60 * 1000;
const STREAM_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const STREAM_CHECK_RETRY_MS = 5 * 60 * 1000;
const STREAM_CHECK_TIMEOUT_MS = 1800;
const STREAM_QUALITY_ORDER = [
  "480p",
  "360p",
  "240p",
  "720p",
  "1080p"
];

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
    _bidamax_next_stream_check_at: new Date(
      generatedAt + STREAM_CHECK_START_MS
    ).toISOString(),
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

function cacheRecordVersion(record) {
  return String(
    record?._bidamax_generated_at ||
    record?._bidamax_expires_at ||
    ""
  );
}

function preferredStreamUrl(record) {
  const item = Array.isArray(record?.list)
    ? record.list[0]
    : null;

  if (!item || typeof item !== "object") {
    return "";
  }

  const fast = item.fast_stream_url;
  if (fast && typeof fast === "object") {
    for (const quality of STREAM_QUALITY_ORDER) {
      const candidate = normalizeUrl(fast[quality]);
      if (/^https?:\/\//i.test(candidate)) {
        return candidate;
      }
    }

    for (const candidateValue of Object.values(fast)) {
      const candidate = normalizeUrl(candidateValue);
      if (/^https?:\/\//i.test(candidate)) {
        return candidate;
      }
    }
  }

  const fallback = normalizeUrl(item.stream_url);
  return /^https?:\/\//i.test(fallback) ? fallback : "";
}

function shouldCheckCachedStream(record, now = Date.now()) {
  const explicitCheckAt = Date.parse(
    record?._bidamax_next_stream_check_at || ""
  );

  if (Number.isFinite(explicitCheckAt)) {
    return now >= explicitCheckAt;
  }

  const generatedAt = Date.parse(
    record?._bidamax_generated_at || ""
  );

  // Records created before this improvement are checked once when their
  // generation timestamp is missing instead of being trusted for 24 hours.
  if (!Number.isFinite(generatedAt)) {
    return true;
  }

  return now - generatedAt >= STREAM_CHECK_START_MS;
}

function explicitExpiredResponse(status, text) {
  const body = String(text || "").toLowerCase();
  const saysExpired =
    body.includes("link expired") ||
    body.includes("token expired") ||
    body.includes("expired token") ||
    body.includes("video unavailable") ||
    body.includes("stream unavailable");

  if (saysExpired || status === 404 || status === 410) {
    return true;
  }

  return (
    (status === 401 || status === 403) &&
    (saysExpired || body.includes("not found"))
  );
}

async function probeStreamUrl(url) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    STREAM_CHECK_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Range: "bytes=0-0",
        Accept: "video/*,application/octet-stream,text/html,application/json,*/*",
        "Cache-Control": "no-cache",
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/138 Mobile Safari/537.36"
      },
      redirect: "follow",
      signal: controller.signal
    });

    const contentType = String(
      response.headers.get("content-type") || ""
    ).toLowerCase();

    if (response.ok && !contentType.includes("json")) {
      if (response.body && typeof response.body.cancel === "function") {
        await response.body.cancel().catch(() => {});
      }

      return { state: "alive", reason: `HTTP_${response.status}` };
    }

    const text = await response.text().catch(() => "");

    if (explicitExpiredResponse(response.status, text)) {
      return {
        state: "dead",
        reason: `EXPIRED_HTTP_${response.status}`
      };
    }

    // A timeout, anti-bot response, or temporary upstream error does not prove
    // that Chromium cannot play the URL. Keep the cache and retry soon.
    return {
      state: "unknown",
      reason: `UNCONFIRMED_HTTP_${response.status}`
    };
  } catch (error) {
    return {
      state: "unknown",
      reason: error?.name === "AbortError"
        ? "PROBE_TIMEOUT"
        : `PROBE_${error?.name || "ERROR"}`
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function postponeCachedStreamCheck(
  key,
  record,
  delayMs
) {
  const updated = {
    ...record,
    _bidamax_next_stream_check_at: new Date(
      Date.now() + delayMs
    ).toISOString()
  };

  try {
    // Update only the exact record that was probed. The small Lua compare-and-
    // set prevents a slower validation request from overwriting a newer link
    // generated by another viewer. KEEPTTL preserves the original 24-hour cap.
    const version = cacheRecordVersion(record);
    if (!version) return record;

    const changed = await redisCommand([
      "EVAL",
      "local current=redis.call('GET',KEYS[1]); if not current then return 0 end; if not string.find(current,ARGV[1],1,true) then return 0 end; redis.call('SET',KEYS[1],ARGV[2],'KEEPTTL'); return 1",
      "1",
      key,
      version,
      JSON.stringify(updated)
    ]);

    return Number(changed) === 1 ? updated : record;
  } catch (error) {
    console.warn(
      "[terabox-cache] STREAM_CHECK_TIMESTAMP_FAILED",
      error?.message || String(error)
    );
    return record;
  }
}

async function inspectCachedStream(key, record) {
  const streamUrl = preferredStreamUrl(record);
  if (!streamUrl) {
    return { usable: false, record, reason: "NO_STREAM_URL" };
  }

  if (!shouldCheckCachedStream(record)) {
    return { usable: true, record, reason: "CHECK_NOT_DUE" };
  }

  const result = await probeStreamUrl(streamUrl);

  if (result.state === "dead") {
    return { usable: false, record, reason: result.reason };
  }

  const delay = result.state === "alive"
    ? STREAM_CHECK_INTERVAL_MS
    : STREAM_CHECK_RETRY_MS;

  const updated = await postponeCachedStreamCheck(
    key,
    record,
    delay
  );

  return {
    usable: true,
    record: updated,
    reason: result.reason
  };
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

function isFreshEnoughForRequest(record, requireNew, requestedAt) {
  if (!record) return false;
  if (!requireNew) return true;

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
    let rejectedCacheVersion = "";
    let autoRefreshExpired = false;

    console.log("[terabox-cache] REQUEST", {
      forceRefresh,
      cacheKey
    });

    if (!forceRefresh) {
      const cached = await readCache(cacheKey);

      if (cached) {
        const inspection = await inspectCachedStream(
          cacheKey,
          cached
        );

        if (inspection.usable) {
          console.log("[terabox-cache] REDIS_HIT", {
            cacheKey,
            validation: inspection.reason
          });

          return json(
            res,
            200,
            {
              ...inspection.record,
              cached: true,
              _bidamax_cache: "HIT",
              _bidamax_ttl_seconds: CACHE_TTL_SECONDS
            },
            { "X-Bidamax-Cache": "HIT" }
          );
        }

        rejectedCacheVersion = cacheRecordVersion(cached);
        autoRefreshExpired = true;

        console.warn("[terabox-cache] EXPIRED_CACHE_DETECTED", {
          cacheKey,
          reason: inspection.reason
        });
      } else {
        console.log("[terabox-cache] REDIS_MISS", { cacheKey });
      }
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
            const sameRejectedRecord =
              rejectedCacheVersion.length > 0 &&
              cacheRecordVersion(cachedAfterLock) ===
                rejectedCacheVersion;

            const inspection = sameRejectedRecord
              ? {
                  usable: false,
                  record: cachedAfterLock,
                  reason: "SAME_EXPIRED_RECORD"
                }
              : await inspectCachedStream(
                  cacheKey,
                  cachedAfterLock
                );

            if (inspection.usable) {
              return json(
                res,
                200,
                {
                  ...inspection.record,
                  cached: true,
                  _bidamax_cache: "HIT-AFTER-LOCK",
                  _bidamax_ttl_seconds: CACHE_TTL_SECONDS
                },
                { "X-Bidamax-Cache": "HIT-AFTER-LOCK" }
              );
            }

            autoRefreshExpired = true;
            rejectedCacheVersion = cacheRecordVersion(
              cachedAfterLock
            );
            await redisCommand(["DEL", cacheKey]);

            console.warn(
              "[terabox-cache] AUTO_REFRESH_EXPIRED",
              {
                cacheKey,
                reason: inspection.reason
              }
            );
          }
        }

        console.log("[terabox-cache] GENERATING_NEW_LINKS", {
          cacheKey,
          forceRefresh,
          autoRefreshExpired
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

        const responseState = forceRefresh
          ? "FORCE_REFRESH"
          : autoRefreshExpired
            ? "EXPIRED_REFRESH"
            : "MISS";

        return json(
          res,
          200,
          {
            ...record,
            cached: false,
            _bidamax_cache: responseState,
            _bidamax_ttl_seconds: CACHE_TTL_SECONDS
          },
          {
            "X-Bidamax-Cache": responseState
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
      const requireNewRecord =
        forceRefresh || autoRefreshExpired;

      if (
        isFreshEnoughForRequest(
          waitingResult,
          requireNewRecord,
          requestedAt
        )
      ) {
        console.log("[terabox-cache] WAIT_HIT", {
          cacheKey,
          attempt
        });

        const waitState = requireNewRecord
          ? "WAIT-REFRESH"
          : "WAIT-HIT";

        return json(
          res,
          200,
          {
            ...waitingResult,
            cached: true,
            _bidamax_cache: waitState,
            _bidamax_ttl_seconds: CACHE_TTL_SECONDS
          },
          { "X-Bidamax-Cache": waitState }
        );
      }
    }

    // Never generate in parallel after a lock wait. One viewer creates the
    // replacement and every other viewer reuses that same refreshed link.
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
