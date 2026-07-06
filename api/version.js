const { sendJsonFromGithub } = require('./shared');

module.exports = async function handler(req, res) {
  return sendJsonFromGithub(req, res, {
    owner: process.env.VERSION_GITHUB_OWNER || 'missnapokita',
    repo: process.env.VERSION_GITHUB_REPO || 'masterkit',
    branch: process.env.VERSION_GITHUB_BRANCH || 'main',
    basePath: '',
    filePath: 'version.json',
    cacheSeconds: 300,
    staleSeconds: 86400
  });
};
