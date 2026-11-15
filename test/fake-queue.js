// A stand-in for GMI's request queue (image models): model list, model details, upload route,
// submit and poll. Generated "pictures" are small PNGs served by this server.
import http from 'node:http';
import zlib from 'node:zlib';

export function png(w = 8, h = 8, shade = 0) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let r = 0xffffffff;
    for (const b of buf) r = table[(r ^ b) & 255] ^ (r >>> 8);
    return (r ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < h; y++) rows.push(Buffer.from([0]), Buffer.from(Array.from({ length: w * 3 }, (_, i) => (i * 31 + y * 17 + shade) % 256)));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

const p = (name, type, extra = {}) => ({ name, type, required: false, ...extra });
const MODELS = {
  'pic-both': { model_type: 'image', status: 'active', display_name: 'Pic Both', brief_description: 'Makes and edits pictures.', price_info: { price: 35000 }, parameters: [p('prompt', 'string', { required: true }), p('image', 'image', { max_value: 4 }), p('size', 'enum', { options: [{ value: '2K' }, { value: '2048x2048' }, { value: '1536x2048' }, { value: '2048x1536' }] }), p('max_images', 'integer'), p('watermark', 'boolean')] },
  'pic-edit': { model_type: 'image', status: 'active', parameters: [p('prompt', 'string', { required: true }), p('image', 'image', { required: true })] },
  'pic-text': { model_type: 'image', status: 'active', parameters: [p('text', 'string', { required: true }), p('aspect_ratio', 'enum', { options: [{ value: '1:1' }, { value: '3:4' }, { value: '16:9' }] })] },
  'pic-fail': { model_type: 'image', status: 'active', parameters: [p('prompt', 'string', { required: true })] },
  'pic-slow': { model_type: 'image', status: 'active', parameters: [p('prompt', 'string', { required: true })] },
  'pic-flaky': { model_type: 'image', status: 'active', parameters: [p('prompt', 'string', { required: true })] },
  'pic-sync': { model_type: 'image', status: 'active', parameters: [p('prompt', 'string', { required: true })] },
  'pic-wxh': { model_type: 'image', status: 'active', parameters: [p('prompt', 'string', { required: true }), p('size', 'string', { default_value: '1024x1024' })] },
  'pic-old': { model_type: 'image', status: 'inactive', parameters: [p('prompt', 'string', { required: true })] },
  'pic-upscale': { model_type: 'image', status: 'active', parameters: [p('image', 'image', { required: true })] },
  'pic-mask': { model_type: 'image', status: 'active', parameters: [p('prompt', 'string', { required: true }), p('image', 'image', { required: true }), p('mask', 'image', { required: true })] },
  'vid-1': { model_type: 'video', status: 'active', parameters: [p('prompt', 'string', { required: true })] },
};

export async function createFakeQueue({ size = 48, key = 'test-key-SECRET-123' } = {}) {
  const requests = []; // submitted { model, payload }
  const uploads = []; // bytes PUT to upload urls
  const jobs = new Map();
  let n = 0;
  let flakyFailed = false;
  let base = '';
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const json = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    if (path.startsWith('/q/') && req.headers.authorization !== `Bearer ${key}`) return json(401, { error: 'bad key' });
    if (req.method === 'GET' && path === '/q/models') return json(200, { model_ids: [...Object.keys(MODELS), '0a1b2c3d-1111-2222-3333-444455556666'] });
    if (req.method === 'GET' && path.startsWith('/q/models/')) {
      const id = decodeURIComponent(path.slice('/q/models/'.length));
      return MODELS[id] ? json(200, { model: id, ...MODELS[id] }) : json(404, { error: 'not found' });
    }
    if (req.method === 'POST' && path === '/q/upload-url') {
      const k = ++n;
      const type = JSON.parse(raw.toString()).file_type;
      return json(200, { upload_url: `${base}/put/${k}`, public_url: `${base}/public/${k}.${type}` });
    }
    if (req.method === 'PUT' && path.startsWith('/put/')) {
      uploads.push({ id: path.slice(5), type: req.headers['content-type'], bytes: raw.length });
      res.writeHead(200);
      return res.end();
    }
    if (req.method === 'POST' && path === '/q/requests') {
      const body = JSON.parse(raw.toString());
      requests.push(body);
      // Fails the first time it is asked, like GMI's "Upstream provider unavailable; please retry".
      if (body.model === 'pic-flaky' && !flakyFailed) {
        flakyFailed = true;
        return json(500, { error: { message: 'Upstream provider unavailable; please retry' } });
      }
      const id = `req-${++n}`;
      // A "sync" model answers the submit call with the finished result.
      if (body.model === 'pic-sync') return json(200, { request_id: id, status: 'success', outcome: { media_urls: [{ id: '0', url: `${base}/files/${id}-full.png` }] } });
      jobs.set(id, { body, polls: 0 });
      return json(200, { request_id: id, status: 'queued' });
    }
    if (req.method === 'GET' && path.startsWith('/q/requests/')) {
      const id = path.slice('/q/requests/'.length);
      const job = jobs.get(id);
      if (!job) return json(404, { error: 'no such request' });
      job.polls++;
      if (job.body.model === 'pic-slow') return json(200, { request_id: id, status: 'processing' });
      if (job.polls < 2) return json(200, { request_id: id, status: 'processing' });
      if (job.body.model === 'pic-fail') return json(200, { request_id: id, status: 'failed', outcome: { error: 'content policy violation' } });
      // A small preview first, then the full picture: the client must keep the larger one.
      return json(200, { request_id: id, status: 'success', outcome: { media_urls: [{ id: '0', url: `${base}/files/${id}-preview.png` }, { id: '1', url: `${base}/files/${id}-full.png` }] } });
    }
    if (req.method === 'GET' && path.startsWith('/files/')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(path.endsWith('-full.png') ? png(size, size, 7) : png(8, 8, 3));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return { url: `${base}/q`, requests, uploads, fullSize: png(size, size, 7).length, close: () => new Promise((r) => server.close(r)) };
}
