import crypto from "node:crypto";

const CACHE_TTL_SECONDS = 24 * 60 * 60;

// One generator per Terabox URL.
// Keep this longer than ORIGIN_TIMEOUT_MS so the owner has time to finish.
const LOCK_TTL_SECONDS = 25;

// First wait: 15 * 700ms = 10.5s
const WAIT_ATTEMPTS = 15;
const WAIT_DELAY_MS = 700;

// Second wait is only used when another request still owns the lock.
const SECOND_WAIT_ATTEMPTS = 10;

// Prevent a slow/downstream generator from occupying the Vercel function forever.
const ORIGIN_TIMEOUT_MS = 12000;
const REDIS_TIMEOUT_MS = 4000;

const ORIGIN_URL =
  process.env.TERABOX_ORIGIN_URL ||
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

async function releaseLock(lockKey, lockToken) {
  // Only remove a lock if we still own it.
  const currentToken = await redisCommand(["GET", lockKey]).catch(
    () => null
  );

  if (currentToken === lockToken) {
    await redisCommand(["DEL", lockKey]).catch(() => null);
  }
}

async function generateAndCache(
  url,
  authorization,
  key,
  lockKey,
  lockToken,
  cacheHeader,
  res
) {
  try {
    // Another request may have completed immediately before we got the lock.
    const cached = await readCache(key);

    if (cached) {
      return json(res, 200, cached, {
        "X-Bidamax-Cache": "LOCK-HIT"
      });
    }

    const generated = await callOrigin(url, authorization);

    await redisCommand([
      "SET",
      key,
      JSON.stringify(generated),
      "EX",
      String(CACHE_TTL_SECONDS)
    ]);

    return json(res, 200, generated, {
      "X-Bidamax-Cache": cacheHeader
    });
  } finally {
    await releaseLock(lockKey, lockToken);
  }
}

async function waitForCache(key, attempts) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(WAIT_DELAY_MS);

    const waitingResult = await readCache(key);

    if (waitingResult) {
      return waitingResult;
    }
  }

  return null;
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

  const key = cacheKeyFor(url);
  const lockKey = `${key}:lock`;
  const lockToken = crypto.randomUUID();

  try {
    // Fast path: almost every viewer of an already-generated item ends here.
    const cached = await readCache(key);

    if (cached) {
      return json(res, 200, cached, {
        "X-Bidamax-Cache": "HIT"
      });
    }

    // Only ONE request is allowed to call the upstream generator.
    const acquired = await acquireLock(lockKey, lockToken);

    if (acquired) {
      return await generateAndCache(
        url,
        req.headers.authorization,
        key,
        lockKey,
        lockToken,
        "MISS",
        res
      );
    }

    // Someone else is generating the same URL.
    // Wait for that request to populate Redis.
    const firstWait = await waitForCache(key, WAIT_ATTEMPTS);

    if (firstWait) {
      return json(res, 200, firstWait, {
        "X-Bidamax-Cache": "WAIT-HIT"
      });
    }

    /*
     * IMPORTANT FIX:
     * The old code called callOrigin() here unconditionally.
     * With many viewers, EVERY waiter could hit the upstream generator
     * at the same time. That creates a thundering-herd / retry storm.
     *
     * Instead, try to acquire the lock again. Only the winner regenerates.
     */
    const retryToken = crypto.randomUUID();
    const reacquired = await acquireLock(lockKey, retryToken);

    if (reacquired) {
      return await generateAndCache(
        url,
        req.headers.authorization,
        key,
        lockKey,
        retryToken,
        "RETRY-MISS",
        res
      );
    }

    // A generator is still active. Give it one final bounded wait.
    const secondWait = await waitForCache(
      key,
      SECOND_WAIT_ATTEMPTS
    );

    if (secondWait) {
      return json(res, 200, secondWait, {
        "X-Bidamax-Cache": "WAIT-HIT-2"
      });
    }

    // Do NOT create another upstream request here.
    // This prevents hundreds/thousands of duplicate generations.
    return json(
      res,
      503,
      {
        error: "Stream generation is busy",
        message:
          "Another request is still generating this stream. Retry shortly."
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
