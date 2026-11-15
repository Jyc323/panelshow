// Image generation on GMI Cloud's request queue (text-to-image and image-to-image).
// Image models are not in /v1/models. The queue lists its models, and a details call describes each
// model's parameters (names, types, options). PanelShow builds every request from those details, so any
// active image model on the key can be used without a hand-written adapter.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { GmiError } from './gmi.js';
import { normalizeImage, hasFfmpeg } from './media.js';

const queue = () => config.queueUrl.replace(/\/+$/, '');
const DAY = 24 * 60 * 60 * 1000;

function headers(json = true) {
  if (!config.apiKey) throw new GmiError('GMI_API_KEY is not set: image models run on GMI Cloud.');
  return json ? { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' } : { Authorization: `Bearer ${config.apiKey}` };
}

function withTimeout(signal, ms) {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

async function call(method, url, { body, signal, ms = 30000 } = {}) {
  let res;
  try {
    res = await fetch(url, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body), signal: withTimeout(signal, ms) });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new GmiError(`Could not reach GMI's image service (${e.cause?.code || e.message}).`);
  }
  const text = await res.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const detail = j ? j.error?.message || j.message || j.error || j.detail || text : text;
    throw new GmiError(`GMI ${res.status}: ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 800)}`, res.status);
  }
  if (!j) throw new GmiError(`GMI sent something that is not JSON: ${text.slice(0, 200)}`);
  return j;
}

/** Every model id the request queue offers to this key (video, audio and image together). */
export async function listQueueModels() {
  const j = await call('GET', `${queue()}/models`);
  return Array.isArray(j.model_ids) ? j.model_ids : Array.isArray(j.models) ? j.models.map((m) => m.id || m.model_id || m) : [];
}

/** The details GMI publishes for one queue model (parameters, modalities, descriptions). */
export function modelDetails(id) {
  return call('GET', `${queue()}/models/${encodeURIComponent(id)}`);
}

const PROMPT_FIELDS = ['prompt', 'text', 'instruction'];
const IMAGE_FIELDS = ['image', 'images', 'reference_images', 'reference_image'];
const COUNT_FIELDS = ['n', 'max_images', 'num_images'];
const short = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const ratioOf = (s) => {
  const m = String(s).match(/(\d+)\s*[x×:]\s*(\d+)/);
  return m && +m[2] ? +m[1] / +m[2] : 0;
};

/** What PanelShow needs to know to call one image model, or null when it is not a usable image model. */
export function describeImageModel(id, det) {
  if (!det || det.model_type !== 'image' || (det.status && det.status !== 'active')) return null;
  const params = Array.isArray(det.parameters) ? det.parameters : [];
  const find = (name) => params.find((p) => p.name === name);
  const promptParam = PROMPT_FIELDS.map(find).find((p) => p && p.type === 'string');
  if (!promptParam) return null; // utilities without a prompt (background removal, upscaling) are left out for now
  const imageParam = IMAGE_FIELDS.map(find).find((p) => p && p.type === 'image');
  // A required parameter PanelShow cannot fill (a mask, a style, a second picture slot): leave the model out.
  if (params.some((p) => p.required && p !== promptParam && p !== imageParam)) return null;
  const aspect = find('aspect_ratio');
  const size = find('size');
  const count = COUNT_FIELDS.map(find).find((p) => p && p.type === 'integer');
  const options = (p) => (p && Array.isArray(p.options) ? p.options.map((o) => String(o.value)) : []);
  const price = det.price_info && Number(det.price_info.price) > 0 ? Number(det.price_info.price) / 1e6 : null;
  return {
    id,
    name: det.display_name || id,
    about: short(det.brief_description, 140),
    promptField: promptParam.name,
    imageField: imageParam ? imageParam.name : '',
    maxRefs: imageParam ? Math.max(1, Number(imageParam.max_value) || 1) : 0,
    refsAsList: Boolean(imageParam && (Number(imageParam.max_value) > 1 || /s$/.test(imageParam.name))),
    textToImage: !(imageParam && imageParam.required),
    imageToImage: Boolean(imageParam),
    aspectOptions: options(aspect).filter((v) => /^\d+:\d+$/.test(v)),
    sizeOptions: size && size.type === 'enum' ? options(size) : [],
    sizeDefault: size && size.type === 'string' && /^\d+x\d+$/.test(String(size.default_value || '')) ? String(size.default_value) : '',
    countField: count ? count.name : '',
    watermark: Boolean(find('watermark')),
    sequential: Boolean(find('sequential_image_generation')),
    price,
    priceText: short(det.pricing_details, 160),
  };
}

let memo = null; // { at, url, models }
let loading = null;
const cacheFile = () => path.join(config.dataDir, 'cache', 'image-models.json');

