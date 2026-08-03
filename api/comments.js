import crypto from "node:crypto";

const MAX_COMMENTS = 200;
const COMMENT_COOLDOWN_SECONDS = 7;

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
  if (!url || !token) throw new Error("Redis environment variables are missing");
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.error) throw new Error(data?.error || `Redis failed (${response.status})`);
  return data.result;
}

function clean(value, max) {
  return String(value || "").trim().slice(0, max);
}

function validKey(key) {
  return /^(movie|series):[a-zA-Z0-9_-]{1,80}$/.test(key);
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const contentKey = clean(req.query?.content_key, 90);
      if (!validKey(contentKey)) return json(res, 400, { error: "Invalid content_key" });

      const raw = await redis(["LRANGE", `bidamax:comments:${contentKey}`, "0", String(MAX_COMMENTS - 1)]);
      const comments = [];
      const userIds = [];
      for (const value of raw || []) {
        try {
          const item = JSON.parse(value);
          comments.push(item);
          if (item.user_id && !userIds.includes(item.user_id)) userIds.push(item.user_id);
        } catch {}
      }

      let profiles = [];
      if (userIds.length) profiles = await redis(["MGET", ...userIds.map(id => `bidamax:profile:${id}`)]);
      const profileMap = new Map();
      userIds.forEach((id, index) => {
        try { profileMap.set(id, JSON.parse(profiles[index] || "{}")); } catch { profileMap.set(id, {}); }
      });

      const hydrated = comments.map(item => {
        const profile = profileMap.get(item.user_id) || {};
        return { ...item, username: profile.username || "User", avatar: profile.avatar || "" };
      });
      return json(res, 200, { comments: hydrated });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return json(res, 405, { error: "Method not allowed" });
    }

    const action = clean(req.body?.action, 20);
    const userId = clean(req.body?.user_id, 80);
    if (!/^[a-zA-Z0-9-]{10,80}$/.test(userId)) return json(res, 400, { error: "Invalid user_id" });

    if (action === "profile") {
      const username = clean(req.body?.username, 24);
      const avatar = clean(req.body?.avatar, 24000);
      if (username.length < 2) return json(res, 400, { error: "Username is too short" });
      if (avatar && !/^[A-Za-z0-9+/=]+$/.test(avatar)) return json(res, 400, { error: "Invalid avatar" });
      await redis(["SET", `bidamax:profile:${userId}`, JSON.stringify({ username, avatar, updated_at: Date.now() })]);
      return json(res, 200, { ok: true });
    }

    if (action === "comment") {
      const contentKey = clean(req.body?.content_key, 90);
      const message = clean(req.body?.message, 400);
      if (!validKey(contentKey)) return json(res, 400, { error: "Invalid content_key" });
      if (!message) return json(res, 400, { error: "Comment is empty" });

      const profile = await redis(["GET", `bidamax:profile:${userId}`]);
      if (!profile) return json(res, 401, { error: "Create a profile first" });

      const cooldownKey = `bidamax:comment-cooldown:${userId}`;
      const allowed = await redis(["SET", cooldownKey, "1", "NX", "EX", String(COMMENT_COOLDOWN_SECONDS)]);
      if (allowed !== "OK") return json(res, 429, { error: "Please wait before commenting again" });

      const item = {
        id: crypto.randomUUID(),
        user_id: userId,
        message,
        created_at: Date.now()
      };
      const listKey = `bidamax:comments:${contentKey}`;
      await redis(["LPUSH", listKey, JSON.stringify(item)]);
      await redis(["LTRIM", listKey, "0", String(MAX_COMMENTS - 1)]);
      return json(res, 200, { ok: true, comment: item });
    }

    return json(res, 400, { error: "Unknown action" });
  } catch (error) {
    console.error("[comments]", error);
    return json(res, 500, { error: "Comments service unavailable", message: error.message });
  }
}
