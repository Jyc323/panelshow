// Opening web addresses for members: page text, images, direct video frames, PDF / Word text.
// Everything fetched is cached under data/cache/<id>/ and treated as material, never as instructions.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { config } from './config.js';
import { normalizeImage, videoSheet } from './media.js';

const UA = 'ModelRoundTable/0.1 (local research tool)';
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|#|$)/i;
const cacheDir = (id) => path.join(config.dataDir, 'cache', id);
const memory = new Map();

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('::ffff:');
}

/** Only public http(s) addresses, so a member cannot be steered at this computer or the local network. */
export async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('not a valid web address');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http and https addresses can be opened');
  if (url.username || url.password) throw new Error('addresses with a user name or password are not opened');
  if (config.allowPrivateUrls) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  if (net.isIP(host)) addrs = [host];
  else {
    try {
      addrs = (await dns.lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw new Error('the site name could not be found');
    }
  }
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new Error('addresses on this computer or a private network are not opened');
  return url;
}

async function guardedFetch(raw, signal) {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop < 6; hop++) {
    const timeout = AbortSignal.timeout(25000);
    const res = await fetch(url, {
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/pdf,image/*,video/*,text/*;q=0.9,*/*;q=0.5', 'Accept-Language': 'en' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => {});
      url = await assertPublicUrl(new URL(res.headers.get('location'), url).href);
      continue;
    }
    return { res, finalUrl: url.href };
  }
  throw new Error('too many redirects');
}

async function readBody(res, maxBytes) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  for await (const c of res.body) {
    size += c.length;
    if (size > maxBytes) {
      truncated = true;
      chunks.push(c.subarray(0, c.length - (size - maxBytes)));
      break;
    }
    chunks.push(c);
  }
  return { buffer: Buffer.concat(chunks), truncated };
}

const decodeEntities = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

