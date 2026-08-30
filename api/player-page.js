function cleanBase(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.statusCode = 405;
    return res.end("Method not allowed");
  }

  const base = cleanBase(
    process.env.BIDAMAX_PLAYER_URL ||
    "https://missnapokita.github.io/bidamax-player"
  );

  const params = new URLSearchParams();
  const src = String(req.query?.src || "").trim();
  const title = String(req.query?.title || "").trim();

  if (src) params.set("src", src);
  if (title) params.set("title", title);

  // no-store keeps player URL changes immediately switchable through Vercel env.
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = 302;
  res.setHeader("Location", `${base}/?${params.toString()}`);
  return res.end();
}
