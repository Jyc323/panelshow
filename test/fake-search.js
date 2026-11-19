// A stand-in for the web search providers (Firecrawl, Tavily, Exa, Ollama, SearXNG), used by the tests. It never leaves this computer.
import http from 'node:http';

const HITS = [
  { title: 'DriveBench: VLM robustness in driving', url: 'https://example.org/drivebench', text: 'A benchmark of VLMs under corrupted camera input.' },
  { title: 'nuScenes-C', url: 'https://example.org/nuscenes-c', text: 'Corruptions for nuScenes: fog, snow, <b>dropout</b>.' },
  { title: 'Duplicate of the first', url: 'https://example.org/drivebench', text: 'same address again' },
  { title: 'Not a web address', url: 'javascript:alert(1)', text: 'should be dropped' },
];

/**
 * @returns {Promise<{ url: string, requests: object[], fail: (status: number, body?: string, type?: string) => void, close: () => Promise<void> }>}
 */
export async function createFakeSearch() {
  const requests = [];
  const failures = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const u = new URL(req.url, 'http://x');
    const body = raw ? JSON.parse(raw) : {};
    const auth = req.headers.authorization || '';
    const xkey = req.headers['x-api-key'] || '';
    const provider = u.pathname === '/v2/search' ? 'firecrawl' : u.pathname === '/api/web_search' ? 'ollama' : req.method === 'GET' ? 'searxng' : xkey ? 'exa' : 'tavily';
    requests.push({ provider, method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), auth, xkey, body });
    const f = failures.shift();
    if (f) {
      res.writeHead(f.status, { 'Content-Type': f.type });
      return res.end(f.body);
    }
    const q = body.query || u.searchParams.get('q') || '';
    const n = body.limit || body.max_results || body.numResults || 10;
    const hits = q.includes('nothing') ? [] : HITS.slice(0, n);
    let out;
    if (provider === 'firecrawl') out = { success: true, data: { web: hits.map((h, i) => ({ url: h.url, title: h.title, description: h.text, position: i + 1 })) } };
    else if (provider === 'exa') out = { results: hits.map((h) => ({ title: h.title, url: h.url, publishedDate: '2026-03-04T00:00:00.000Z', highlights: [h.text] })) };
    else out = { results: hits.map((h) => ({ title: h.title, url: h.url, content: h.text })) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    fail: (status, body = JSON.stringify({ error: 'Rate limit exceeded' }), type = 'application/json') => failures.push({ status, body, type }),
    close: () => new Promise((r) => server.close(r)),
  };
}
