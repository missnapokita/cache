import { getDataRawUrl, isSafeId, serveCachedJson } from "./shared.js";

export default async function handler(req, res) {
  const id = req.query ? req.query.id : "";

  if (!isSafeId(id)) {
    res.status(400).json({ error: "Missing or invalid id" });
    return;
  }

  await serveCachedJson(req, res, {
    url: getDataRawUrl(`seasons/${id}.json`),
    cacheKey: `seasons:${id}`,
    ttlSeconds: Number(process.env.SEASONS_TTL || 3600),
    staleSeconds: 86400
  });
}
