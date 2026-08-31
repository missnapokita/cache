const ORIGIN_TIMEOUT_MS = 12000;

const ORIGIN_URL =
  process.env.TERABOX_ORIGIN_URL ||
  "https://terabox-proxy-theta.vercel.app/api/terabox";

function json(res, status, body, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");

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

function isValidGeneratorResponse(data) {
  return Boolean(
    data &&
    Array.isArray(data.list) &&
    data.list.length > 0
  );
}

async function callOrigin(url, authorization) {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache"
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
    error.status = response.status >= 400 ? response.status : 502;
    throw error;
  }

  return data;
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

  /*
   * No shared playable-link cache:
   * every request generates a fresh playable response.
   * No Redis/Upstash GET/SET, no memory cache, no shared lock.
   * forceRefresh can still be sent by older clients; every request is
   * already fresh, so it needs no special branch.
   */
  const originAuthorization =
    process.env.TERABOX_ORIGIN_AUTHORIZATION ||
    req.headers.authorization ||
    "";

  try {
    const generated = await callOrigin(url, originAuthorization);

    return json(res, 200, generated, {
      "X-Bidamax-Cache": "DISABLED",
      "X-Bidamax-Generation": "FRESH"
    });
  } catch (error) {
    console.error("[terabox-direct]", error);

    return json(res, error.status || 500, {
      error: "Unable to generate stream",
      message: error.message || "Unknown error"
    }, {
      "X-Bidamax-Cache": "DISABLED"
    });
  }
}
