// A stand-in for the GMI API, used by the tests and by `npm run demo`. It never leaves this computer.
import http from 'node:http';

const MODELS = ['demo/optimist', 'demo/skeptic', 'demo/writer', 'demo/reader', 'demo/text-only',
  // Extra vendors so smart invite has something to choose from (one per vendor).
  'northwind/atlas-3-pro', 'northwind/atlas-3-flash', 'lumen/lumen-2-thinking', 'orbit/orbit-4-max', 'kite/kite-2-mini', 'pixel/pixel-1-image', 'broken/broken-1-pro'];

// The casting director: pick one candidate per vendor from the list in the prompt.
function castingReply(user) {
  const seats = Number((user.match(/Pick (\d+) members/) || [, 5])[1]);
  const seen = new Set();
  const members = [];
  for (const m of user.matchAll(/^(\S+) \| vendor=(\S+) \| (\S+)/gm)) {
    if (seen.has(m[2]) || members.length >= seats) continue;
    seen.add(m[2]);
    const stem = m[1].split('/').pop().split('-')[0];
    members.push({ model: m[1], displayName: stem[0].toUpperCase() + stem.slice(1), role: `Angle ${members.length + 1}`, roleDescription: 'Look at the topic from this angle.', reason: `A ${m[3]} model from ${m[2]}.` });
  }
  return JSON.stringify({ members });
}
const textOf = (content) => (Array.isArray(content) ? content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : String(content || ''));
const hasImage = (messages) => messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));

function judgeReply(user) {
  const labels = [...new Set([...user.matchAll(/=== Candidate ([A-L]) ===/g)].map((m) => m[1]))];
  const names = [...(user.match(/criterion names: (.*?)\)/)?.[1] || '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const scores = [];
  labels.forEach((l, i) => names.forEach((n, k) => scores.push({ candidate: l, criterion: n, score: Math.max(1, 9 - i - (k % 2)) })));
  return JSON.stringify({ scores, ranking: labels, summary: `Candidate ${labels[0]} was the most specific; the others stayed general.`, issues: labels.map((l) => ({ candidate: l, issue: `Candidate ${l} gives no evidence for its main claim.` })) });
}

function personaReply(model, messages) {
  const system = textOf(messages[0]?.content);
  const last = textOf(messages[messages.length - 1]?.content);
  const all = messages.slice(1).map((m) => textOf(m.content)).join('\n');
  if (system.includes('impartial judge')) return judgeReply(last);
  if (system.includes('casting director')) return castingReply(last);
  if (last.startsWith('What colour is this square')) return 'Red.';
  const topic = ((all.match(/\[Host\]: ([^\n]*)/) || [, 'the topic'])[1].replace(/https?:\/\/\S+/g, '').replace(/@\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 70) || 'the topic');
  const others = [...new Set([...all.matchAll(/^\[([A-Za-z0-9_.-]+)\]:/gm)].map((m) => m[1]).filter((n) => n !== 'Host' && n !== 'System'))];
  if (model.includes('writer')) return `Here is a short written summary of the discussion so far.\n\n<<<FILE notes/summary.md>>>\n# Summary\n\nTopic: ${topic}\n\n- Point one\n- Point two\n<<<END FILE>>>\n\nI saved it as a file so everyone can read it.`;
  if (model.includes('reader')) {
    if (last.includes('Here is what you asked for')) return `I opened it. The material begins: "${(last.match(/Text:\n([^\n]{0,120})/) || last.match(/=== RESOURCE[^\n]*\n([^\n]{0,120})/) || [, 'nothing readable'])[1]}"`;
    const url = (all.match(/https?:\/\/[^\s)\]]+/) || [])[0];
    const file = (system.match(/^- (\S+) \((?:text|pdf|docx)/m) || [])[1];
    if (url && !all.includes('=== RESOURCE')) return `Let me look at that link first.\n@@open ${url}`;
    if (file && !all.includes(`file ${file}`)) return `Let me read the file first.\n@@read ${file}`;
    return `I have the material in front of me and it supports the Host's point about ${topic}.`;
  }
  if (model.includes('skeptic')) return others.length ? `I disagree with ${others[0]}: the claim about "${topic}" needs evidence, and nobody has given any yet.` : `Before we go further on "${topic}": what evidence do we have?`;
  if (model.includes('text-only')) return `I can only read text here. On "${topic}", my view is that the wording matters more than the pictures.`;
  return others.length ? `Building on ${others[others.length - 1]}: there is a strong upside to "${topic}", and I think we should try it.` : `I like "${topic}". Here is why it could work: it is simple, and it is cheap to test.`;
}

/**
 * @param {{ delayMs?: number }} options
 * @returns {Promise<{ url: string, requests: object[], queue: (model: string, ...replies: any[]) => void, close: () => Promise<void> }>}
 */
export async function createFakeGmi({ delayMs = 0 } = {}) {
  const requests = [];
  const queued = new Map();
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: MODELS.map((id) => ({ id })) }));
    }
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    requests.push({ url: req.url, auth: req.headers.authorization || '', body });
    const scripted = queued.get(body.model)?.shift();
    let reply = typeof scripted === 'function' ? scripted(body) : scripted;
    if (reply === undefined) {
      if (body.model.startsWith('broken/')) reply = { status: 400, error: { message: 'Invalid model name' } };
      else if (body.model.includes('text-only') && hasImage(body.messages)) reply = { status: 400, error: { message: 'Backend request failed with status 400', details: 'image_url is only supported by certain models' } };
      else reply = personaReply(body.model, body.messages);
    }
    if (reply && typeof reply === 'object' && 'json' in reply) {
      // a non-streamed answer
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: reply.json }, finish_reason: 'stop' }] }));
    }
    let contentType = 'text/event-stream';
    if (reply && typeof reply === 'object' && 'mislabeled' in reply) {
      // a stream whose header wrongly says JSON (seen from a real provider)
      contentType = 'application/json';
      reply = reply.mislabeled;
    }
    if (typeof reply === 'object') {
      res.writeHead(reply.status || 500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: reply.error }));
    }
    res.writeHead(200, { 'Content-Type': contentType });
    const size = Math.max(8, Math.ceil(reply.length / 12));
    for (let i = 0; i < reply.length; i += size) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.slice(i, i + size) } }] })}\n\n`);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: Math.ceil(reply.length / 4) } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    queue: (model, ...replies) => queued.set(model, [...(queued.get(model) || []), ...replies]),
    close: () => new Promise((r) => server.close(r)),
  };
}
