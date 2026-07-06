function cleanId(value) {
  const id = String(value || '').trim();
  if (!id || !/^[0-9A-Za-z_-]+$/.test(id)) return '';
  return id;
}

function checkApiKey(req) {
  const requiredKey = process.env.BIDAMAX_API_KEY;
  if (!requiredKey) return true;

  const headerKey =
    req.headers['x-bidamax-key'] ||
    req.headers['x-api-key'];
  const queryKey = req.query && req.query.key;
  return headerKey === requiredKey || queryKey === requiredKey;
}

function rawGithubUrl({ owner, repo, branch, basePath, filePath }) {
  const safeBase = (basePath || '').replace(/^\/+|\/+$/g, '');
  const safeFile = (filePath || '').replace(/^\/+|\/+$/g, '');
  const path = safeBase ? `${safeBase}/${safeFile}` : safeFile;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}

async function sendJsonFromGithub(req, res, options) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: true, message: 'Method not allowed' });
  if (!checkApiKey(req)) return res.status(401).json({ error: true, message: 'Unauthorized' });

  const owner = options.owner || process.env.CONTENT_GITHUB_OWNER || 'mlbb-injector';
  const repo = options.repo || process.env.CONTENT_GITHUB_REPO || 'maui';
  const branch = options.branch || process.env.CONTENT_GITHUB_BRANCH || 'main';
  const basePath = options.basePath !== undefined ? options.basePath : (process.env.CONTENT_GITHUB_BASE_PATH || 'database');
  const url = rawGithubUrl({ owner, repo, branch, basePath, filePath: options.filePath });

  try {
    const headers = { 'User-Agent': 'BIDAMAX-Vercel-Cache' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

    const gh = await fetch(url, { headers });
    const text = await gh.text();

    if (!gh.ok) {
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
      return res.status(gh.status).json({
        error: true,
        status: gh.status,
        message: `GitHub returned ${gh.status}`,
        file: options.filePath
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({ error: true, message: 'Invalid JSON from GitHub', file: options.filePath });
    }

    const cacheSeconds = options.cacheSeconds || 600;
    const staleSeconds = options.staleSeconds || 86400;

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${cacheSeconds}, stale-while-revalidate=${staleSeconds}`);
    return res.status(200).send(JSON.stringify(parsed));
  } catch (e) {
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(500).json({ error: true, message: 'Proxy error', file: options.filePath });
  }
}

module.exports = { cleanId, sendJsonFromGithub };
