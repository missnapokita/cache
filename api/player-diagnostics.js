import { createHash } from "node:crypto";

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

const DEFAULT_ALLOWED_ORIGINS = [
  "https://mamamo-gray.vercel.app",
  "https://missnapokita.github.io",
  "https://player.bidamax.org"
];

const DEFAULT_OWNER = process.env.DIAGNOSTICS_GITHUB_OWNER || "missnapokita";
const DEFAULT_REPO = process.env.DIAGNOSTICS_GITHUB_REPO || "cache";
const DEFAULT_BRANCH = process.env.DIAGNOSTICS_GITHUB_BRANCH || "main";
const DEFAULT_PATH = process.env.DIAGNOSTICS_GITHUB_PATH || "database/player_errors.json";
const MAX_ERRORS = boundedNumber(
  process.env.DIAGNOSTICS_MAX_ERRORS,
  300,
  50,
  1000
);
const GITHUB_TIMEOUT_MS = boundedNumber(
  process.env.DIAGNOSTICS_GITHUB_TIMEOUT_MS,
  9000,
  3000,
  20000
);
const MAX_BODY_LENGTH = 12 * 1024;

let diagnosticsQueue =
  globalThis.__BIDAMAX_DIAGNOSTICS_QUEUE__ || Promise.resolve();
globalThis.__BIDAMAX_DIAGNOSTICS_QUEUE__ = diagnosticsQueue;

function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

function allowedOrigins() {
  const extra = String(process.env.BIDAMAX_PLAYER_ORIGINS || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);
  return Array.from(new Set(DEFAULT_ALLOWED_ORIGINS.concat(extra)));
}

function isAllowedOrigin(origin) {
  return !origin || allowedOrigins().includes(origin);
}

