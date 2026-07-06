const { sendJsonFromGithub } = require('./shared');

module.exports = async function handler(req, res) {
  return sendJsonFromGithub(req, res, {
    filePath: 'series.json',
    cacheSeconds: 600,
    staleSeconds: 86400
  });
};
