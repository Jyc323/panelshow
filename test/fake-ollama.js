// A stand-in Ollama server for tests: /api/tags, /api/show and a streamed /api/chat (NDJSON).
import http from 'node:http';

const MODELS = {
  'qwen3:8b': { capabilities: ['completion', 'thinking'], ctx: 40960 },
  'llava:7b': { capabilities: ['completion', 'vision'], ctx: 4096 },
  'nomic-embed-text:latest': { capabilities: ['embedding'], ctx: 2048 },
};

export async function createFakeOllama({ delayMs = 15 } = {}) {
  const requests = [];
  let inflight = 0;
  const stats = { maxInflight: 0 };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ url: req.url, body });
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ models: Object.keys(MODELS).map((name) => ({ name, model: name })) }));
    }
    if (req.url === '/api/show') {
      const m = MODELS[body.model];
      if (!m) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `model '${body.model}' not found` }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ capabilities: m.capabilities, model_info: { 'general.architecture': 'x', 'x.context_length': m.ctx } }));
    }
    if (req.url === '/api/chat') {
      if (!MODELS[body.model]) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `model '${body.model}' not found, try pulling it first` }));
      }
      inflight++;
      stats.maxInflight = Math.max(stats.maxInflight, inflight);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const send = (obj) => res.write(JSON.stringify(obj) + '\n');
      const wait = () => new Promise((r) => setTimeout(r, delayMs));
      if (MODELS[body.model].capabilities.includes('thinking')) {
        send({ model: body.model, message: { role: 'assistant', content: '', thinking: 'Let me think.' }, done: false });
        await wait();
      }
      const images = body.messages.reduce((n, m) => n + (m.images ? m.images.length : 0), 0);
      const reply = `Local answer from ${body.model} (images: ${images}).`;
      for (const part of reply.match(/.{1,12}/g)) {
        send({ model: body.model, message: { role: 'assistant', content: part }, done: false });
        await wait();
      }
      send({ model: body.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 321, eval_count: 12 });
      inflight--;
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    stats,
    close: () => new Promise((r) => server.close(r)),
  };
}
