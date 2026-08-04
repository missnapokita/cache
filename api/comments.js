import crypto from "node:crypto";

const MAX_COMMENTS = 200;
const MAX_LENGTH = 400;
const BAD_WORDS = [
  "putangina", "putang ina", "tangina", "tang ina", "pakyu", "fuck", "fucking",
  "shit", "bitch", "asshole", "gago", "gaga", "bobo", "tanga", "ulol", "hayop ka",
  "leche", "lintik", "kupal", "tarantado", "inutil", "punyeta", "kantot", "iyot",
  "jakol", "porn", "porno"
];

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function redisConfig() {
  return {
    url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
  };
}

async function redis(command) {
  const { url, token } = redisConfig();
  if (!url || !token) throw new Error("Redis REST environment variables are missing");
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.error) throw new Error(data?.error || `Redis error (${response.status})`);
  return data.result;
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e")
    .replace(/4/g, "a").replace(/5/g, "s").replace(/7/g, "t")
    .replace(/@/g, "a").replace(/\$/g, "s")
    .replace(/(.)\1{2,}/g, "$1$1")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function hasBadWords(value) {
  const normalized = normalize(value);
  const compact = normalized.replace(/ /g, "");
  return BAD_WORDS.some((entry) => {
    const word = normalize(entry);
    if (word.includes(" ")) return normalized.includes(word);
    const boundary = new RegExp(`(^|\\s)${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|\\s)`);
    return boundary.test(normalized) || (word.length >= 5 && compact.includes(word));
  });
}

function commentsKey(contentKey) {
  return `bidamax:comments:v2:${crypto.createHash("sha256").update(contentKey).digest("hex")}`;
}
function profileKey(userId) { return `bidamax:profile:v1:${userId}`; }

async function readComments(contentKey) {
  const raw = await redis(["GET", commentsKey(contentKey)]);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((c) => c && !c.hidden && !hasBadWords(c.message)) : [];
  } catch { return []; }
}

async function saveComments(contentKey, list) {
  await redis(["SET", commentsKey(contentKey), JSON.stringify(list.slice(0, MAX_COMMENTS))]);
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const contentKey = String(req.query?.content_key || "").trim();
      if (!contentKey) return json(res, 400, { error: "content_key is required" });
      return json(res, 200, { comments: await readComments(contentKey) });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return json(res, 405, { error: "Method not allowed" });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const action = String(body.action || "").trim();
    const userId = String(body.user_id || "").trim();
    if (!userId) return json(res, 400, { error: "user_id is required" });

    if (action === "profile") {
      const username = String(body.username || "").trim().slice(0, 24);
      const avatar = String(body.avatar || "");
      if (username.length < 2) return json(res, 400, { error: "Invalid username" });
      await redis(["SET", profileKey(userId), JSON.stringify({ username, avatar })]);
      return json(res, 200, { ok: true });
    }

    const contentKey = String(body.content_key || "").trim();
    if (!contentKey) return json(res, 400, { error: "content_key is required" });
    const list = await readComments(contentKey);

    if (action === "comment") {
      const message = String(body.message || "").trim().slice(0, MAX_LENGTH);
      if (!message) return json(res, 400, { error: "Comment is empty" });
      if (hasBadWords(message)) return json(res, 422, { error: "Inappropriate words detected" });
      const rawProfile = await redis(["GET", profileKey(userId)]);
      let profile = { username: "User", avatar: "" };
      try { if (rawProfile) profile = { ...profile, ...JSON.parse(rawProfile) }; } catch {}
      list.unshift({
        id: crypto.randomUUID(), user_id: userId, username: profile.username,
        avatar: profile.avatar, message, created_at: Date.now()
      });
      await saveComments(contentKey, list);
      return json(res, 200, { ok: true });
    }

    const commentId = String(body.comment_id || "").trim();
    const index = list.findIndex((c) => c.id === commentId);
    if (index < 0) return json(res, 404, { error: "Comment not found" });
    if (list[index].user_id !== userId) return json(res, 403, { error: "You can only modify your own comment" });

    if (action === "edit") {
      const message = String(body.message || "").trim().slice(0, MAX_LENGTH);
      if (!message) return json(res, 400, { error: "Comment is empty" });
      if (hasBadWords(message)) return json(res, 422, { error: "Inappropriate words detected" });
      list[index].message = message;
      list[index].edited_at = Date.now();
      await saveComments(contentKey, list);
      return json(res, 200, { ok: true });
    }

    if (action === "delete") {
      list.splice(index, 1);
      await saveComments(contentKey, list);
      return json(res, 200, { ok: true });
    }

    return json(res, 400, { error: "Unknown action" });
  } catch (error) {
    console.error("[comments-api]", error);
    return json(res, 500, { error: error.message || "Comments service failed" });
  }
}
