const { sendJsonFromGithub, cleanId } = require('./shared');

module.exports = async function handler(req, res) {
  const id = cleanId(req.query.id);
  if (!id) return res.status(400).json({ error: true, message: 'Missing id' });

  return sendJsonFromGithub(req, res, {
    filePath: `seasons/${id}.json`,
    cacheSeconds: 3600,
    staleSeconds: 86400
  });
};
