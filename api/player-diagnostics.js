const crypto = require("crypto");

const DEFAULT_OWNER = process.env.DIAGNOSTICS_GITHUB_OWNER || "missnapokita";
const DEFAULT_REPO = process.env.DIAGNOSTICS_GITHUB_REPO || "cache";
const DEFAULT_BRANCH = process.env.DIAGNOSTICS_GITHUB_BRANCH || "main";
const DEFAULT_PATH = process.env.DIAGNOSTICS_GITHUB_PATH || "database/player_errors.json";
const MAX_ERRORS = Math.max(50, Math.min(Number(process.env.DIAGNOSTICS_MAX_ERRORS || 300), 1000));

function cors(req, res) {
  const allowed = new Set([
    "https://mamamo-gray.vercel.app",
    "https://missnapokita.github.io"
  ]);

  const extra = String(process.env.BIDAMAX_PLAYER_ORIGINS || "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);

  extra.forEach(v => allowed.add(v));

  const origin = req.headers.origin || "";
  if (allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
    normalizeMessage(body.message),
    safeText(body.playerVersion, 40).toLowerCase()
  ].join("|");

  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 20);
}

async function githubRequest(url, options = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.DIAGNOSTICS_GITHUB_TOKEN;
  if (!token) {
    const e = new Error("Diagnostics GitHub token is not configured");
    e.status = 500;
    throw e;
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Bidamax-Player-Diagnostics",
      ...(options.headers || {})
    }
  });

  return response;
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

  for (let attempt = 0; attempt < 2; attempt++) {
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
      message: safeText(body.message || "", 180),
      playerVersion: safeText(body.playerVersion || "", 40),
      sampleTitle: safeText(body.title || "", 120),
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
      if ((e.status === 409 || e.status === 422) && attempt === 0) continue;
      throw e;
    }
  }

  return { duplicate: true, signature };
}

module.exports = async function handler(req, res) {
  cors(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  const origin = req.headers.origin || "";
  const allowedOrigins = [
    "https://mamamo-gray.vercel.app",
    "https://missnapokita.github.io",
    ...String(process.env.BIDAMAX_PLAYER_ORIGINS || "").split(",").map(v => v.trim()).filter(Boolean)
  ];

  if (origin && !allowedOrigins.includes(origin)) {
    res.statusCode = 403;
    return res.end(JSON.stringify({ error: "Origin not allowed" }));
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const result = await saveUnique(body);

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, ...result }));
  } catch (e) {
    console.error("[BidamaxDiagnostics]", e);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ ok: false, error: "Diagnostics unavailable" }));
  }
};
