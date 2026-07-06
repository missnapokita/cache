import { getVersionRawUrl, serveCachedJson } from "./shared.js";

export default async function handler(req, res) {
  await serveCachedJson(req, res, {
    url: getVersionRawUrl(),
    cacheKey: "version",
    ttlSeconds: Number(process.env.VERSION_TTL || 300),
    staleSeconds: 86400
  });
}
