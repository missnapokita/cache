export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    backend: "BIDAMAX Vercel API",
    version: "v4"
  });
}
