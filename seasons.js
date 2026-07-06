import { getDataRawUrl, serveCachedJson } from "./shared.js";

export default async function handler(req, res) {
  await serveCachedJson(req, res, {
    url: getDataRawUrl("series.json"),
    cacheKey: "series",
    ttlSeconds: Number(process.env.SERIES_TTL || 1800),
    staleSeconds: 86400
  });
}