/** Active image models on this key, built from the queue's model details. Cached for a day (memory and disk). */
export async function imageCatalog({ refresh = false } = {}) {
  if (!config.apiKey) return [];
  if (!refresh && memo && memo.url === config.queueUrl && Date.now() - memo.at < DAY) return memo.models;
  if (!refresh) {
    try {
      const disk = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
      if (disk.url === config.queueUrl && Date.now() - disk.at < DAY && Array.isArray(disk.models)) {
        memo = disk;
        return disk.models;
      }
    } catch {
      /* no cache yet */
    }
  }
  if (loading) return loading;
  loading = (async () => {
    const ids = await listQueueModels();
    const models = [];
    let i = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (i < ids.length) {
        const id = ids[i++];
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id)) continue; // saved workflows, not models
        try {
          const m = describeImageModel(id, await modelDetails(id));
          if (m) models.push(m);
        } catch {
          /* a model whose details fail is simply not offered */
        }
      }
    }));
    models.sort((a, b) => a.id.localeCompare(b.id));
    memo = { at: Date.now(), url: config.queueUrl, models };
    try {
      fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
      fs.writeFileSync(cacheFile(), JSON.stringify(memo));
    } catch {
      /* cache is optional */
    }
    return models;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

/** The catalog if it is ready, without waiting (for prompts). */
export const catalogNow = () => (memo && memo.url === config.queueUrl ? memo.models : null);

/** Which image model to use when a member names none. */
export function defaultImageModel(models) {
  const ids = models.map((m) => m.id);
  return [config.defaultImageModel, 'seedream-5.0-lite', 'seedream-5.0-pro', 'gemini-3.1-flash-image'].find((id) => id && ids.includes(id)) || (models.find((m) => m.textToImage) || {}).id || '';
}

/** The request payload for one model, from its parameter details. */
export function buildPayload(m, { prompt, refs = [], aspect = '' }) {
  const p = { [m.promptField]: prompt };
  if (refs.length && m.imageField) p[m.imageField] = m.refsAsList ? refs.slice(0, m.maxRefs) : refs[0];
  const want = ratioOf(aspect);
  if (want) {
    if (m.aspectOptions.length) {
      p.aspect_ratio = m.aspectOptions.reduce((best, o) => (Math.abs(ratioOf(o) - want) < Math.abs(ratioOf(best) - want) ? o : best));
    } else {
      const sized = m.sizeOptions.filter((o) => ratioOf(o));
      if (sized.length) p.size = sized.reduce((best, o) => (Math.abs(ratioOf(o) - want) < Math.abs(ratioOf(best) - want) ? o : best));
      else if (m.sizeDefault) {
        // A free-form "WxH" size (GPT Image): from a square default, 2:3 for portrait and 3:2 for landscape
        // (1024x1024 -> 1024x1536 / 1536x1024, the sizes GPT Image documents).
        const [w, h] = m.sizeDefault.split('x').map(Number);
        const side = Math.min(w, h);
        const long = Math.round((side * 1.5) / 16) * 16;
        p.size = want > 1.15 ? `${long}x${side}` : want < 0.87 ? `${side}x${long}` : `${side}x${side}`;
      }
    }
  }
  if (m.countField) p[m.countField] = 1;
  if (m.watermark) p.watermark = false;
  if (m.sequential) p.sequential_image_generation = 'disabled';
  return p;
}

/** Host an input image through GMI's upload route and return its public URL. Accepts png and jpeg. */
export async function uploadImage(buffer, mime, { signal } = {}) {
  let data = buffer;
  let type = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpeg' : '';
  if (!type) {
    // webp, gif and others: re-encode as JPEG first (needs ffmpeg).
    if (!(await hasFfmpeg())) throw new GmiError('This image type needs ffmpeg to be converted before it can be sent (png and jpeg work without it).');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-img-'));
    try {
      const inFile = path.join(dir, 'in');
      const outFile = path.join(dir, 'out.jpg');
      fs.writeFileSync(inFile, buffer);
      if (!(await normalizeImage(inFile, outFile))) throw new GmiError('Could not convert the image to JPEG.');
      data = fs.readFileSync(outFile);
      type = 'jpeg';
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const j = await call('POST', `${queue()}/upload-url`, { body: { file_type: type }, signal });
  if (!j.upload_url || !j.public_url) throw new GmiError('GMI did not return an upload address.');
  let res;
  try {
    res = await fetch(j.upload_url, { method: 'PUT', headers: { 'Content-Type': type === 'png' ? 'image/png' : 'image/jpeg' }, body: data, signal: withTimeout(signal, 60000) });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new GmiError(`Uploading the input image failed (${e.cause?.code || e.message}).`);
  }
  if (!res.ok) throw new GmiError(`Uploading the input image failed: HTTP ${res.status}.`);
  return j.public_url;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(t);
    reject(signal.reason || new Error('aborted'));
  }, { once: true });
});

