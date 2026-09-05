const ORIGIN_TIMEOUT_MS = 12000;
const MAX_ERROR_MESSAGE_LENGTH = 220;

const playableCache = globalThis.__BIDAMAX_PLAYABLE_CACHE__ || new Map();
globalThis.__BIDAMAX_PLAYABLE_CACHE__ = playableCache;

const generationLocks = globalThis.__BIDAMAX_GENERATION_LOCKS__ || new Map();
globalThis.__BIDAMAX_GENERATION_LOCKS__ = generationLocks;

const ORIGIN_URL =
  process.env.TERABOX_ORIGIN_URL ||
  "https://terabox-proxy-theta.vercel.app/api/terabox";

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

const PLAYABLE_TTL_MS = boundedNumber(
  process.env.TERABOX_PLAYABLE_TTL_MS,
  300000,
  30000,
  1800000
);

const MAX_CACHE_ENTRIES = boundedNumber(
  process.env.TERABOX_PLAYABLE_CACHE_MAX,
  200,
  20,
  1000
);

function json(res, status, body, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("CDN-Cache-Control", "no-store");
  res.setHeader("Vercel-CDN-Cache-Control", "no-store");

  for (const [name, value] of Object.entries(extraHeaders)) {
    res.setHeader(name, value);
  }

  res.end(JSON.stringify(body));
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

function normalizeUrl(value) {
  return String(value || "").trim();
}

function validHttpUrl(value) {
  const url = normalizeUrl(value);
  if (!/^https?:\/\//i.test(url)) return false;

  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_) {
    return false;
  }
}

function hasPlayableCandidate(item) {
  if (!item || typeof item !== "object") return false;
  if (validHttpUrl(item.stream_url)) return true;

  const fast = item.fast_stream_url;
  if (!fast || typeof fast !== "object") return false;
  return Object.values(fast).some(validHttpUrl);
}

function isValidGeneratorResponse(data) {
  return Boolean(
    data &&
    Array.isArray(data.list) &&
    data.list.some(hasPlayableCandidate)
  );
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

async function callOrigin(url, authorization, requestId, forceRefresh) {
  const headers = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "X-Bidamax-Request-Id": requestId
  };

  if (forceRefresh) {
    headers["X-Bidamax-Force-Fresh"] = "1";
  }

  if (authorization) {
    headers.Authorization = authorization;
  }

  const response = await fetchWithTimeout(
    ORIGIN_URL,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ url, forceRefresh: forceRefresh === true }),
      cache: "no-store"
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
      (response.ok
        ? "Generator returned no usable stream URLs"
        : `Generator failed (${response.status})`);

    const error = new Error(
      String(message || "Generator failed").slice(0, MAX_ERROR_MESSAGE_LENGTH)
    );
    error.status = response.status >= 400 ? response.status : 502;
    throw error;
  }

  return data;
}

function cacheKey(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch (_) {
    return url;
  }
}

function cleanupPlayableCache(now) {
  for (const [key, entry] of playableCache.entries()) {
    if (!entry || entry.expiresAt <= now) playableCache.delete(key);
  }

  while (playableCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = playableCache.keys().next().value;
    if (oldestKey === undefined) break;
    playableCache.delete(oldestKey);
  }
}

async function resolvePlayable(url, authorization, requestId, forceRefresh) {
  const key = cacheKey(url);
  const now = Date.now();
  cleanupPlayableCache(now);

  const cached = playableCache.get(key);
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return {
      data: cached.data,
      cacheState: "HIT",
      generationState: "REUSED"
    };
  }

  /* Share an active generation so duplicate callbacks create only one link. */
  const activeGeneration = generationLocks.get(key);
  if (activeGeneration) {
    const data = await activeGeneration;
    return {
      data,
      cacheState: "COALESCED",
      generationState: "SHARED"
    };
  }

  const task = callOrigin(
    url,
    authorization,
    requestId,
    forceRefresh === true
  ).then(data => {
    playableCache.delete(key);
    playableCache.set(key, {
      data,
      expiresAt: Date.now() + PLAYABLE_TTL_MS
    });
    cleanupPlayableCache(Date.now());
    return data;
  });

  generationLocks.set(key, task);

  try {
    const data = await task;
    return {
      data,
      cacheState: cached ? "REFRESH" : "MISS",
      generationState: "FRESH"
    };
  } finally {
    if (generationLocks.get(key) === task) generationLocks.delete(key);
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

  const body = requestBody(req);
  if (!body) {
    return json(res, 400, { error: "Invalid JSON body" });
  }

  const url = normalizeUrl(body.url);
  const forceRefresh =
    body.forceRefresh === true ||
    req.headers["x-bidamax-force-fresh"] === "1";

  if (!validHttpUrl(url)) {
    return json(res, 400, {
      error: "A valid url is required"
    });
  }

  const requestId =
    cleanRequestId(req.headers["x-bidamax-request-id"] || body.requestId) ||
    createRequestId();

  const originAuthorization =
    process.env.TERABOX_ORIGIN_AUTHORIZATION ||
    req.headers.authorization ||
    "";

  try {
    const result = await resolvePlayable(
      url,
      originAuthorization,
      requestId,
      forceRefresh
    );

    return json(res, 200, result.data, {
      "X-Bidamax-Cache": result.cacheState,
      "X-Bidamax-Generation": result.generationState,
      "X-Bidamax-Request-Id": requestId
    });
  } catch (error) {
    console.error("[terabox-direct]", error);

    return json(res, error.status || 500, {
      error: "Unable to generate stream",
      message: error.message || "Unknown error"
    }, {
      "X-Bidamax-Cache": "DISABLED",
      "X-Bidamax-Generation": "FAILED",
      "X-Bidamax-Request-Id": requestId
    });
  }
}
