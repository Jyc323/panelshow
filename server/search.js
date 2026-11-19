// Web search for members (@@web). Off unless PANELSHOW_SEARCH names a provider.
// Rules: a key, if any, comes only from the environment and is never logged or returned;
// queries go only to the provider configured in .env; results are shown to members as reference material.
import { config } from './config.js';
import { readableBody } from './gmi.js';

const env = process.env;

/**
 * Each provider: where it lives, whether it needs a key, which environment variable may hold that key,
 * and how to turn one query into a request and its answer into [{ title, url, snippet }].
 */
export const PROVIDERS = {
  firecrawl: {
    name: 'Firecrawl',
    url: 'https://api.firecrawl.dev',
    keyEnv: 'FIRECRAWL_API_KEY',
    needsKey: false, // keyless use is free within a per-IP limit
    request: (base, query, count, key) => ({
      url: `${base}/v2/search`,
      init: { method: 'POST', headers: json(key ? { Authorization: `Bearer ${key}` } : {}), body: JSON.stringify({ query, limit: count }) },
    }),
    parse: (j) => (j.data?.web || (Array.isArray(j.data) ? j.data : [])).map((r) => ({ title: r.title, url: r.url, snippet: r.description || r.snippet })),
  },
  tavily: {
    name: 'Tavily',
    url: 'https://api.tavily.com',
    keyEnv: 'TAVILY_API_KEY',
    needsKey: true,
    request: (base, query, count, key) => ({
      url: `${base}/search`,
      init: { method: 'POST', headers: json({ Authorization: `Bearer ${key}` }), body: JSON.stringify({ query, max_results: count, search_depth: 'basic' }) },
    }),
    parse: (j) => (j.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })),
  },
  exa: {
    name: 'Exa',
    url: 'https://api.exa.ai',
    keyEnv: 'EXA_API_KEY',
    needsKey: true,
    request: (base, query, count, key) => ({
      url: `${base}/search`,
      init: { method: 'POST', headers: json({ 'x-api-key': key }), body: JSON.stringify({ query, type: 'auto', numResults: count, contents: { highlights: true } }) },
    }),
    parse: (j) => (j.results || []).map((r) => ({ title: r.title, url: r.url, snippet: [r.publishedDate ? String(r.publishedDate).slice(0, 10) : '', (r.highlights || []).join(' … ') || r.text || r.summary || ''].filter(Boolean).join(' · ') })),
  },
  ollama: {
    name: 'Ollama web search',
    url: 'https://ollama.com',
    keyEnv: 'OLLAMA_API_KEY',
    needsKey: true,
    request: (base, query, count, key) => ({
      url: `${base}/api/web_search`,
      init: { method: 'POST', headers: json({ Authorization: `Bearer ${key}` }), body: JSON.stringify({ query, max_results: Math.min(count, 10) }) },
    }),
    parse: (j) => (j.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })),
  },
  searxng: {
    name: 'SearXNG',
    url: '', // your own instance: PANELSHOW_SEARCH_URL
    keyEnv: '',
    needsKey: false,
    request: (base, query) => ({ url: `${base}/search?${new URLSearchParams({ q: query, format: 'json' })}`, init: { method: 'GET', headers: { Accept: 'application/json' } } }),
    parse: (j) => (j.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })),
  },
};

function json(extra) {
  return { 'Content-Type': 'application/json', Accept: 'application/json', ...extra };
}

/** The provider name from PANELSHOW_SEARCH: empty or "off" turns search off; "on" means Firecrawl without a key. */
export function providerId() {
  const v = String(config.search || '').trim().toLowerCase();
  if (!v || ['off', '0', 'none', 'false'].includes(v)) return '';
  if (['on', '1', 'true'].includes(v)) return 'firecrawl';
  return v;
}

function keyFor(p) {
  return config.searchKey || (p.keyEnv ? env[p.keyEnv] || '' : '');
}

/** What the page and the prompt may know: on or off, which provider, and why it does not work. Never the key. */
export function searchStatus() {
  const id = providerId();
  if (!id) return { enabled: false };
  const p = PROVIDERS[id];
  if (!p) return { enabled: false, provider: id, error: `Unknown search provider "${id}". Use one of: ${Object.keys(PROVIDERS).join(', ')}.` };
  const base = (config.searchUrl || p.url).replace(/\/+$/, '');
  if (!base) return { enabled: false, provider: id, name: p.name, error: `${p.name} needs the address of your instance in PANELSHOW_SEARCH_URL.` };
  const key = keyFor(p);
  if (p.needsKey && !key) return { enabled: false, provider: id, name: p.name, error: `${p.name} needs a key: set PANELSHOW_SEARCH_KEY (or ${p.keyEnv}).` };
  return { enabled: true, provider: id, name: p.name, keyless: !key, host: hostOf(base) };
}

const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

const clean = (s, n) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * One web search.
 * @returns {Promise<{ok: true, provider: string, results: {title: string, url: string, snippet: string}[]} | {ok: false, error: string}>}
 */
export async function webSearch(query, { signal, count = config.searchResults } = {}) {
  const q = clean(query, 300);
  if (!q) return { ok: false, error: 'empty search' };
  const st = searchStatus();
  if (!st.enabled) return { ok: false, error: st.error || 'web search is off in this PanelShow (the Host can turn it on with PANELSHOW_SEARCH in .env)' };
  const p = PROVIDERS[st.provider];
  const base = (config.searchUrl || p.url).replace(/\/+$/, '');
  const { url, init } = p.request(base, q, count, keyFor(p));
  const t = AbortSignal.timeout(config.searchTimeoutMs);
  let res;
  try {
    res = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, t]) : t });
  } catch (e) {
    if (signal?.aborted) throw e;
    return { ok: false, error: t.aborted ? `${p.name} did not answer within ${Math.round(config.searchTimeoutMs / 1000)} s` : `could not reach ${p.name} (${e.cause?.code || e.message})` };
  }
  const text = await res.text().catch(() => '');
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const detail = j ? j.error?.message || j.error || j.message || j.detail || text : readableBody(text);
    const hint = res.status === 429 ? ' (search limit reached; try again later, or add a key)' : res.status === 401 || res.status === 403 ? ' (check the search key)' : '';
    return { ok: false, error: `${p.name} ${res.status}: ${clean(typeof detail === 'string' ? detail : JSON.stringify(detail), 300)}${hint}` };
  }
  if (!j) return { ok: false, error: `${p.name} sent something that is not JSON` + (st.provider === 'searxng' ? ' (enable the json format in SearXNG settings.yml)' : '') };
  const seen = new Set();
  const results = [];
  for (const r of p.parse(j)) {
    const link = String(r.url || '');
    if (!/^https?:\/\//i.test(link) || seen.has(link)) continue;
    seen.add(link);
    results.push({ title: clean(r.title, 200) || hostOf(link), url: link, snippet: clean(r.snippet, 400) });
    if (results.length >= count) break;
  }
  return { ok: true, provider: p.name, results };
}

/** The search results as a RESOURCE body for a member. */
export function renderSearch(query, r) {
  if (!r.results.length) return `No results for "${query}". Try other words.`;
  return `${r.results.length} results from ${r.provider} for "${query}". These are search snippets, not the pages: open a page with @@open before you rely on it, and cite its address.\n\n${r.results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}${x.snippet ? `\n   ${x.snippet}` : ''}`).join('\n\n')}`;
}