function cors(req, res) {
  const origin = normalizeOrigin(req.headers.origin);
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("CDN-Cache-Control", "no-store");
  res.setHeader("Vercel-CDN-Cache-Control", "no-store");
  return res.end(JSON.stringify(body));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeText(v, max) {
  return String(v == null ? "" : v)
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeMessage(v) {
  return safeText(v, 180)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b\d{3,}\b/g, "#");
}

function makeSignature(body) {
  // Intentionally exclude title/user/device/full source URL:
  // same systemic error across users should be ONE GitHub row.
  const normalized = [
    safeText(body.code, 40).toUpperCase(),
    safeText(body.step, 50).toLowerCase(),
    Number(body.status) || 0,
    safeText(body.sourceType, 20).toLowerCase(),
    safeText(body.cacheState, 50).toUpperCase(),
    safeText(body.generationState, 50).toUpperCase(),
    normalizeMessage(body.message),
    safeText(body.playerVersion, 40).toLowerCase()
  ].join("|");

  return createHash("sha256").update(normalized).digest("hex").slice(0, 20);
}

async function githubRequest(url, options = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.DIAGNOSTICS_GITHUB_TOKEN;
  if (!token) {
    const e = new Error("Diagnostics GitHub token is not configured");
    e.status = 500;
    throw e;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Bidamax-Player-Diagnostics",
        ...(options.headers || {})
      }
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      const timeoutError = new Error("Diagnostics GitHub request timed out");
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readFile() {
  const url =
    `https://api.github.com/repos/${encodeURIComponent(DEFAULT_OWNER)}` +
    `/${encodeURIComponent(DEFAULT_REPO)}/contents/${DEFAULT_PATH}` +
    `?ref=${encodeURIComponent(DEFAULT_BRANCH)}&t=${Date.now()}`;

  const response = await githubRequest(url, { method: "GET", cache: "no-store" });

  if (response.status === 404) {
    return {
      sha: null,
      data: { version: 1, updatedAt: null, errors: [] }
    };
  }

  if (!response.ok) {
    const e = new Error(`GitHub read failed (${response.status})`);
    e.status = response.status;
    throw e;
  }

  const meta = await response.json();
  let parsed = { version: 1, updatedAt: null, errors: [] };

  try {
    const raw = Buffer.from(meta.content || "", "base64").toString("utf8");
    const obj = JSON.parse(raw);
    if (obj && Array.isArray(obj.errors)) parsed = obj;
  } catch (_) {}

  return { sha: meta.sha || null, data: parsed };
}

async function writeFile(data, sha) {
  const url =
    `https://api.github.com/repos/${encodeURIComponent(DEFAULT_OWNER)}` +
    `/${encodeURIComponent(DEFAULT_REPO)}/contents/${DEFAULT_PATH}`;

  const payload = {
    message: "Update Bidamax player diagnostics",
    content: Buffer.from(JSON.stringify(data, null, 2) + "\n", "utf8").toString("base64"),
    branch: DEFAULT_BRANCH
  };

  if (sha) payload.sha = sha;

  const response = await githubRequest(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const e = new Error(`GitHub write failed (${response.status})`);
    e.status = response.status;
    throw e;
  }
}

async function saveUnique(body) {
  const signature = makeSignature(body);

  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readFile();
    const errors = Array.isArray(current.data.errors) ? current.data.errors : [];

    // Key money-saving behavior:
    // if this error already exists, return immediately WITHOUT a GitHub PUT.
    if (errors.some(item => item && item.signature === signature)) {
      return { duplicate: true, signature };
    }

    const now = new Date().toISOString();
    const entry = {
      signature,
      code: safeText(body.code || "PLAYER_ERROR", 40).toUpperCase(),
      step: safeText(body.step || "player", 50),
      status: Number(body.status) || 0,
      sourceType: safeText(body.sourceType || "unknown", 20),
      cacheState: safeText(body.cacheState || "", 50),
      generationState: safeText(body.generationState || "", 50),
      message: safeText(body.message || "", 180),
      playerVersion: safeText(body.playerVersion || "", 40),
      sampleTitle: safeText(body.title || "", 120),
      requestId: safeText(body.requestId || "", 80),
      firstSeen: now
    };

    const nextErrors = [entry, ...errors].slice(0, MAX_ERRORS);
    const next = {
      version: 1,
      updatedAt: now,
      errors: nextErrors
    };

    try {
      await writeFile(next, current.sha);
      return { duplicate: false, signature };
    } catch (e) {
      // GitHub SHA conflict from simultaneous first-time errors:
      // re-read once, which also lets us detect if another request already saved it.
      if ((e.status === 409 || e.status === 422) && attempt < 2) {
        await sleep(120 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }

  return { duplicate: true, signature };
}

function enqueueSave(body) {
  const task = diagnosticsQueue.then(
    () => saveUnique(body),
    () => saveUnique(body)
  );
  diagnosticsQueue = task.then(
    () => undefined,
    () => undefined
  );
  globalThis.__BIDAMAX_DIAGNOSTICS_QUEUE__ = diagnosticsQueue;
  return task;
}

function parseBody(req) {
  let raw;

  try {
    raw = req.body;
  } catch (_) {
    const error = new Error("Invalid JSON payload");
    error.status = 400;
    throw error;
  }

  if (raw === null || raw === undefined || raw === "") return {};

  if (typeof raw === "string") {
    if (raw.length > MAX_BODY_LENGTH) {
      const error = new Error("Diagnostics payload is too large");
      error.status = 413;
      throw error;
    }
    try {
      return JSON.parse(raw);
    } catch (_) {
      const error = new Error("Invalid JSON payload");
      error.status = 400;
      throw error;
    }
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    const error = new Error("Invalid diagnostics payload");
    error.status = 400;
    throw error;
  }
  return raw;
}

export default async function handler(req, res) {
  cors(req, res);

  const origin = normalizeOrigin(req.headers.origin);
  if (!isAllowedOrigin(origin)) {
    return json(res, 403, { error: "Origin not allowed" });
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Cache-Control", "no-store");
    return res.end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return json(res, 405, { error: "Method not allowed" });
  }

  try {
    const body = parseBody(req);
    const result = await enqueueSave(body);
    return json(res, 200, { ok: true, ...result });
  } catch (e) {
    console.error("[BidamaxDiagnostics]", e);

    if (e && (e.status === 400 || e.status === 413)) {
      return json(res, e.status, { ok: false, error: e.message });
    }
    return json(res, 500, { ok: false, error: "Diagnostics unavailable" });
  }
}
