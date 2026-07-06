import { getDataRawUrl, serveCachedJson } from "./shared.js";

export default async function handler(req, res) {
  await serveCachedJson(req, res, {
    url: getDataRawUrl("movies.json"),
    cacheKey: "movies",
    ttlSeconds: Number(process.env.MOVIES_TTL || 1800),
    staleSeconds: 86400
  });
}
