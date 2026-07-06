module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true, name: 'BIDAMAX API', time: new Date().toISOString() });
};
