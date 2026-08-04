import crypto from "node:crypto";

const MAX_COMMENTS = 200;
const MAX_TEXT = 400;

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
  if (!response.ok || !data || data.error) throw new Error(data?.error || `Redis error ${response.status}`);
  return data.result;
}

function clean(value, max = MAX_TEXT) {
  return String(value || "").trim().slice(0, max);
}
function commentsKey(contentKey) { return `bidamax:comments:v1:${contentKey}`; }
function profileKey(userId) { return `bidamax:profile:v1:${userId}`; }
async function readJson(key, fallback) {
  const raw = await redis(["GET", key]);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
async function writeJson(key, value) { await redis(["SET", key, JSON.stringify(value)]); }
async function profile(userId) {
  return await readJson(profileKey(userId), { username: "User", avatar: "" });
}

async function hydrate(comments) {
  const profileCache = new Map();
  async function get(uid) {
    if (!profileCache.has(uid)) profileCache.set(uid, await profile(uid));
    return profileCache.get(uid);
  }
  for (const comment of comments) {
    const p = await get(comment.user_id);
    comment.username = p.username || "User";
    comment.avatar = p.avatar || "";
    comment.replies = Array.isArray(comment.replies) ? comment.replies : [];
    for (const reply of comment.replies) {
      const rp = await get(reply.user_id);
      reply.username = rp.username || "User";
      reply.avatar = rp.avatar || "";
    }
    comment.reply_count = comment.replies.length;
  }
  return comments;
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const contentKey = clean(req.query?.content_key, 160);
      if (!contentKey) return json(res, 400, { error: "content_key is required" });
      const comments = await readJson(commentsKey(contentKey), []);
      comments.sort((a,b) => Number(b.created_at || 0) - Number(a.created_at || 0));
      return json(res, 200, { comments: await hydrate(comments.slice(0, MAX_COMMENTS)) });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return json(res, 405, { error: "Method not allowed" });
    }

    const body = req.body || {};
    const action = clean(body.action, 40);
    const userId = clean(body.user_id, 120);
    if (!action || !userId) return json(res, 400, { error: "action and user_id are required" });

    if (action === "profile") {
      const username = clean(body.username, 40);
      if (!username) return json(res, 400, { error: "Username is required" });
      await writeJson(profileKey(userId), { username, avatar: String(body.avatar || "").slice(0, 800000) });
      return json(res, 200, { ok: true });
    }

    const contentKey = clean(body.content_key, 160);
    if (!contentKey) return json(res, 400, { error: "content_key is required" });
    const key = commentsKey(contentKey);
    const comments = await readJson(key, []);
    const message = clean(body.message);
    const commentId = clean(body.comment_id, 100);
    const replyId = clean(body.reply_id, 100);

    if (action === "comment") {
      if (!message) return json(res, 400, { error: "Comment is empty" });
      comments.unshift({ id: crypto.randomUUID(), user_id: userId, message, created_at: Date.now(), replies: [] });
      if (comments.length > MAX_COMMENTS) comments.length = MAX_COMMENTS;
    } else if (action === "reply") {
      if (!message) return json(res, 400, { error: "Reply is empty" });
      const comment = comments.find(x => x.id === commentId);
      if (!comment) return json(res, 404, { error: "Comment not found" });
      comment.replies = Array.isArray(comment.replies) ? comment.replies : [];
      comment.replies.push({ id: crypto.randomUUID(), user_id: userId, message, created_at: Date.now() });
    } else if (action === "edit_comment") {
      if (!message) return json(res, 400, { error: "Comment is empty" });
      const comment = comments.find(x => x.id === commentId);
      if (!comment) return json(res, 404, { error: "Comment not found" });
      if (comment.user_id !== userId) return json(res, 403, { error: "Not allowed" });
      comment.message = message;
      comment.edited_at = Date.now();
    } else if (action === "delete_comment") {
      const index = comments.findIndex(x => x.id === commentId);
      if (index < 0) return json(res, 404, { error: "Comment not found" });
      if (comments[index].user_id !== userId) return json(res, 403, { error: "Not allowed" });
      comments.splice(index, 1);
    } else if (action === "edit_reply") {
      if (!message) return json(res, 400, { error: "Reply is empty" });
      const comment = comments.find(x => x.id === commentId);
      const reply = comment?.replies?.find(x => x.id === replyId);
      if (!reply) return json(res, 404, { error: "Reply not found" });
      if (reply.user_id !== userId) return json(res, 403, { error: "Not allowed" });
      reply.message = message;
      reply.edited_at = Date.now();
    } else if (action === "delete_reply") {
      const comment = comments.find(x => x.id === commentId);
      if (!comment || !Array.isArray(comment.replies)) return json(res, 404, { error: "Reply not found" });
      const index = comment.replies.findIndex(x => x.id === replyId);
      if (index < 0) return json(res, 404, { error: "Reply not found" });
      if (comment.replies[index].user_id !== userId) return json(res, 403, { error: "Not allowed" });
      comment.replies.splice(index, 1);
    } else {
      return json(res, 400, { error: "Unknown action" });
    }

    await writeJson(key, comments);
    return json(res, 200, { ok: true });
  } catch (error) {
    console.error("[comments]", error);
    return json(res, 500, { error: error.message || "Comments request failed" });
  }
}
