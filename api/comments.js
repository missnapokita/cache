import crypto from "node:crypto";

const MAX_COMMENTS = 200;
const MAX_LENGTH = 400;
const LOCK_TTL_SECONDS = 15;
const WAIT_DELAY_MS = 120;
const WAIT_ATTEMPTS = 20;

const BAD_WORDS = [
  "putangina", "putang ina", "tangina", "tang ina", "pakyu",
  "fuck", "fucking", "shit", "bitch", "asshole", "gago", "gaga",
  "bobo", "tanga", "ulol", "hayop ka", "leche", "lintik", "kupal",
  "tarantado", "inutil", "punyeta", "kantot", "iyot", "jakol",
  "porn", "porno"
];

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function redisConfig() {
  return {
    url:
      process.env.KV_REST_API_URL ||
      process.env.UPSTASH_REDIS_REST_URL,
    token:
      process.env.KV_REST_API_TOKEN ||
      process.env.UPSTASH_REDIS_REST_TOKEN
  };
}

async function redis(command) {
  const { url, token } = redisConfig();

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
      data?.error || `Redis error (${response.status})`
    );
  }

  return data.result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/@/g, "a")
    .replace(/\$/g, "s")
    .replace(/(.)\1{2,}/g, "$1$1")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function hasBadWords(value) {
  const normalized = normalize(value);
  const compact = normalized.replace(/ /g, "");

  return BAD_WORDS.some((entry) => {
    const word = normalize(entry);

    if (word.includes(" ")) {
      return normalized.includes(word);
    }

    const escaped = word.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

    const boundary = new RegExp(
      `(^|\\s)${escaped}($|\\s)`
    );

    return (
      boundary.test(normalized) ||
      (word.length >= 5 && compact.includes(word))
    );
  });
}

function commentsKey(contentKey) {
  return `bidamax:comments:v2:${
    crypto
      .createHash("sha256")
      .update(contentKey)
      .digest("hex")
  }`;
}

function profileKey(userId) {
  return `bidamax:profile:v1:${userId}`;
}

function lockKey(contentKey) {
  return `${commentsKey(contentKey)}:lock`;
}

async function readComments(contentKey) {
  const raw = await redis(["GET", commentsKey(contentKey)]);

  if (!raw) return [];

  try {
    const list =
      typeof raw === "string" ? JSON.parse(raw) : raw;

    if (!Array.isArray(list)) return [];

    return list
      .filter(
        (comment) =>
          comment &&
          !comment.hidden &&
          !hasBadWords(comment.message)
      )
      .map((comment) => ({
        ...comment,
        replies: Array.isArray(comment.replies)
          ? comment.replies.filter(
              (reply) =>
                reply &&
                !reply.hidden &&
                !hasBadWords(reply.message)
            )
          : []
      }));
  } catch {
    return [];
  }
}

async function saveComments(contentKey, list) {
  await redis([
    "SET",
    commentsKey(contentKey),
    JSON.stringify(list.slice(0, MAX_COMMENTS))
  ]);
}

async function readProfile(userId) {
  if (!userId) return null;

  const raw = await redis(["GET", profileKey(userId)]);

  if (!raw) return null;

  try {
    const parsed =
      typeof raw === "string" ? JSON.parse(raw) : raw;

    return {
      username: String(parsed?.username || "").trim(),
      avatar: String(parsed?.avatar || "")
    };
  } catch {
    return null;
  }
}

async function hydrateProfile(item, cache) {
  const userId = String(item?.user_id || "").trim();

  if (!userId) {
    return {
      ...item,
      username: item?.username || "User",
      avatar: item?.avatar || ""
    };
  }

  if (!cache.has(userId)) {
    cache.set(userId, await readProfile(userId));
  }

  const profile = cache.get(userId);

  return {
    ...item,
    username:
      profile?.username ||
      item?.username ||
      "User",
    avatar:
      profile?.avatar ||
      item?.avatar ||
      ""
  };
}

async function hydrateComments(list) {
  const profiles = new Map();
  const result = [];

  for (const comment of list) {
    const hydratedComment =
      await hydrateProfile(comment, profiles);

    hydratedComment.replies = [];

    for (const reply of comment.replies || []) {
      hydratedComment.replies.push(
        await hydrateProfile(reply, profiles)
      );
    }

    result.push(hydratedComment);
  }

  return result;
}

async function withCommentsLock(contentKey, task) {
  const key = lockKey(contentKey);
  const token = crypto.randomUUID();

  for (
    let attempt = 0;
    attempt < WAIT_ATTEMPTS;
    attempt += 1
  ) {
    const acquired = await redis([
      "SET",
      key,
      token,
      "NX",
      "EX",
      String(LOCK_TTL_SECONDS)
    ]);

    if (acquired === "OK") {
      try {
        return await task();
      } finally {
        const current = await redis(["GET", key]).catch(
          () => null
        );

        if (current === token) {
          await redis(["DEL", key]).catch(() => null);
        }
      }
    }

    await sleep(WAIT_DELAY_MS);
  }

  throw new Error("Comments are busy. Please try again.");
}

