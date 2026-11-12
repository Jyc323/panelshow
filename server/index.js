// Local web server: JSON API, live events, and the static page. Listens on 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ROOT } from './config.js';
import { listRooms, getRoom, createRoom, saveRoom, deleteRoom, newId, getCapabilities, setCapability } from './store.js';
import { listModels, probeModel, GmiError } from './gmi.js';
import { startRun, stopRun, isRunning, subscribe, emit, claim, release } from './orchestrator.js';
import { runJudge, RUBRICS } from './judge.js';
import { saveUpload, readFileText, rawFilePath } from './files.js';
import { extractDocText, cachedAsset } from './resources.js';
import { contextText } from './prompt.js';
import { hasFfmpeg } from './media.js';
import { suggestMembers, planCost, PROBE_VERSION, MAX_MEMBERS } from './casting.js';
import { checkFolder, folderSummary, scanFolder, renderTree, treeHeader, readFolderRaw } from './workspace.js';

const WEB = path.join(ROOT, 'web');
const VENDOR = {
  '/vendor/htm-preact.js': 'node_modules/htm/preact/standalone.module.js',
  '/vendor/marked.js': 'node_modules/marked/lib/marked.esm.js',
  '/vendor/purify.js': 'node_modules/dompurify/dist/purify.es.mjs',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#4d7c0f'];
const NAME_RE = /^[A-Za-z0-9_.-]{1,24}$/;

const fail = (status, message) => Object.assign(new Error(message), { status });

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

async function body(req, max = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw fail(413, 'That is too large.');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function json(req) {
  const raw = await body(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw fail(400, 'The request was not valid JSON.');
  }
}

const roomView = (room) => ({ ...room, running: isRunning(room.id) });
const needRoom = (id) => getRoom(id) || (() => { throw fail(404, 'That room does not exist.'); })();

const probing = new Set();
function probeInBackground(model, room) {
  if (!config.autoProbe || !config.apiKey || getCapabilities()[model] || probing.has(model)) return;
  probing.add(model);
  probeModel(model)
    .then((r) => {
      setCapability(model, { ...r, probeVersion: PROBE_VERSION });
      emit(room, { type: 'capabilities', capabilities: getCapabilities() });
    })
    .catch(() => {})
    .finally(() => probing.delete(model));
}

function exportMarkdown(room) {
  const lines = [`# ${room.title}`, '', `Members: ${room.members.map((m) => `${m.name} (${m.model})`).join(', ') || 'none'}`, ...((room.folders || []).length ? [`Shared folders (read-only): ${room.folders.map((f) => f.name).join(', ')}`] : []), ''];
  for (const m of room.messages) {
    if (m.kind === 'verdict') {
      lines.push('### Verdict', '', m.text, '');
      for (const j of m.verdict.judges) if (j.result) lines.push(`- **${j.name}**: ${j.result.summary}`);
      lines.push('');
    } else if (m.role === 'host') lines.push('### Host', '', m.text, '');
    else if (m.role === 'member' && !m.pass) lines.push(`### ${m.name} (${m.model})${m.status !== 'done' ? ` [${m.status}]` : ''}`, '', contextText(m.text, m.files) || (m.error ? `_${m.error}_` : ''), '');
  }
  return lines.join('\n');
}

async function api(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent); // after "api"
  const method = req.method;
  const is = (m, ...pattern) => method === m && seg.length === pattern.length && pattern.every((p, i) => p === '*' || p === seg[i]);

  if (is('GET', 'health')) return send(res, 200, { ok: true, hasKey: Boolean(config.apiKey), ffmpeg: await hasFfmpeg(), baseUrl: config.baseUrl, rubrics: RUBRICS });

  if (is('GET', 'models')) {
    try {
      return send(res, 200, { models: await listModels({ refresh: url.searchParams.has('refresh') }), capabilities: getCapabilities() });
    } catch (e) {
      return send(res, 200, { models: [], capabilities: getCapabilities(), error: e.message });
    }
  }
  if (is('POST', 'probe')) {
    const { model } = await json(req);
    if (!model) throw fail(400, 'Which model?');
    return send(res, 200, setCapability(String(model), { ...(await probeModel(String(model))), probeVersion: PROBE_VERSION }));
  }

  if (is('GET', 'rooms')) return send(res, 200, listRooms().map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt, members: r.members.length, messages: r.messages.length })));
  if (is('POST', 'rooms')) return send(res, 201, roomView(createRoom((await json(req)).title)));

  if (seg[0] !== 'rooms' || !seg[1]) throw fail(404, 'Not found.');
  const room = needRoom(seg[1]);

  if (is('GET', 'rooms', '*')) return send(res, 200, { room: roomView(room), capabilities: getCapabilities() });
  if (is('PATCH', 'rooms', '*')) {
    const b = await json(req);
    if (typeof b.title === 'string' && b.title.trim()) room.title = b.title.trim().slice(0, 80);
    saveRoom(room);
    emit(room, { type: 'room', room: roomView(room) });
    return send(res, 200, roomView(room));
  }
  if (is('DELETE', 'rooms', '*')) {
    stopRun(room.id);
    deleteRoom(room.id);
    return send(res, 200, { ok: true });
  }

  if (is('GET', 'rooms', '*', 'events')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const write = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    write({ type: 'run', active: isRunning(room.id) });
    const off = subscribe(room.id, write);
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 20000);
    req.on('close', () => {
      off();
      clearInterval(beat);
    });
    return;
  }

  // Invite one member ({name, model, role}) or several at once ({members: [...]}). All are checked before any is added.
  if (is('POST', 'rooms', '*', 'members')) {
    const b = await json(req);
    const list = Array.isArray(b.members) ? b.members : [b];
    if (!list.length) throw fail(400, 'Pick at least one model.');
    if (room.members.length + list.length > MAX_MEMBERS) throw fail(400, `A room holds at most ${MAX_MEMBERS} members (${room.members.length} already here).`);
    const names = new Set(room.members.map((m) => m.name.toLowerCase()));
    const clean = list.map((x) => {
      const name = String((x && x.name) || '').trim();
      const model = String((x && x.model) || '').trim();
      if (!NAME_RE.test(name) || ['host', 'system'].includes(name.toLowerCase())) throw fail(400, `"${name}": names use letters, digits, dot, dash or underscore (up to 24), and cannot be Host or System.`);
      if (names.has(name.toLowerCase())) throw fail(400, `Another member already has the name ${name}.`);
      if (!model) throw fail(400, 'Pick a model.');
      names.add(name.toLowerCase());
      return { name, model, role: String((x && x.role) || '').slice(0, 2000), roleName: String((x && x.roleName) || '').replace(/\s+/g, ' ').trim().slice(0, 40) };
    });
    const added = clean.map((x) => {
      const used = room.members.map((m) => m.color);
      const member = { id: newId(), ...x, color: COLORS.find((c) => !used.includes(c)) || COLORS[room.members.length % COLORS.length], vision: null };
      room.members.push(member);
      return member;
    });
    saveRoom(room);
    emit(room, { type: 'room', room: roomView(room) });
    for (const m of added) probeInBackground(m.model, room);
    return send(res, 201, Array.isArray(b.members) ? { members: added } : added[0]);
  }
  // Read-only project folders on this computer. Members can read, search and list them; nothing is ever written there.
  if (is('POST', 'rooms', '*', 'folders')) {
    const b = await json(req);
    room.folders = room.folders || [];
    let folder;
    try {
      folder = checkFolder(b.path, room.folders);
    } catch (e) {
      throw fail(400, e.message);
    }
    room.folders.push(folder);
    saveRoom(room);
    emit(room, { type: 'room', room: roomView(room) });
    return send(res, 201, folderSummary(folder));
  }
  if (seg[2] === 'folders' && seg[3] && seg.length === 4) {
    const folder = (room.folders || []).find((f) => f.id === seg[3]);
    if (!folder) throw fail(404, 'That folder is not shared in this room.');
    if (method === 'GET') {
      const sum = folderSummary(folder);
      return send(res, 200, { ...sum, tree: `${treeHeader(folder)}\n${renderTree(folder, 200000)}`, paths: scanFolder(folder.path).files.map((f) => ({ path: f.rel, size: f.size })) });
    }
    if (method === 'DELETE') {
      if (isRunning(room.id)) throw fail(409, 'Wait until the members finish, or stop them.');
      room.folders = room.folders.filter((f) => f.id !== folder.id);
      saveRoom(room);
      emit(room, { type: 'room', room: roomView(room) });
      return send(res, 200, { ok: true });
    }
  }
  if (is('GET', 'rooms', '*', 'folder-file')) {
    const folder = (room.folders || []).find((f) => f.id === url.searchParams.get('folder'));
    if (!folder) throw fail(404, 'That folder is not shared in this room.');
    const r = readFolderRaw(folder, String(url.searchParams.get('path') || ''));
    if (r.error) throw fail(404, r.error);
    return send(res, 200, r.text, { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  // Smart invite. GET: what a suggestion will cost now. POST {topic, count}: proposed members (nothing is added).
  if (is('GET', 'rooms', '*', 'suggest')) {
    if (!config.apiKey) throw fail(400, 'GMI_API_KEY is not set.');
    return send(res, 200, await planCost(room));
  }
  if (is('POST', 'rooms', '*', 'suggest')) {
    const b = await json(req);
    const topic = String(b.topic || '').trim();
    if (!topic) throw fail(400, 'Describe the topic first.');
    if (!config.apiKey) throw fail(400, 'GMI_API_KEY is not set. Copy .env.example to .env, add your key, and restart.');
    const ac = new AbortController();
    res.on('close', () => !res.writableEnded && ac.abort());
    const result = await suggestMembers(room, { topic: topic.slice(0, 8000), count: b.count, signal: ac.signal });
    emit(room, { type: 'capabilities', capabilities: getCapabilities() });
    return send(res, 200, result);
  }
  if (seg[2] === 'members' && seg[3] && seg.length === 4 && (method === 'PATCH' || method === 'DELETE')) {
    const i = room.members.findIndex((m) => m.id === seg[3]);
    if (i < 0) throw fail(404, 'That member is not in the room.');
    if (isRunning(room.id)) throw fail(409, 'Wait until the members finish, or stop them.');
    if (method === 'DELETE') room.members.splice(i, 1);
    else {
      const b = await json(req);
      const m = room.members[i];
      if (typeof b.role === 'string') m.role = b.role.slice(0, 2000);
      if (typeof b.roleName === 'string') m.roleName = b.roleName.replace(/\s+/g, ' ').trim().slice(0, 40);
      if (b.vision === null || typeof b.vision === 'boolean') m.vision = b.vision;
      if (b.move === 'up' && i > 0) [room.members[i - 1], room.members[i]] = [room.members[i], room.members[i - 1]];
      if (b.move === 'down' && i < room.members.length - 1) [room.members[i + 1], room.members[i]] = [room.members[i], room.members[i + 1]];
    }
    saveRoom(room);
    emit(room, { type: 'room', room: roomView(room) });
    return send(res, 200, { ok: true });
  }

  if (is('POST', 'rooms', '*', 'send')) {
    const b = await json(req);
    const text = String(b.text || '').trim();
    if (!text) throw fail(400, 'Write a message first.');
    if (text.length > 100000) throw fail(400, 'That message is too long.');
    if (!room.members.length) throw fail(400, 'Invite at least one model first.');
    if (!config.apiKey) throw fail(400, 'GMI_API_KEY is not set. Copy .env.example to .env, add your key, and restart.');
    const { host } = startRun(room, { text, mode: b.mode, rounds: b.rounds, maxHops: b.maxHops, attachments: Array.isArray(b.attachments) ? b.attachments.map(String) : [] });
    return send(res, 202, { message: host });
  }
  if (is('POST', 'rooms', '*', 'stop')) {
    stopRun(room.id);
    return send(res, 200, { ok: true });
  }
  if (is('POST', 'rooms', '*', 'judge')) {
    const b = await json(req);
    if (!config.apiKey) throw fail(400, 'GMI_API_KEY is not set.');
    const ctl = claim(room);
    if (!ctl) throw fail(409, 'The members are still replying. Stop them first.');
    runJudge(room, { messageIds: b.messageIds || [], judgeIds: b.judgeIds || [], rubric: b.rubric, criteria: b.criteria, extra: b.extra, signal: ctl.signal })
      .catch((e) => emit(room, { type: 'notice', level: 'error', text: e.message }))
      .finally(() => release(room));
    return send(res, 202, { ok: true });
  }

  if (is('POST', 'rooms', '*', 'upload')) {
    const data = await body(req, config.uploadMaxBytes);
    let entry;
    try {
      entry = await saveUpload(room, url.searchParams.get('name') || 'file', data, extractDocText);
    } catch (e) {
      throw fail(400, `Upload failed: ${e.message}`);
    }
    saveRoom(room);
    emit(room, { type: 'files', files: room.files });
    return send(res, 201, entry);
  }
  if (is('GET', 'rooms', '*', 'file')) {
    const rel = url.searchParams.get('path') || '';
    const full = rawFilePath(room, rel);
    if (!full) throw fail(404, 'That file is not in the room.');
    if (url.searchParams.has('download')) {
      const name = path.basename(full).replace(/[^A-Za-z0-9._ -]/g, '_');
      return send(res, 200, fs.readFileSync(full), { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"` });
    }
    // Always plain text: a member-written HTML file must never run in this page's origin.
    const r = readFileText(room, rel);
    if (r.error) throw fail(404, r.error);
    return send(res, 200, r.text, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  if (is('GET', 'rooms', '*', 'export')) {
    return send(res, 200, exportMarkdown(room), { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="panelshow-${room.id}.md"` });
  }
  throw fail(404, 'Not found.');
}

function serveStatic(req, res, url) {
  if (url.pathname.startsWith('/cache/')) {
    const [, , id, ...rest] = url.pathname.split('/');
    const file = cachedAsset(id || '', rest.join('/'));
    if (!file) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    return send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'max-age=3600' });
  }
  let file;
  if (VENDOR[url.pathname]) file = path.join(ROOT, VENDOR[url.pathname]);
  else {
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    file = path.resolve(WEB, rel);
    if (!file.startsWith(WEB + path.sep)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      // Only this computer's browser may talk to the server: check the Host and, for writes, the Origin.
      const hostName = String(req.headers.host || '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '[::1]', config.host].includes(hostName)) return send(res, 403, { error: 'Forbidden host.' });
      // Another site in the browser may not use the API, not even to read (GET): check Origin on every request,
      // and the browser's own Sec-Fetch-Site label where it is sent.
      if (req.headers.origin && req.headers.origin !== 'null' && new URL(req.headers.origin).host !== req.headers.host) return send(res, 403, { error: 'Forbidden origin.' });
      const site = req.headers['sec-fetch-site'];
      if ((site === 'cross-site' || site === 'same-site') && /^\/(api|cache)\//.test(req.url || '')) return send(res, 403, { error: 'Forbidden: cross-site request.' });
      const url = new URL(req.url, 'http://local');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
      serveStatic(req, res, url);
    } catch (e) {
      const status = e.status || (e instanceof GmiError ? 502 : 500);
      if (status === 500) console.error('[server]', e.stack || e.message);
      if (!res.headersSent) send(res, status, { error: e.message || 'Something went wrong.' });
      else res.end();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(config.port, config.host, () => {
    console.log(`PanelShow is running at http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`);
    if (!config.apiKey) console.log('GMI_API_KEY is not set: copy .env.example to .env and add your key, then restart.');
  });
}
