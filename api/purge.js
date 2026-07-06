import { checkAuth, purgeCache } from "./shared.js";

export default function handler(req, res) {
  if (!checkAuth(req, res)) return;

  const target = req.query?.target || "all";
  const deleted = purgeCache(target);

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ ok: true, target, deleted });
}
