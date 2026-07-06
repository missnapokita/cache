const memoryCache = globalThis.__BIDAMAX_CACHE__ || new Map();
globalThis.__BIDAMAX_CACHE__ = memoryCache;

const rateMap = globalThis.__BIDAMAX_RATE__ || new Map();
globalThis.__BIDAMAX_RATE__ = rateMap;

export const DEFAULTS = {
  dataOwner: "mlbb-injector",
  dataRepo: "maui",
  dataBranch: "main",
  dataBasePath: "database",
  versionRawUrl: "https://raw.githubusercontent.com/missnapokita/masterkit/main/version.json"
};

function env(name, fallback) {
  return process.env[name] && String(process.env[name]).trim() !== ""
    ? String(process.env[name]).trim()
    : fallback;
}

export function getDataRawUrl(path) {
  const owner = env("GITHUB_DATA_OWNER", DEFAULTS.dataOwner);
  const repo = env("GITHUB_DATA_REPO", DEFAULTS.dataRepo);
  const branch = env("GITHUB_DATA_BRANCH", DEFAULTS.dataBranch);
  const basePath = env("GITHUB_DATA_BASE_PATH", DEFAULTS.dataBasePath).replace(/^\/+|\/+$/g, "");
  const cleanPath = String(path || "").replace(/^\/+/g, "");
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${basePath}/${cleanPath}`;
}

export function getVersionRawUrl() {
  return env("VERSION_RAW_URL", DEFAULTS.versionRawUrl);
}

export function isSafeId(id) {
  return /^[0-9A-Za-z_-]+$/.test(String(id || ""));
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

export function checkAuth(req, res) {
  const requiredKey = process.env.BIDAMAX_API_KEY;

  if (!requiredKey) {
    res.status(500).json({ error: "Missing BIDAMAX_API_KEY on Vercel" });
    return false;
  }

  const headerKey =
    req.headers["x-bidamax-key"] ||
    req.headers["x-api-key"];

  const allowQueryKey = process.env.ALLOW_QUERY_KEY === "true";
  const queryKey = allowQueryKey && req.query ? req.query.key : undefined;

  if (headerKey !== requiredKey && queryKey !== requiredKey) {
    res.setHeader("Cache-Control", "no-store");
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }

  if (!checkRateLimit(req, res)) return false;

  return true;
}

function checkRateLimit(req, res) {
  const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
  const max = Number(process.env.RATE_LIMIT_MAX || 120);
  const ip = getClientIp(req);
  const now = Date.now();
  const current = rateMap.get(ip);

  if (!current || now > current.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }

  current.count += 1;

  if (current.count > max) {
    const retryAfter = Math.ceil((current.resetAt - now) / 1000);
    res.setHeader("Retry-After", String(retryAfter));
    res.setHeader("Cache-Control", "no-store");
    res.status(429).json({ error: "Too many requests", retryAfter });
    return false;
  }

  return true;
}

export function sendJsonText(res, status, body, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Bidamax-Backend", "v3");
  res.setHeader("Vary", "X-Bidamax-Key, X-API-Key");

  // Important: do NOT use public CDN cache here. Public CDN cache can expose
  // protected JSON to users without the app header. GitHub protection is handled
  // by server memory cache + GitHub ETag.
  res.setHeader("Cache-Control", "private, max-age=60");

  for (const [k, v] of Object.entries(extraHeaders)) {
    res.setHeader(k, v);
  }

  res.end(body);
}

export async function fetchCachedJson(url, options = {}) {
  const cacheKey = options.cacheKey || url;
  const ttlSeconds = Number(options.ttlSeconds || 1800);
  const staleSeconds = Number(options.staleSeconds || 86400);
  const now = Date.now();

  const cached = memoryCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return {
      body: cached.body,
      status: 200,
      cache: "HIT",
      sourceStatus: cached.sourceStatus || 200
    };
  }

  const headers = {
    "User-Agent": "BIDAMAX-Vercel-Cache/3.0",
    "Accept": "application/json,text/plain,*/*"
  };

  if (cached && cached.etag) {
    headers["If-None-Match"] = cached.etag;
  }

  if (process.env.GITHUB_TOKEN) {
    headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  try {
    const response = await fetch(url, { headers });

    if (response.status === 304 && cached) {
      cached.expiresAt = now + ttlSeconds * 1000;
      cached.sourceStatus = 304;
      memoryCache.set(cacheKey, cached);
      return {
        body: cached.body,
        status: 200,
        cache: "REVALIDATED",
        sourceStatus: 304
      };
    }

    if (!response.ok) {
      if (cached && now - cached.savedAt < staleSeconds * 1000) {
        return {
          body: cached.body,
          status: 200,
          cache: "STALE",
          sourceStatus: response.status
        };
      }

      const text = await response.text().catch(() => "");
      return {
        body: JSON.stringify({
          error: "Source fetch failed",
          status: response.status,
          message: text.slice(0, 300)
        }),
        status: response.status,
        cache: "MISS",
        sourceStatus: response.status
      };
    }

    const text = await response.text();

    // Validate JSON before caching.
    JSON.parse(text);

    const etag = response.headers.get("etag") || "";
    const entry = {
      body: text,
      etag,
      savedAt: now,
      expiresAt: now + ttlSeconds * 1000,
      sourceStatus: response.status
    };

    memoryCache.set(cacheKey, entry);

    return {
      body: text,
      status: 200,
      cache: cached ? "REFRESH" : "MISS",
      sourceStatus: response.status
    };

  } catch (error) {
    if (cached && now - cached.savedAt < staleSeconds * 1000) {
      return {
        body: cached.body,
        status: 200,
        cache: "STALE_ERROR",
        sourceStatus: 0
      };
    }

    return {
      body: JSON.stringify({
        error: "Fetch error",
        message: String(error && error.message ? error.message : error)
      }),
      status: 500,
      cache: "ERROR",
      sourceStatus: 0
    };
  }
}

export async function serveCachedJson(req, res, config) {
  if (!checkAuth(req, res)) return;

  const result = await fetchCachedJson(config.url, {
    cacheKey: config.cacheKey,
    ttlSeconds: config.ttlSeconds,
    staleSeconds: config.staleSeconds
  });

  sendJsonText(res, result.status, result.body, {
    "X-Bidamax-Cache": result.cache,
    "X-Source-Status": String(result.sourceStatus)
  });
}
