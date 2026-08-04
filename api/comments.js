import crypto from "node:crypto";

const MAX_COMMENTS = 200;
const MAX_REPLIES = 100;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function cfg() {
  return {
    url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
  };
}

async function redis(command) {
  const { url, token } = cfg();
  if (!url || !token) throw new Error("Redis REST environment variables are missing");
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data || data.error) throw new Error(data?.error || `Redis failed (${r.status})`);
  return data.result;
}

const clean = (v, max = 400) => String(v || "").trim().slice(0, max);
const keySafe = (v) => clean(v, 180).replace(/[^a-zA-Z0-9:_-]/g, "_");
const commentKey = (contentKey) => `bidamax:comments:v2:${keySafe(contentKey)}`;
const repliesKey = (contentKey, commentId) => `bidamax:replies:v2:${keySafe(contentKey)}:${keySafe(commentId)}`;
const profileKey = (userId) => `bidamax:profile:v2:${keySafe(userId)}`;
const deletedKey = (contentKey) => `bidamax:comments:deleted:v2:${keySafe(contentKey)}`;

async function getProfile(userId) {
  const raw = await redis(["GET", profileKey(userId)]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function readJsonList(key, limit) {
  const rows = await redis(["LRANGE", key, "0", String(limit - 1)]);
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}

async function getComments(contentKey) {
  const comments = await readJsonList(commentKey(contentKey), MAX_COMMENTS);
  const deleted = await redis(["HGETALL", deletedKey(contentKey)]).catch(() => []);
  const deletedSet = new Set();
  if (Array.isArray(deleted)) for (let i = 0; i < deleted.length; i += 2) deletedSet.add(deleted[i]);

  const visible = comments.filter((c) => c && c.id && !deletedSet.has(c.id));
  await Promise.all(visible.map(async (c) => {
    const replies = await readJsonList(repliesKey(contentKey, c.id), MAX_REPLIES);
    c.replies = replies.reverse();
    c.reply_count = c.replies.length;
  }));
  return visible;
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const contentKey = clean(req.query?.content_key, 180);
      if (!contentKey) return json(res, 400, { error: "content_key is required" });
      return json(res, 200, { comments: await getComments(contentKey) });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return json(res, 405, { error: "Method not allowed" });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const action = clean(body.action, 40);
    const userId = keySafe(body.user_id);
    if (!userId) return json(res, 400, { error: "user_id is required" });

    if (action === "profile") {
      const username = clean(body.username, 24);
      const avatar = clean(body.avatar, 120000);
      if (username.length < 2) return json(res, 400, { error: "Username is too short" });
      const profile = { user_id: userId, username, avatar, updated_at: Date.now() };
      await redis(["SET", profileKey(userId), JSON.stringify(profile)]);
      return json(res, 200, { ok: true });
    }

    const contentKey = clean(body.content_key, 180);
    if (!contentKey) return json(res, 400, { error: "content_key is required" });
    const profile = await getProfile(userId);
    if (!profile) return json(res, 403, { error: "Create your profile first" });

    if (action === "comment") {
      const message = clean(body.message, 400);
      if (!message) return json(res, 400, { error: "Comment is empty" });
      const item = {
        id: crypto.randomUUID(), user_id: userId,
        username: profile.username, avatar: profile.avatar || "",
        message, created_at: Date.now(), reply_count: 0, replies: []
      };
      const key = commentKey(contentKey);
      await redis(["LPUSH", key, JSON.stringify(item)]);
      await redis(["LTRIM", key, "0", String(MAX_COMMENTS - 1)]);
      return json(res, 200, { ok: true, comment: item });
    }

    if (action === "reply") {
      const commentId = keySafe(body.comment_id);
      const message = clean(body.message, 400);
      if (!commentId || !message) return json(res, 400, { error: "Reply data is incomplete" });
      const reply = {
        id: crypto.randomUUID(), user_id: userId,
        username: profile.username, avatar: profile.avatar || "",
        message, created_at: Date.now()
      };
      const key = repliesKey(contentKey, commentId);
      await redis(["LPUSH", key, JSON.stringify(reply)]);
      await redis(["LTRIM", key, "0", String(MAX_REPLIES - 1)]);
      return json(res, 200, { ok: true, reply });
    }

    if (action === "delete_comment") {
      const commentId = keySafe(body.comment_id);
      if (!commentId) return json(res, 400, { error: "comment_id is required" });
      const comments = await readJsonList(commentKey(contentKey), MAX_COMMENTS);
      const found = comments.find((c) => c?.id === commentId);
      if (!found) return json(res, 404, { error: "Comment not found" });
      if (found.user_id !== userId) return json(res, 403, { error: "You can only delete your own comment" });
      await redis(["HSET", deletedKey(contentKey), commentId, String(Date.now())]);
      await redis(["DEL", repliesKey(contentKey, commentId)]).catch(() => null);
      return json(res, 200, { ok: true });
    }

    return json(res, 400, { error: "Unknown action" });
  } catch (error) {
    console.error("[comments-api]", error);
    return json(res, 500, { error: "Comments service failed", message: error.message || "Unknown error" });
  }
}