async function download(url, signal) {
  if (!/^https?:\/\//i.test(url)) throw new GmiError('GMI returned an image address that is not http(s).');
  const res = await fetch(url, { signal: withTimeout(signal, 120000) });
  if (!res.ok) throw new GmiError(`Downloading the generated image failed: HTTP ${res.status}.`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > 40 * 1024 * 1024) throw new GmiError('The generated image is larger than 40 MB.');
  const ct = (res.headers.get('content-type') || '').split(';')[0];
  const mime = /^image\//.test(ct) ? ct : /\.png(\?|$)/i.test(url) ? 'image/png' : /\.webp(\?|$)/i.test(url) ? 'image/webp' : 'image/jpeg';
  return { buffer, mime };
}

/**
 * Generate one image. refs: input images as { buffer, mime } (image-to-image).
 * onStatus(text) reports progress. Resolves to { buffer, mime, model, payload, requestId, seconds }.
 */
export async function generateImage({ model, prompt, refs = [], aspect = '', signal, onStatus = () => {} }) {
  const models = await imageCatalog();
  const m = models.find((x) => x.id === model);
  if (!m) throw new GmiError(`${model} is not an image model available on this GMI key.`);
  if (refs.length && !m.imageToImage) throw new GmiError(`${model} cannot take an input image. Use a model that edits images.`);
  if (!refs.length && !m.textToImage) throw new GmiError(`${model} needs an input image. Use @@edit with an image id.`);
  const t0 = Date.now();
  const urls = [];
  for (const r of refs.slice(0, m.maxRefs || 1)) {
    onStatus('uploading the input image');
    urls.push(await uploadImage(r.buffer, r.mime, { signal }));
  }
  const payload = buildPayload(m, { prompt, refs: urls, aspect });
  onStatus('queued');
  // Some models are "sync": the submit call only returns when the picture is ready, so it gets the full time.
  // A 5xx/429 answer (the job was not taken, e.g. "Upstream provider unavailable; please retry") is retried twice.
  // A timeout on our side is not retried: the job may already be running and would be paid twice.
  let sub;
  for (let attempt = 0; ; attempt++) {
    try {
      sub = await call('POST', `${queue()}/requests`, { body: { model, payload }, signal, ms: config.imageTimeoutMs });
      break;
    } catch (e) {
      const retryable = e instanceof GmiError && (e.status === 429 || (e.status >= 500 && e.status <= 504));
      if (!retryable || attempt >= 2 || signal?.aborted) throw attempt ? new GmiError(`${e.message} (after ${attempt + 1} tries)`, e.status) : e;
      onStatus(`GMI is busy (HTTP ${e.status}), trying again`);
      await sleep(attempt ? 10000 : 4000, signal);
    }
  }
  const requestId = sub.request_id || sub.id;
  if (!requestId) throw new GmiError('GMI did not return a request id.');
  let st = sub;
  for (;;) {
    const status = String(st.status || '').toLowerCase();
    if (status === 'success') break;
    if (['failed', 'cancelled', 'canceled', 'error'].includes(status)) {
      const why = st.outcome?.error || st.error?.message || st.error || st.message || st.outcome?.message || '';
      throw new GmiError(`${model} failed: ${String(typeof why === 'string' ? why : JSON.stringify(why)).slice(0, 600) || status}`);
    }
    if (Date.now() - t0 > config.imageTimeoutMs) throw new GmiError(`${model} did not finish within ${Math.round(config.imageTimeoutMs / 1000)} s (request ${requestId}). Raise PANELSHOW_IMAGE_TIMEOUT_MS for slow models.`);
    onStatus(status || 'waiting');
    await sleep(config.imagePollMs, signal);
    try {
      st = await call('GET', `${queue()}/requests/${encodeURIComponent(requestId)}`, { signal });
    } catch (e) {
      // A hiccup while checking is not a failed picture: keep checking until the time limit.
      if (!(e instanceof GmiError) || !(e.status === 429 || e.status >= 500 || !e.status) || signal?.aborted) throw e;
      st = { status: 'waiting' };
    }
  }
  const media = (st.outcome?.media_urls || []).map((x) => (typeof x === 'string' ? x : x.url)).filter(Boolean);
  if (!media.length) throw new GmiError(`${model} finished but returned no image.`);
  onStatus('downloading');
  // Some models return a small preview next to the full image: keep the largest file.
  let best = null;
  for (const url of media.slice(0, 4)) {
    const img = await download(url, signal);
    if (!best || img.buffer.length > best.buffer.length) best = img;
  }
  const shown = { ...payload };
  if (shown[m.imageField]) shown[m.imageField] = Array.isArray(shown[m.imageField]) ? shown[m.imageField].map(() => '(uploaded image)') : '(uploaded image)';
  return { ...best, model, payload: shown, requestId, seconds: Math.round((Date.now() - t0) / 1000) };
}

/** Discovery dump: all queue models with their raw details. Read-only; no generation. */
export async function discover() {
  const ids = await listQueueModels();
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < ids.length) {
      const id = ids[i++];
      try {
        out.push({ id, details: await modelDetails(id) });
      } catch (e) {
        out.push({ id, error: e.message });
      }
    }
  }));
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
