// Vercel Edge Function: same-origin fallback for the GitHub API / release downloads,
// used only when the browser can't reach GitHub directly (CORS, school filters...).
// Streams the file through, so the 4.5 MB serverless body limit doesn't apply.
// Optional env var GITHUB_TOKEN (no scopes) avoids GitHub's per-IP rate limit.
export const config = { runtime: 'edge' };
const REPO = 'Mason363/NumPlay';

export default async function handler(req) {
  const url = new URL(req.url);
  const headers = { 'User-Agent': 'numflash', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;

  const id = url.searchParams.get('id');
  if (id) {
    if (!/^\d{1,15}$/.test(id)) return new Response('bad id', { status: 400 });
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${id}`, { headers: { ...headers, Accept: 'application/octet-stream' } });
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=3600', ...(r.headers.get('content-length') ? { 'content-length': r.headers.get('content-length') } : {}) } });
  }
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers });
  return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' } });
}
