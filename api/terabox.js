import crypto from "node:crypto";

const CACHE_TTL_SECONDS = 30 * 60;
const LOCK_TTL_SECONDS = 30;
const WAIT_ATTEMPTS = 15;
const WAIT_DELAY_MS = 700;

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

function cacheKeyFor(url) {
  const hash = crypto
    .createHash("sha256")
    .update(url)
    .digest("hex");

  return `terabox:${hash}`;
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

async function generateLinks(url) {
  const response = await fetch(
    "https://xapiverse.com/api/terabox",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xAPIverse-Key": process.env.XAPIVERSE_KEY
      },
      body: JSON.stringify({ url })
    }
  );

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const error = new Error(
      `xAPIverse returned invalid JSON (${response.status})`
    );
    error.status = 502;
    throw error;
  }

  if (!response.ok || !isValidGeneratorResponse(data)) {
    const error = new Error(
      data?.error ||
      data?.message ||
      `Terabox generator failed (${response.status})`
    );

    error.status = response.ok
      ? 502
      : response.status;

    throw error;
  }

  return data;
}

async function releaseLock(lockKey, lockToken) {
  try {
    const currentToken = await redisCommand(["GET", lockKey]);

    if (currentToken === lockToken) {
      await redisCommand(["DEL", lockKey]);
    }
  } catch (error) {
    console.error(
      "[terabox-cache] LOCK_RELEASE_FAILED",
      error
    );
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return json(res, 405, {
      error: "Method not allowed"
    });
  }

  const auth = req.headers.authorization || "";

  if (!auth || auth !== process.env.SECRET_TOKEN) {
    return json(res, 401, {
      error: "Unauthorized"
    });
  }

  try {
    const url = normalizeUrl(req.body?.url);
    const forceRefresh =
      req.body?.forceRefresh === true;

    if (!url || !/^https?:\/\//i.test(url)) {
      return json(res, 400, {
        error: "Missing or invalid url"
      });
    }

    const cacheKey = cacheKeyFor(url);
    const lockKey = `${cacheKey}:lock`;
    const lockToken = crypto.randomUUID();

    console.log("[terabox-cache] REQUEST", {
      forceRefresh,
      cacheKey
    });

    if (forceRefresh) {
      await redisCommand(["DEL", cacheKey]).catch(
        (error) => {
          console.error(
            "[terabox-cache] FORCE_REFRESH_DELETE_FAILED",
            error
          );
        }
      );

      console.log(
        "[terabox-cache] FORCE_REFRESH",
        { cacheKey }
      );
    } else {
      const cached = await readCache(cacheKey);

      if (cached) {
        console.log(
          "[terabox-cache] REDIS_HIT",
          { cacheKey }
        );

        return json(
          res,
          200,
          {
            ...cached,
            cached: true,
            _bidamax_cache: "HIT"
          },
          {
            "X-Bidamax-Cache": "HIT"
          }
        );
      }

      console.log(
        "[terabox-cache] REDIS_MISS",
        { cacheKey }
      );
    }

    const acquired = await redisCommand([
      "SET",
      lockKey,
      lockToken,
      "NX",
      "EX",
      String(LOCK_TTL_SECONDS)
    ]);

    if (acquired === "OK") {
      try {
        console.log(
          "[terabox-cache] GENERATING_NEW_LINKS",
          {
            cacheKey,
            forceRefresh
          }
        );

        const data = await generateLinks(url);

        await redisCommand([
          "SET",
          cacheKey,
          JSON.stringify(data),
          "EX",
          String(CACHE_TTL_SECONDS)
        ]);

        console.log(
          "[terabox-cache] SAVED_TO_REDIS",
          {
            cacheKey,
            ttl: CACHE_TTL_SECONDS,
            forceRefresh
          }
        );

        return json(
          res,
          200,
          {
            ...data,
            cached: false,
            _bidamax_cache: forceRefresh
              ? "FORCE_REFRESH"
              : "MISS"
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

    console.log(
      "[terabox-cache] LOCK_WAIT",
      { cacheKey }
    );

    for (
      let attempt = 1;
      attempt <= WAIT_ATTEMPTS;
      attempt += 1
    ) {
      await sleep(WAIT_DELAY_MS);

      const waitingResult =
        await readCache(cacheKey);

      if (waitingResult) {
        console.log(
          "[terabox-cache] WAIT_HIT",
          {
            cacheKey,
            attempt
          }
        );

        return json(
          res,
          200,
          {
            ...waitingResult,
            cached: true,
            _bidamax_cache: "WAIT-HIT"
          },
          {
            "X-Bidamax-Cache": "WAIT-HIT"
          }
        );
      }
    }

    console.log(
      "[terabox-cache] FALLBACK_GENERATE",
      {
        cacheKey,
        forceRefresh
      }
    );

    const data = await generateLinks(url);

    await redisCommand([
      "SET",
      cacheKey,
      JSON.stringify(data),
      "EX",
      String(CACHE_TTL_SECONDS)
    ]);

    console.log(
      "[terabox-cache] FALLBACK_SAVED",
      {
        cacheKey,
        ttl: CACHE_TTL_SECONDS
      }
    );

    return json(
      res,
      200,
      {
        ...data,
        cached: false,
        _bidamax_cache: "FALLBACK-MISS"
      },
      {
        "X-Bidamax-Cache": "FALLBACK-MISS"
      }
    );
  } catch (error) {
    console.error(
      "[terabox-cache] ERROR",
      error
    );

    return json(
      res,
      error?.status || 500,
      {
        error: "Unable to generate stream",
        message:
          error?.message ||
          String(error)
      }
    );
  }
}