const tidy = (s) => String(s || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();

/** Text of a PDF or Word file. */
export async function extractDocText(buffer, kind) {
  if (kind === 'pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    return tidy(Array.isArray(text) ? text.join('\n\n') : text);
  }
  if (kind === 'docx') {
    const mammoth = (await import('mammoth')).default;
    return tidy((await mammoth.extractRawText({ buffer })).value);
  }
  throw new Error('unsupported document type');
}

/** Pull the useful parts out of an HTML page. */
export async function readPage(html, baseUrl) {
  const { parseHTML } = await import('linkedom');
  const { Readability } = await import('@mozilla/readability');
  const { document } = parseHTML(html);
  const meta = (sel) => document.querySelector(sel)?.getAttribute('content')?.trim() || '';
  const absUrl = (u) => {
    try {
      const x = new URL(u, baseUrl);
      return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null;
    } catch {
      return null;
    }
  };
  const title = meta('meta[property="og:title"]') || document.querySelector('title')?.textContent?.trim() || '';
  const description = meta('meta[property="og:description"]') || meta('meta[name="description"]');

  const imageUrls = [];
  const addImage = (u, alt = '') => {
    const a = u && !u.startsWith('data:') && !/\.svg(\?|#|$)/i.test(u) && absUrl(u);
    if (a && !imageUrls.some((i) => i.src === a)) imageUrls.push({ src: a, alt: String(alt).slice(0, 200) });
  };
  addImage(meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]'), 'page preview image');
  const scope = document.querySelector('article') || document.querySelector('main') || document.body || document;
  for (const img of scope.querySelectorAll('img')) {
    const w = Number(img.getAttribute('width')) || 0;
    const h = Number(img.getAttribute('height')) || 0;
    if ((w && w < 100) || (h && h < 100)) continue; // icons, tracking pixels
    addImage(img.getAttribute('src') || img.getAttribute('data-src') || '', img.getAttribute('alt') || '');
  }

  const videoUrls = [];
  const addVideo = (u) => {
    const a = u && absUrl(u);
    if (a && !videoUrls.includes(a)) videoUrls.push(a);
  };
  for (const v of document.querySelectorAll('video[src], video source[src]')) addVideo(v.getAttribute('src'));
  const ogVideo = meta('meta[property="og:video:secure_url"]') || meta('meta[property="og:video:url"]') || meta('meta[property="og:video"]');
  if (ogVideo && (VIDEO_EXT.test(ogVideo) || meta('meta[property="og:video:type"]').startsWith('video/'))) addVideo(ogVideo);

  let text = '';
  try {
    text = new Readability(document).parse()?.textContent || '';
  } catch {
    /* fall through to the plain body text */
  }
  if (text.trim().length < 200) {
    for (const el of document.querySelectorAll('script, style, noscript, template')) el.remove();
    const body = document.body?.textContent || '';
    if (body.trim().length > text.trim().length) text = body;
  }
  return { title, description, text: tidy(text), imageUrls, videoUrls };
}

// Best effort: YouTube exposes caption tracks in the watch page. It often withholds them, in which case we say so.
async function youtubeExtras(html, pageUrl, signal) {
  const out = { title: '', author: '', transcript: '', note: '' };
  try {
    const { res } = await guardedFetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(pageUrl)}`, signal);
    if (res.ok) {
      const j = await res.json();
      out.title = j.title || '';
      out.author = j.author_name || '';
    } else await res.body?.cancel().catch(() => {});
  } catch {
    /* title stays empty */
  }
  try {
    const m = html.match(/"captionTracks":(\[.*?\])/);
    const tracks = m ? JSON.parse(m[1]) : [];
    const track = tracks.find((t) => (t.languageCode || '').startsWith('en')) || tracks[0];
    if (!track?.baseUrl) throw new Error('none');
    const { res } = await guardedFetch(track.baseUrl, signal);
    const { buffer } = await readBody(res, 2 * 1024 * 1024);
    const lines = [...buffer.toString('utf8').matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((x) => decodeEntities(decodeEntities(x[1])).replace(/\s+/g, ' ').trim());
    out.transcript = lines.filter(Boolean).join(' ');
    if (!out.transcript) throw new Error('empty');
  } catch {
    out.note = 'captions were not available for this video';
  }
  return out;
}

async function saveImage(dir, name, buffer, mime) {
  fs.mkdirSync(dir, { recursive: true });
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[mime] || 'bin';
  const rawFile = path.join(dir, `${name}.src.${ext}`);
  fs.writeFileSync(rawFile, buffer);
  const jpg = path.join(dir, `${name}.jpg`);
  if (await normalizeImage(rawFile, jpg)) {
    fs.rmSync(rawFile, { force: true });
    return { file: `${name}.jpg`, mime: 'image/jpeg' };
  }
  // No ffmpeg: keep the original if a model is likely to accept it.
  if (ext !== 'bin' && buffer.length <= 3 * 1024 * 1024) {
    const kept = `${name}.${ext}`;
    fs.renameSync(rawFile, path.join(dir, kept));
    return { file: kept, mime };
  }
  fs.rmSync(rawFile, { force: true });
  return null;
}

async function fetchImage(src, dir, name, signal) {
  try {
    const { res } = await guardedFetch(src, signal);
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!res.ok || !mime.startsWith('image/') || mime === 'image/svg+xml') {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const { buffer, truncated } = await readBody(res, config.imageMaxBytes);
    if (truncated || buffer.length < 2000) return null; // too large, or a spacer
    return await saveImage(dir, name, buffer, mime);
  } catch {
    return null;
  }
}

/**
 * Open a web address. Never throws: a failure comes back as { ok:false, error }.
 * Results are cached, so opening the same address again is free.
 */
export async function openUrl(raw, { signal, refresh = false } = {}) {
  const url = String(raw).trim();
  const id = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  const dir = cacheDir(id);
  const metaFile = path.join(dir, 'meta.json');
  if (!refresh) {
    if (memory.has(id)) return memory.get(id);
    try {
      const cached = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (cached.ok) {
        memory.set(id, cached);
        return cached;
      }
    } catch {
      /* not cached */
    }
  }
  const r = { id, kind: 'url', url, finalUrl: url, ok: false, error: '', type: '', title: '', description: '', text: '', images: [], video: null, notes: [], at: Date.now() };
  try {
    const { res, finalUrl } = await guardedFetch(url, signal);
    r.finalUrl = finalUrl;
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const pathname = new URL(finalUrl).pathname.toLowerCase();
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`the site answered ${res.status}`);
    }
    if (ct.startsWith('video/') || (VIDEO_EXT.test(pathname) && !ct.includes('html'))) {
      await res.body?.cancel().catch(() => {});
      r.type = 'video';
      r.title = path.basename(pathname);
      r.video = { src: finalUrl, ...(await videoSheet(finalUrl, dir)) };
      if (r.video.error) r.notes.push(r.video.error);
    } else if (ct.startsWith('image/')) {
      const { buffer, truncated } = await readBody(res, config.imageMaxBytes);
      if (truncated) throw new Error('the image is too large');
      const img = await saveImage(dir, 'img0', buffer, ct);
      if (!img) throw new Error('the image could not be prepared (is ffmpeg installed?)');
      r.type = 'image';
      r.title = path.basename(pathname);
      r.images.push({ ...img, src: finalUrl, alt: '' });
    } else if (ct === 'application/pdf' || pathname.endsWith('.pdf') || ct.includes('wordprocessingml') || pathname.endsWith('.docx')) {
      const kind = ct === 'application/pdf' || pathname.endsWith('.pdf') ? 'pdf' : 'docx';
      const { buffer, truncated } = await readBody(res, config.docMaxBytes);
      if (truncated) throw new Error('the document is too large');
      r.type = kind;
      r.title = path.basename(pathname);
      r.text = await extractDocText(buffer, kind);
      if (!r.text) r.notes.push('no text found in the document (a scan?)');
    } else if (ct.includes('html') || ct === '') {
      const { buffer, truncated } = await readBody(res, config.pageMaxBytes);
      if (truncated) r.notes.push('the page was cut off at the size limit');
      const html = buffer.toString('utf8');
      const page = await readPage(html, finalUrl);
      r.type = 'page';
      Object.assign(r, { title: page.title, description: page.description, text: page.text });
      const host = new URL(finalUrl).hostname.replace(/^www\./, '');
      if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be') {
        const yt = await youtubeExtras(html, finalUrl, signal);
        r.type = 'video-page';
        if (yt.title) r.title = yt.author ? `${yt.title} (${yt.author})` : yt.title;
        r.text = yt.transcript ? `Captions:\n${yt.transcript}` : '';
        if (yt.note) r.notes.push(yt.note);
        r.notes.push('platform video: only title, description and captions are read, not the pictures');
      }
      const picks = page.imageUrls.slice(0, config.imagesPerPage);
      const saved = await Promise.all(picks.map((im, i) => fetchImage(im.src, dir, `img${i}`, signal)));
      saved.forEach((s, i) => s && r.images.push({ ...s, src: picks[i].src, alt: picks[i].alt }));
      const direct = page.videoUrls.find((u) => VIDEO_EXT.test(u));
      if (direct) {
        try {
          await assertPublicUrl(direct);
          r.video = { src: direct, ...(await videoSheet(direct, path.join(dir, 'video'))) };
          if (r.video.sheet) r.video.sheet = `video/${r.video.sheet}`;
          if (r.video.error) r.notes.push(`video on the page: ${r.video.error}`);
        } catch (e) {
          r.notes.push(`video on the page was not opened: ${e.message}`);
        }
      }
      if (!r.text && !r.description && !r.images.length) r.notes.push('no readable text was found (the page may need JavaScript or a sign-in)');
    } else if (ct.startsWith('text/') || /json|xml|csv|yaml|javascript/.test(ct)) {
      const { buffer, truncated } = await readBody(res, config.pageMaxBytes);
      r.type = 'text';
      r.title = path.basename(pathname);
      r.text = buffer.toString('utf8');
      if (truncated) r.notes.push('cut off at the size limit');
    } else {
      await res.body?.cancel().catch(() => {});
      throw new Error(`this kind of content is not read (${ct || 'unknown type'})`);
    }
    r.text = r.text.slice(0, 200000);
    r.ok = true;
  } catch (e) {
    r.error = e.name === 'TimeoutError' ? 'the site took too long to answer' : e.name === 'AbortError' ? 'stopped' : e.message === 'fetch failed' ? 'the site could not be reached' : e.message || String(e);
  }
  if (r.ok) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(metaFile, JSON.stringify(r));
    memory.set(id, r);
  }
  return r;
}

/** A cached picture as a data URL, ready to send to a model that can see images. */
export function imageDataUrl(resourceId, file, mime = 'image/jpeg') {
  const full = cachedAsset(resourceId, file);
  if (!full) return null;
  try {
    return `data:${mime};base64,${fs.readFileSync(full).toString('base64')}`;
  } catch {
    return null;
  }
}

export function cachedAsset(resourceId, file) {
  if (!/^[0-9a-f]{16}$/.test(resourceId) || !/^(video\/)?[A-Za-z0-9_.]+\.(jpg|png|webp|gif)$/.test(file)) return null;
  const full = path.join(cacheDir(resourceId), file);
  return fs.existsSync(full) ? full : null;
}

/** Web addresses written in a piece of text, in order, without duplicates. */
export function extractUrls(text, max = config.urlsPerMessage) {
  const found = [];
  for (const m of String(text).matchAll(/https?:\/\/[^\s<>"'`\]}]+/g)) {
    // Keep balanced brackets (…/wiki/Rust_(programming_language)); drop sentence punctuation and an unmatched ")".
    let u = m[0];
    for (let prev = ''; prev !== u; ) {
      prev = u;
      u = u.replace(/[.,;:!?*]+$/, '');
      if (u.endsWith(')') && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length) u = u.slice(0, -1);
    }
    if (!found.includes(u)) found.push(u);
    if (found.length >= max) break;
  }
  return found;
}