function findReply(list, commentId, parentId) {
  if (parentId) {
    const parent = list.find(
      (comment) => comment.id === parentId
    );

    if (!parent) return null;

    const replyIndex = (parent.replies || []).findIndex(
      (reply) => reply.id === commentId
    );

    if (replyIndex < 0) return null;

    return {
      parent,
      reply: parent.replies[replyIndex],
      replyIndex
    };
  }

  for (const parent of list) {
    const replyIndex = (parent.replies || []).findIndex(
      (reply) => reply.id === commentId
    );

    if (replyIndex >= 0) {
      return {
        parent,
        reply: parent.replies[replyIndex],
        replyIndex
      };
    }
  }

  return null;
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const contentKey = String(
        req.query?.content_key || ""
      ).trim();

      if (!contentKey) {
        return json(res, 400, {
          error: "content_key is required"
        });
      }

      const comments = await readComments(contentKey);

      // Always attach the latest public profile here. This makes
      // profile edits visible to every user, including old comments.
      return json(res, 200, {
        comments: await hydrateComments(comments)
      });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");

      return json(res, 405, {
        error: "Method not allowed"
      });
    }

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body || {};

    const action = String(body.action || "").trim();
    const userId = String(body.user_id || "").trim();

    if (!userId) {
      return json(res, 400, {
        error: "user_id is required"
      });
    }

    if (action === "profile") {
      const username = String(
        body.username || ""
      ).trim().slice(0, 24);

      const avatar = String(body.avatar || "");

      if (username.length < 2) {
        return json(res, 400, {
          error: "Invalid username"
        });
      }

      await redis([
        "SET",
        profileKey(userId),
        JSON.stringify({ username, avatar })
      ]);

      return json(res, 200, { ok: true });
    }

    const contentKey = String(
      body.content_key || ""
    ).trim();

    if (!contentKey) {
      return json(res, 400, {
        error: "content_key is required"
      });
    }

    return await withCommentsLock(
      contentKey,
      async () => {
        const list = await readComments(contentKey);

        if (action === "comment") {
          const message = String(
            body.message || ""
          ).trim().slice(0, MAX_LENGTH);

          if (!message) {
            return json(res, 400, {
              error: "Comment is empty"
            });
          }

          if (hasBadWords(message)) {
            return json(res, 422, {
              error: "Inappropriate words detected"
            });
          }

          const profile =
            (await readProfile(userId)) || {
              username: "User",
              avatar: ""
            };

          list.unshift({
            id: crypto.randomUUID(),
            user_id: userId,
            username: profile.username || "User",
            avatar: profile.avatar || "",
            message,
            created_at: Date.now(),
            replies: []
          });

          await saveComments(contentKey, list);

          return json(res, 200, { ok: true });
        }

        if (action === "reply") {
          const parentId = String(
            body.parent_id ||
            body.comment_id ||
            ""
          ).trim();

          const parent = list.find(
            (comment) => comment.id === parentId
          );

          if (!parent) {
            return json(res, 404, {
              error: "Comment not found"
            });
          }

          const message = String(
            body.message || ""
          ).trim().slice(0, MAX_LENGTH);

          if (!message) {
            return json(res, 400, {
              error: "Reply is empty"
            });
          }

          if (hasBadWords(message)) {
            return json(res, 422, {
              error: "Inappropriate words detected"
            });
          }

          const profile =
            (await readProfile(userId)) || {
              username: "User",
              avatar: ""
            };

          if (!Array.isArray(parent.replies)) {
            parent.replies = [];
          }

          parent.replies.push({
            id: crypto.randomUUID(),
            parent_id: parent.id,
            user_id: userId,
            username: profile.username || "User",
            avatar: profile.avatar || "",
            message,
            created_at: Date.now()
          });

          await saveComments(contentKey, list);

          return json(res, 200, { ok: true });
        }

        const commentId = String(
          body.comment_id || ""
        ).trim();

        const parentId = String(
          body.parent_id || ""
        ).trim();

        const rootIndex = list.findIndex(
          (comment) => comment.id === commentId
        );

        const nested =
          rootIndex < 0
            ? findReply(list, commentId, parentId)
            : null;

        if (rootIndex < 0 && !nested) {
          return json(res, 404, {
            error: "Comment not found"
          });
        }

        const target =
          rootIndex >= 0
            ? list[rootIndex]
            : nested.reply;

        // Ownership restriction applies only to Edit/Delete,
        // never to Reply.
        if (target.user_id !== userId) {
          return json(res, 403, {
            error: "You can only modify your own comment"
          });
        }

        if (action === "edit") {
          const message = String(
            body.message || ""
          ).trim().slice(0, MAX_LENGTH);

          if (!message) {
            return json(res, 400, {
              error: "Comment is empty"
            });
          }

          if (hasBadWords(message)) {
            return json(res, 422, {
              error: "Inappropriate words detected"
            });
          }

          target.message = message;
          target.edited_at = Date.now();

          await saveComments(contentKey, list);

          return json(res, 200, { ok: true });
        }

        if (action === "delete") {
          if (rootIndex >= 0) {
            list.splice(rootIndex, 1);
          } else {
            nested.parent.replies.splice(
              nested.replyIndex,
              1
            );
          }

          await saveComments(contentKey, list);

          return json(res, 200, { ok: true });
        }

        return json(res, 400, {
          error: "Unknown action"
        });
      }
    );
  } catch (error) {
    console.error("[comments-api]", error);

    return json(res, 500, {
      error:
        error?.message ||
        "Comments service failed"
    });
  }
}
