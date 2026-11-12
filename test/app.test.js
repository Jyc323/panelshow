// End-to-end tests against the stand-in GMI server. No network and no real key are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { createFakeGmi } from './fake-gmi.js';
import { config } from '../server/config.js';
import { resetStore, resetCapabilities, setCapability } from '../server/store.js';
import { createServer } from '../server/index.js';
import { sanitizePath } from '../server/files.js';
import { isPrivateAddress, assertPublicUrl, extractUrls } from '../server/resources.js';
import { parseReply, contextText, isPass, addressees } from '../server/prompt.js';
import { readVerdict, judgePrompt } from '../server/judge.js';
import { hasFfmpeg } from '../server/media.js';
import { chat } from '../server/gmi.js';
import { describeModel, buildShortlist, fillByRules, validatePicks } from '../server/casting.js';
import { resolveTarget, redactSecrets } from '../server/workspace.js';

const KEY = 'test-key-SECRET-123';
let fake, app, base, site, siteUrl;

// A noisy PNG large enough to count as a real picture.
function png(w = 64, h = 64) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let r = 0xffffffff;
    for (const b of buf) r = crcTable[(r ^ b) & 255] ^ (r >>> 8);
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
  for (let y = 0; y < h; y++) rows.push(Buffer.from([0]), Buffer.from(Array.from({ length: w * 3 }, (_, i) => (i * 37 + y * 91 + ((i * y) % 13) * 17) % 256)));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

test.before(async () => {
  // A throwaway home folder: tests create folders "in the home folder" and must never touch the real one.
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-home-'));
  fake = await createFakeGmi();
  config.baseUrl = fake.url;
  config.apiKey = KEY;
  config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrt-test-'));
  config.allowPrivateUrls = true; // the test web site is on 127.0.0.1
  config.autoProbe = false; // probes would add requests the tests do not expect
  resetStore();
  resetCapabilities();
  app = createServer();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.address().port}`;
  site = http.createServer((req, res) => {
    if (req.url === '/article') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<html><head><title>Tea study</title><meta name="description" content="A study about tea"></head><body><article><h1>Tea study</h1><p>${'Green tea was measured in 40 people over eight weeks and the ZEBRA-MARKER result was a small drop in heart rate. '.repeat(4)}</p><img src="/pic.png" alt="chart of results" width="640" height="480"></article></body></html>`);
    }
    if (req.url === '/pic.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(png());
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
});

test.after(async () => {
  await fake.close();
  await new Promise((r) => app.close(r));
  await new Promise((r) => site.close(r));
});

const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, text, json: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null };
};

async function newRoom(...members) {
  const room = (await call('POST', '/api/rooms', { title: 'Test room' })).json;
  const out = [];
  for (const [name, model] of members) out.push((await call('POST', `/api/rooms/${room.id}/members`, { name, model })).json);
  return { id: room.id, members: out };
}

async function say(roomId, text, extra = {}) {
  const r = await call('POST', `/api/rooms/${roomId}/send`, { text, ...extra });
  assert.equal(r.status, 202, r.text);
  return settle(roomId);
}

async function settle(roomId) {
  for (let i = 0; i < 400; i++) {
    const { room } = (await call('GET', `/api/rooms/${roomId}`)).json;
    if (!room.running) return room;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the run did not finish');
}

const requestsFor = (model, from = 0) => fake.requests.slice(from).filter((r) => r.body.model === model);
const flat = (req) => JSON.stringify(req.body.messages);

test('roundtable: each member sees what was said before, labelled by name', async () => {
  const mark = fake.requests.length;
  const { id } = await newRoom(['Opti', 'demo/optimist'], ['Skep', 'demo/skeptic']);
  const room = await say(id, 'Should we ship on Friday?');
  const replies = room.messages.filter((m) => m.role === 'member');
  assert.deepEqual(replies.map((m) => [m.name, m.status]), [['Opti', 'done'], ['Skep', 'done']]);
  const second = requestsFor('demo/skeptic', mark)[0];
  assert.match(flat(second), /\[Host\]: Should we ship on Friday\?/);
  assert.match(flat(second), /\[Opti\]: I like/);
  assert.ok(!second.body.messages.some((m) => m.role === 'assistant'), 'another member must not appear as the assistant');
  assert.equal(second.body.frequency_penalty, undefined);
  assert.equal(second.auth, `Bearer ${KEY}`);
  assert.ok(replies[0].usage.completion > 0);
});

test('the key never appears in anything the server returns or stores', async () => {
  const rooms = (await call('GET', '/api/rooms')).json;
  for (const r of rooms) assert.ok(!(await call('GET', `/api/rooms/${r.id}`)).text.includes(KEY));
  assert.ok(!(await call('GET', '/api/health')).text.includes(KEY));
  assert.ok(!(await call('GET', '/api/models')).text.includes(KEY));
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const f of walk(config.dataDir)) assert.ok(!fs.readFileSync(f).includes(KEY), `${f} contains the key`);
});

test('parallel: members answer without seeing each other', async () => {
  const mark = fake.requests.length;
  const { id } = await newRoom(['Opti', 'demo/optimist'], ['Skep', 'demo/skeptic']);
  await say(id, 'Tabs or spaces?', { mode: 'parallel' });
  const a = requestsFor('demo/optimist', mark)[0];
  const b = requestsFor('demo/skeptic', mark)[0];
  assert.ok(!flat(a).includes('[Skep]:') && !flat(b).includes('[Opti]:'));
  assert.match(flat(a), /cannot see their replies yet/);
});

test('relay: a reply that mentions @Name hands the floor over', async () => {
  const { id } = await newRoom(['Opti', 'demo/optimist'], ['Skep', 'demo/skeptic'], ['Third', 'demo/optimist']);
  fake.queue('demo/optimist', 'My part is done. @Skep please check it.');
  fake.queue('demo/skeptic', 'Checked. Nothing more to add.');
  const room = await say(id, 'Start the relay.', { mode: 'relay' });
  assert.deepEqual(room.messages.filter((m) => m.role === 'member').map((m) => m.name), ['Opti', 'Skep']);
});

test('a member writes a file; the next member is given its content; bad paths are refused', async () => {
  const mark = fake.requests.length;
  const { id } = await newRoom(['Writer', 'demo/writer'], ['Skep', 'demo/skeptic']);
  fake.queue('demo/writer', 'Two files.\n<<<FILE notes/plan.md>>>\n# Plan\nUNIQUE-PLAN-LINE\n<<<END FILE>>>\n<<<FILE ../../evil.txt>>>\nnope\n<<<END FILE>>>');
  const room = await say(id, 'Write a plan.');
  const w = room.messages.find((m) => m.name === 'Writer');
  assert.equal(w.files[0].path, 'notes/plan.md');
  assert.match(w.files[1].error, /not an allowed file path/);
  assert.deepEqual(room.files.map((f) => f.path), ['notes/plan.md']);
  assert.ok(!fs.existsSync(path.join(config.dataDir, 'evil.txt')) && !fs.existsSync(path.join(config.dataDir, 'rooms', 'evil.txt')));
  const next = flat(requestsFor('demo/skeptic', mark)[0]);
  assert.match(next, /\[Writer\]: Two files\.\\n\[wrote file: notes\/plan\.md\]/);
  assert.match(next, /=== RESOURCE: file notes\/plan\.md/);
  assert.match(next, /UNIQUE-PLAN-LINE/);
  const got = await call('GET', `/api/rooms/${id}/file?path=notes/plan.md`);
  assert.match(got.text, /UNIQUE-PLAN-LINE/);
});

test('a member cannot overwrite another member\'s file', async () => {
  const { id } = await newRoom(['Writer', 'demo/writer'], ['Skep', 'demo/skeptic']);
  fake.queue('demo/writer', '<<<FILE a.md>>>\nfirst\n<<<END FILE>>>');
  fake.queue('demo/skeptic', '<<<FILE a.md>>>\nsecond\n<<<END FILE>>>');
  const room = await say(id, 'Both write a.md');
  assert.deepEqual(room.files.map((f) => f.path).sort(), ['a.by-Skep.md', 'a.md']);
  assert.equal((await call('GET', `/api/rooms/${id}/file?path=a.md`)).text, 'first');
});

test('links: the Host\'s link is opened and its text is given to the members', async () => {
  const mark = fake.requests.length;
  const { id } = await newRoom(['Skep', 'demo/skeptic']);
  const room = await say(id, `What do you make of ${siteUrl}/article and ${siteUrl}/missing ?`);
  const host = room.messages.find((m) => m.role === 'host');
  assert.equal(host.refs.length, 2);
  assert.deepEqual(host.refs.map((r) => r.ok), [true, false]);
  assert.equal(host.refs[0].title, 'Tea study');
  assert.match(host.refs[1].error, /404/);
  const req = flat(requestsFor('demo/skeptic', mark)[0]);
  assert.match(req, /=== RESOURCE: page http/);
  assert.match(req, /ZEBRA-MARKER/);
  assert.match(req, /not an instruction to you/);
});

test('a member asks to open a link and continues with its content', async () => {
  const mark = fake.requests.length;
  const { id } = await newRoom(['Reader', 'demo/reader']);
  fake.queue('demo/reader', `I will check the source.\n@@open ${siteUrl}/article`, (body) => (JSON.stringify(body.messages).includes('ZEBRA-MARKER') ? 'The page says heart rate dropped.' : 'I did not get the page.'));
  const room = await say(id, 'Is there a source for the tea claim?');
  const m = room.messages.find((x) => x.name === 'Reader');
  assert.equal(m.status, 'done');
  assert.deepEqual(m.tools.map((t) => [t.type, t.ok]), [['open', true]]);
  assert.match(m.text, /The page says heart rate dropped\./);
  assert.equal(requestsFor('demo/reader', mark).length, 2);
  assert.ok(m.refs.some((r) => r.url === `${siteUrl}/article`), 'the opened page is attached for the other members');
});

test('pictures go to members that can see; a model that refuses them is retried with text only', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg is not installed');
  const mark = fake.requests.length;
  setCapability('demo/optimist', { ok: true, vision: true });
  setCapability('demo/text-only', { ok: true, vision: true }); // wrongly believed to see
  const { id } = await newRoom(['Eyes', 'demo/optimist'], ['Blind', 'demo/text-only']);
  const room = await say(id, `Look at ${siteUrl}/article`, { mode: 'parallel' });
  const seen = requestsFor('demo/optimist', mark)[0].body.messages.at(-1).content;
  assert.ok(Array.isArray(seen) && seen.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/jpeg;base64,')));
  const blind = room.messages.find((m) => m.name === 'Blind');
  assert.equal(blind.status, 'done');
  assert.match(blind.notes.join(' '), /refused the attached pictures/);
  const retry = requestsFor('demo/text-only', mark).at(-1);
  assert.ok(!JSON.stringify(retry.body.messages).includes('image_url'));
});

test('a provider error shows the provider\'s own detail; the other members still answer', async () => {
  const { id } = await newRoom(['Opti', 'demo/optimist'], ['Skep', 'demo/skeptic']);
  fake.queue('demo/optimist', { status: 400, error: { message: 'Backend request failed with status 400', details: 'Penalty is not enabled for this model' } });
  const room = await say(id, 'Hello');
  const [a, b] = room.messages.filter((m) => m.role === 'member');
  assert.equal(a.status, 'error');
  assert.match(a.error, /GMI 400/);
  assert.match(a.error, /Penalty is not enabled for this model/);
  assert.equal(b.status, 'done');
});

test('PASS ends a roundtable early', async () => {
  const mark = fake.requests.length;
  const { id } = await newRoom(['Opti', 'demo/optimist'], ['Skep', 'demo/skeptic']);
  fake.queue('demo/optimist', 'One point.', 'PASS');
  fake.queue('demo/skeptic', 'Agreed.', 'pass.');
  const room = await say(id, 'Discuss.', { rounds: 5 });
  assert.equal(fake.requests.length - mark, 4);
  assert.equal(room.messages.filter((m) => m.pass).length, 2);
});

test('judge: candidates are anonymous, own replies are left out, scores are combined', async () => {
  const { id, members } = await newRoom(['Opti', 'demo/optimist'], ['Skep', 'demo/skeptic'], ['Writer', 'demo/writer']);
  fake.queue('demo/optimist', 'As Opti (demo/optimist) I say: yes.');
  const room = await say(id, 'Opti, Skep and Writer: is tea healthy?', { mode: 'parallel' });
  const ids = room.messages.filter((m) => m.role === 'member').map((m) => m.id);
  const mark = fake.requests.length;
  const r = await call('POST', `/api/rooms/${id}/judge`, { messageIds: ids, judgeIds: members.map((m) => m.id), rubric: 'general' });
  assert.equal(r.status, 202, r.text);
  const after = await settle(id);
  const card = after.messages.at(-1);
  assert.equal(card.kind, 'verdict');
  assert.equal(card.status, 'done');
  const judgeRequests = fake.requests.slice(mark);
  assert.equal(judgeRequests.length, 3);
  for (const q of judgeRequests) {
    const s = flat(q);
    for (const m of members) assert.ok(!new RegExp(`\\b${m.name}\\b`).test(s), `judge request leaks the name ${m.name}`);
    assert.ok(!/demo\/(optimist|skeptic|writer)/.test(s), 'judge request leaks a model id');
    assert.equal((s.match(/=== Candidate [A-L] ===/g) || []).length, 2, 'a judge does not score its own reply');
  }
  assert.equal(card.verdict.rows.length, 3);
  assert.ok(card.verdict.rows.every((row) => row.mean >= 1 && row.mean <= 10 && row.judges === 2));
  assert.match(card.text, /A panel of 3 judge/);
});

test('uploads: text is readable by members; other kinds are refused', async () => {
  const mark = fake.requests.length;
  const { id } = await newRoom(['Reader', 'demo/reader']);
  const up = await fetch(`${base}/api/rooms/${id}/upload?name=${encodeURIComponent('brief notes.txt')}`, { method: 'POST', body: 'UPLOAD-MARKER the brief says ship in May' });
  assert.equal(up.status, 201);
  const entry = await up.json();
  assert.equal(entry.path, 'uploads/brief notes.txt');
  const bad = await fetch(`${base}/api/rooms/${id}/upload?name=x.bin`, { method: 'POST', body: Buffer.from([0, 1, 2, 0, 0]) });
  assert.equal(bad.status, 400);
  await say(id, 'What does the brief say?', { attachments: [entry.path] });
  assert.match(flat(requestsFor('demo/reader', mark)[0]), /UPLOAD-MARKER/);
});

test('uploads: PDF and Word files are turned into text', async () => {
  const { id } = await newRoom(['Reader', 'demo/reader']);
  for (const [name, marker] of [['report.pdf', 'PDF-MARKER'], ['brief.docx', 'DOCX-MARKER']]) {
    const up = await fetch(`${base}/api/rooms/${id}/upload?name=${name}`, { method: 'POST', body: fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)) });
    assert.equal(up.status, 201);
    const entry = await up.json();
    assert.match((await call('GET', `/api/rooms/${id}/file?path=${encodeURIComponent(entry.path)}`)).text, new RegExp(marker));
  }
});

test('requests from another site or host name are refused', async () => {
  const res = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('units: paths, private addresses, reply parsing, verdict checking', async () => {
  assert.equal(sanitizePath('notes/a b.md'), 'notes/a b.md');
  for (const bad of ['../x', '/etc/passwd', 'a/../../b', '.env', 'a/.git/x', 'a\\..\\b', '', 'x'.repeat(200), 'a/b/c/d/e.txt']) assert.equal(sanitizePath(bad), bad === '/etc/passwd' ? 'etc/passwd' : null, bad);
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '0.0.0.0']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.ok(!isPrivateAddress(ip), ip);
  config.allowPrivateUrls = false;
  try {
    await assert.rejects(assertPublicUrl('http://127.0.0.1:8790/api/rooms'), /private network/);
    await assert.rejects(assertPublicUrl('http://localhost/'), /private network/);
    await assert.rejects(assertPublicUrl('file:///etc/passwd'), /only http/);
    await assert.rejects(assertPublicUrl('http://user:pw@8.8.8.8/'), /user name/);
  } finally {
    config.allowPrivateUrls = true;
  }
  const reply = 'Intro\n<<<FILE a.md>>>\n```js\n@@open http://inside-a-file\n```\n<<<END FILE>>>\nSee https://x.test/a, and (https://y.test/b).\n@@read a.md\n@@open https://x.test/a';
  const p = parseReply(reply);
  assert.deepEqual(p.files.map((f) => f.path), ['a.md']);
  assert.deepEqual(p.directives, [{ type: 'read', arg: 'a.md' }, { type: 'open', arg: 'https://x.test/a' }]);
  // Inline requests after a sentence (some models write them that way), two on a line, trailing punctuation, code spans ignored.
  const inline = parseReply('I will read the core file.@@read app/server/x.js\nNext: @@read app/a.js:1-20 @@list app/src.\nUse `@@read not/this.js` to read.\n@@search parse config in app/src');
  assert.deepEqual(inline.directives, [{ type: 'read', arg: 'app/server/x.js' }, { type: 'read', arg: 'app/a.js:1-20' }, { type: 'list', arg: 'app/src' }, { type: 'search', arg: 'parse config in app/src' }]);
  assert.equal(contextText('Reading now.@@read app/x.js'), 'Reading now.');
  assert.deepEqual(parseReply('Next:\n```text\n@@read app/b.js\n```').directives, [{ type: 'read', arg: 'app/b.js' }], 'requests inside a code block count (some models write them that way)');
  assert.equal(contextText(reply, [{ path: 'a.md' }]), 'Intro\n[wrote file: a.md]\nSee https://x.test/a, and (https://y.test/b).');
  assert.deepEqual(extractUrls(contextText(reply, [{ path: 'a.md' }])), ['https://x.test/a', 'https://y.test/b']);
  assert.deepEqual(extractUrls('see https://en.wikipedia.org/wiki/Rust_(programming_language) and (https://x.test/c), also https://x.test/d).'), ['https://en.wikipedia.org/wiki/Rust_(programming_language)', 'https://x.test/c', 'https://x.test/d']);
  assert.ok(isPass(' PASS. ') && !isPass('I pass on that, but here is a thought'));
  const ok = readVerdict('```json\n{"scores":[{"candidate":"A","criterion":"accuracy","score":7},{"candidate":"Candidate B","criterion":"Accuracy","score":9}],"ranking":["B","A"],"summary":"s"}\n```', ['A', 'B'], ['Accuracy']);
  assert.deepEqual(ok.result.scores, { A: { Accuracy: 7 }, B: { Accuracy: 9 } });
  assert.match(readVerdict('{"scores":[{"candidate":"A","criterion":"Accuracy","score":7}],"ranking":["A","B"]}', ['A', 'B'], ['Accuracy']).error, /missing score for candidate B/);
  assert.match(readVerdict('{"scores":[{"candidate":"A","criterion":"Accuracy","score":7},{"candidate":"B","criterion":"Accuracy","score":70}],"ranking":["A","B"]}', ['A', 'B'], ['Accuracy']).error, /missing score/);
  assert.match(readVerdict('no json here', ['A'], ['Accuracy']).error, /no json/);
});

// ---------- smart invite ----------

const vendorOf = (id) => describeModel(id).vendor.toLowerCase();

test('invite several models in one request; a bad entry adds none', async () => {
  const room = (await call('POST', '/api/rooms', { title: 'Batch' })).json;
  const r = await call('POST', `/api/rooms/${room.id}/members`, { members: [{ name: 'Opti', model: 'demo/optimist' }, { name: 'Skep', model: 'demo/skeptic', role: 'Skeptic' }] });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.json.members.map((m) => m.name), ['Opti', 'Skep']);
  const bad = await call('POST', `/api/rooms/${room.id}/members`, { members: [{ name: 'Writer', model: 'demo/writer' }, { name: 'opti', model: 'demo/reader' }] });
  assert.equal(bad.status, 400);
  const after = (await call('GET', `/api/rooms/${room.id}`)).json.room;
  assert.deepEqual(after.members.map((m) => m.name), ['Opti', 'Skep'], 'nothing from the failed batch was added');
  const many = Array.from({ length: 7 }, (_, i) => ({ name: `M${i}`, model: 'demo/writer' }));
  assert.equal((await call('POST', `/api/rooms/${room.id}/members`, { members: many })).status, 400, 'room limit of 8');
});

test('model facts from ids: vendor aliases, exclusions, tags', () => {
  assert.equal(vendorOf('deepseek-ai/DeepSeek-V4-Pro'), vendorOf('DeepSeek-R1-0528'));
  assert.equal(vendorOf('zai-org/GLM-5.3'), vendorOf('GLM-4.7-FP8'));
  for (const id of ['laion/CLIP-ViT-B-32-laion2B-s34B-b79K', 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B', 'Kling-Text2Video-V2.1-Master', 'seedream-4-0-250828', 'inworld-tts-2']) assert.ok(describeModel(id).exclude, id);
  for (const id of ['openai/gpt-6-sol', 'Qwen/Qwen3.7-Max', 'moonshotai/Kimi-K2-Thinking', 'google/gemini-3.8-flash']) assert.equal(describeModel(id).exclude, '', id);
  assert.ok(describeModel('moonshotai/Kimi-K2-Thinking').tags.reasoning);
  assert.ok(describeModel('google/gemini-3.8-flash').tags.fast);
  // Shortlist: vendors already in the room and failed models are left out; at most 2 per vendor.
  const models = ['Qwen/Qwen3.7-Max', 'Qwen/Qwen3.8-Flash', 'Qwen/Qwen3.5-27B', 'deepseek-ai/DeepSeek-V4-Pro', 'openai/gpt-6-sol', 'zai-org/GLM-5.3'].map((id) => ({ id }));
  const list = buildShortlist(models, { 'zai-org/GLM-5.3': { ok: false } }, { members: [{ model: 'openai/gpt-5.6-sol' }], messages: [] });
  const ids = list.map((d) => d.id);
  assert.ok(!ids.includes('openai/gpt-6-sol') && !ids.includes('zai-org/GLM-5.3'), ids.join());
  assert.equal(ids.filter((i) => i.startsWith('Qwen/')).length, 2);
  assert.equal(list[0].vendor === 'Qwen' ? list[0].id : ids.find((i) => i.startsWith('Qwen/')), 'Qwen/Qwen3.7-Max', 'flagship first within a vendor');
  // Director output is checked: unknown ids, duplicate vendors and extra members are dropped.
  const picks = validatePicks({ members: [{ model: 'made/up' }, { model: 'Qwen/Qwen3.7-Max' }, { model: 'Qwen/Qwen3.8-Flash' }, { model: 'deepseek-ai/DeepSeek-V4-Pro' }] }, list, 5);
  assert.deepEqual(picks.map((p) => p.id), ['Qwen/Qwen3.7-Max', 'deepseek-ai/DeepSeek-V4-Pro']);
  const caps = { 'deepseek-ai/DeepSeek-V4-Pro': { ok: true, vision: true } };
  const filled = fillByRules([], list, 6, { needVision: true, caps });
  assert.equal(new Set(filled.map((p) => p.vendor)).size, filled.length, 'one per vendor after rule filling');
});

test('smart invite: probes only unknown candidates, one model per vendor, director checked and repaired', async () => {
  const room = (await call('POST', '/api/rooms', { title: 'Smart' })).json;
  await call('POST', `/api/rooms/${room.id}/members`, { name: 'Opti', model: 'demo/optimist' });
  const mark = fake.requests.length;
  const cost = await call('GET', `/api/rooms/${room.id}/suggest`);
  assert.equal(cost.status, 200, cost.text);
  assert.equal(fake.requests.length, mark, 'asking for the cost makes no model calls');
  const r = await call('POST', `/api/rooms/${room.id}/suggest`, { topic: 'How should an indie creator price a course?', count: 6 });
  assert.equal(r.status, 200, r.text);
  const s = r.json;
  const ids = s.members.map((m) => m.model);
  assert.ok(s.director, 'a director was chosen');
  assert.equal(new Set(ids.map(vendorOf)).size, ids.length, 'one per vendor');
  assert.ok(!ids.some((id) => id.startsWith('demo/')), 'the vendor already in the room is not proposed again');
  assert.ok(!ids.some((id) => id.startsWith('broken/') || id.startsWith('pixel/')), 'failed and non-chat models are not proposed');
  assert.deepEqual(new Set(ids.map(vendorOf)), new Set(['northwind', 'lumen', 'orbit', 'kite']));
  for (const m of s.members) assert.match(m.name, /^[A-Za-z0-9_.-]{1,24}$/);
  const probed = new Set(fake.requests.slice(mark).filter((q) => q.body.max_tokens === 1024).map((q) => q.body.model));
  assert.ok(!probed.has('pixel/pixel-1-image') && !probed.has('demo/skeptic'), [...probed].join());
  // Second time: everything is known, so only the planning request is made.
  const mark2 = fake.requests.length;
  const again = (await call('POST', `/api/rooms/${room.id}/suggest`, { topic: 'Same topic', count: 6 })).json;
  assert.equal(again.probed, 0);
  assert.equal(fake.requests.length - mark2, 1);
  // A director that answers garbage twice: the rules still produce a full, valid proposal.
  fake.queue(again.director, 'no idea', '{"members":[{"model":"made/up"}]}');
  const rules = (await call('POST', `/api/rooms/${room.id}/suggest`, { topic: 'Same topic', count: 6 })).json;
  assert.match(rules.note, /simple rules/);
  assert.equal(rules.members.length, 4, rules.members.map((m) => m.model).join());
  assert.equal(new Set(rules.members.map((m) => vendorOf(m.model))).size, 4);
  assert.ok(rules.members.every((m) => m.role && m.reason), 'rule picks still get a role and a reason');
  // Invite the proposal in one go.
  const add = await call('POST', `/api/rooms/${room.id}/members`, { members: s.members.map(({ name, model, role }) => ({ name, model, role })) });
  assert.equal(add.status, 201, add.text);
  assert.equal((await call('GET', `/api/rooms/${room.id}`)).json.room.members.length, 5);
});

test('vision probe: accepting an image is not enough, the model must see it', async () => {
  fake.queue('orbit/orbit-4-max', 'OK', 'I cannot tell.');
  const r = (await call('POST', '/api/probe', { model: 'orbit/orbit-4-max' })).json;
  assert.equal(r.ok, true);
  assert.equal(r.vision, false);
  assert.match(r.visionError, /did not see it/);
  const ok = (await call('POST', '/api/probe', { model: 'northwind/atlas-3-pro' })).json;
  assert.equal(ok.vision, true);
});

// ---------- @all and @Role ----------

const replies = (room) => room.messages.filter((m) => m.role === 'member');

test('relay: a member asks @all, the others answer at once without seeing each other, then the floor returns', async () => {
  const mark = fake.requests.length;
  const { id } = await newRoom(['Opti', 'demo/optimist'], ['Skep', 'demo/skeptic'], ['Writer', 'demo/writer']);
  fake.queue('demo/optimist', 'Quick poll before I decide. @all is Friday too early?', 'Thanks both. Decision: we ship on Monday.');
  fake.queue('demo/skeptic', 'SKEPTIC-ANSWER: yes, too early.');
  fake.queue('demo/writer', 'WRITER-ANSWER: Friday is fine.');
  const room = await say(id, '@Opti should we ship on Friday?', { mode: 'relay', maxHops: 6 });
  const r = replies(room);
  assert.deepEqual(r.map((m) => m.name).sort(), ['Opti', 'Opti', 'Skep', 'Writer']);
  assert.equal(r[0].name, 'Opti');
  assert.equal(r[3].name, 'Opti', 'the floor comes back to the member who asked');
  assert.match(r[3].text, /we ship on Monday/);
  const skep = requestsFor('demo/skeptic', mark)[0];
  const writer = requestsFor('demo/writer', mark)[0];
  assert.ok(!flat(skep).includes('WRITER-ANSWER') && !flat(writer).includes('SKEPTIC-ANSWER'), 'answers in the same step are blind');
  assert.match(flat(skep), /Opti asked several members at once/);
  const back = requestsFor('demo/optimist', mark)[1];
  assert.ok(flat(back).includes('SKEPTIC-ANSWER') && flat(back).includes('WRITER-ANSWER'), 'the asker sees every answer');
});

test('relay: @all from the Host asks everyone at once, then it is the Host\'s turn', async () => {
  const { id } = await newRoom(['Opti', 'demo/optimist'], ['Skep', 'demo/skeptic'], ['Writer', 'demo/writer']);
  const mark = fake.requests.length;
  fake.queue('demo/optimist', 'OPTI-LINE: tabs. Over to @Skep.');
  fake.queue('demo/skeptic', 'SKEP-LINE: spaces. I hand this to @Opti.');
  const room = await say(id, '@all one line each: tabs or spaces?', { mode: 'relay', maxHops: 6 });
  assert.deepEqual(replies(room).map((m) => m.name).sort(), ['Opti', 'Skep', 'Writer'], 'one answer each, hand-overs ignored');
  for (const model of ['demo/optimist', 'demo/skeptic', 'demo/writer']) {
    const req = flat(requestsFor(model, mark)[0]);
    assert.ok(!req.includes('OPTI-LINE') && !req.includes('SKEP-LINE'), `${model} answered blind`);
  }
});

test('@Role addresses every member with that role; role names reach the members', async () => {
  const room = (await call('POST', '/api/rooms', { title: 'Roles' })).json;
  const add = await call('POST', `/api/rooms/${room.id}/members`, { members: [
    { name: 'Opti', model: 'demo/optimist', roleName: 'Skeptic', role: 'Doubt everything.' },
    { name: 'Skep', model: 'demo/skeptic', role: 'Skeptic: ask for evidence.' },
    { name: 'Writer', model: 'demo/writer', roleName: 'Writer' },
  ] });
  assert.equal(add.status, 201, add.text);
  const mark = fake.requests.length;
  const done = await say(room.id, '@skeptics what could go wrong?', { mode: 'roundtable' });
  assert.deepEqual(replies(done).map((m) => m.name), ['Opti', 'Skep']);
  const sys = requestsFor('demo/optimist', mark)[0].body.messages[0].content;
  assert.match(sys, /Writer \(demo\/writer\), role: Writer/);
  const ms = [{ name: 'A', roleName: 'Fact checker' }, { name: 'B', role: 'Fact checker: check.' }, { name: 'C' }];
  assert.deepEqual(addressees('@fact-checker please', ms).list.map((m) => m.name), ['A', 'B']);
  assert.equal(addressees('@fact-checker please', ms).broadcast, true);
  assert.deepEqual(addressees('mail a@b.com or @C', ms).list.map((m) => m.name), ['C']);
  assert.deepEqual(addressees('请 @版权审查员 看一下', [{ name: 'D', role: '版权审查员: 核查授权' }, { name: 'E' }]).list.map((m) => m.name), ['D']);
});

test('judges are told that [a member] placeholders come from anonymisation, not from the candidate', () => {
  const p = judgePrompt({ task: 't', criteria: ['Clarity: clear?'], candidates: [{ label: 'A', text: 'Ask [a member].' }], extra: '' });
  const all = JSON.stringify(p);
  assert.match(all, /placeholders are not the candidate.s mistakes/);
});

// ---------- shared project folders (read-only) ----------

function makeProject() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-proj-'));
  const root = path.join(base, 'proj');
  const w = (rel, text) => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };
  w('src/app.js', ['// app', 'function greet(name) {', "  return 'hi ' + name;", '}', 'module.exports = { greet };'].join('\n') + '\n');
  w('README.md', '# Proj\n');
  w('.env', 'API_KEY=SUPER-SECRET-VALUE\n');
  w('.env.example', 'API_KEY=\n');
  w('node_modules/lib/index.js', 'function greet() {}\n');
  w('.gitignore', 'logs/\n*.log\nnotes-private.txt\n!keep.log\n');
  w('logs/a.txt', 'greet in logs');
  w('debug.log', 'greet debug');
  w('keep.log', 'kept');
  w('notes-private.txt', 'greet hidden');
  w('id_rsa', 'PRIVATE KEY');
  w('sub/.gitignore', 'generated.js\n');
  w('sub/generated.js', 'function greet() {}');
  w('sub/real.js', 'greet(1)\n');
  fs.writeFileSync(path.join(root, 'img.png'), Buffer.from([137, 80, 78, 71, 0, 0, 0, 1]));
  fs.writeFileSync(path.join(base, 'outside.txt'), 'OUTSIDE-SECRET');
  w('config.json', '{ "apiKey": "a1b2c3d4e5f6g7h8i9j0k1", "password": "correct-horse-battery-staple", "name": "proj" }\n');
  w('secrets/settings.json', '{ "plain": "SECRET-DIR-CONTENT" }'); // ordinary name inside a secret-named folder
  fs.writeFileSync(path.join(base, 'outside-ignore'), 'real.js\n');
  try {
    fs.linkSync(path.join(base, 'outside-ignore'), path.join(root, 'sub', '.panelshowignore')); // a hard-linked ignore file must not be read
  } catch {
    /* hard links not allowed here */
  }
  fs.writeFileSync(path.join(root, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('secret notes', 'utf16le')]));
  fs.writeFileSync(path.join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9])); // "café" in Latin-1, not UTF-8
  w('.panelshowignore', 'private/\n');
  w('private/plan.md', 'greet plan PRIVATE-PLAN');
  try {
    fs.linkSync(path.join(base, 'outside.txt'), path.join(root, 'notes.txt')); // a hard link to a file outside the folder
  } catch {
    /* hard links not allowed here */
  }
  try {
    fs.symlinkSync(base, path.join(root, 'link-out'));
  } catch {
    /* symlinks not allowed here: the read check below still covers ".." */
  }
  return { base, root };
}

test('shared folder: only safe files are listed and readable; nothing outside can be reached', async () => {
  const { base, root } = makeProject();
  const room = (await call('POST', '/api/rooms', { title: 'Folder' })).json;
  for (const bad of ['', '/', os.homedir(), path.join(base, 'nope'), path.join(root, 'README.md'), path.join(root, 'node_modules')]) {
    assert.equal((await call('POST', `/api/rooms/${room.id}/folders`, { path: bad })).status, 400, `refuses ${bad}`);
  }
  const add = await call('POST', `/api/rooms/${room.id}/folders`, { path: root });
  assert.equal(add.status, 201, add.text);
  assert.equal(add.json.name, 'proj');
  assert.equal((await call('POST', `/api/rooms/${room.id}/folders`, { path: root })).status, 400, 'no duplicates');
  const info = (await call('GET', `/api/rooms/${room.id}/folders/${add.json.id}`)).json;
  assert.deepEqual(info.paths.map((p) => p.path).sort(), ['.env.example', '.gitignore', '.panelshowignore', 'README.md', 'config.json', 'keep.log', 'latin1.txt', 'src/app.js', 'sub/.gitignore', 'sub/real.js', 'utf16.txt']);
  const read = (p) => call('GET', `/api/rooms/${room.id}/folder-file?folder=${add.json.id}&path=${encodeURIComponent(p)}`);
  assert.equal((await read('src/app.js')).status, 200);
  for (const p of ['secrets/settings.json', '.env', '../outside.txt', 'link-out/outside.txt', 'notes.txt', 'private/plan.md', 'node_modules/lib/index.js', 'debug.log', 'logs/a.txt', 'notes-private.txt', 'sub/generated.js', 'id_rsa', 'img.png', '/etc/passwd']) {
    const r = await read(p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.text.includes('SECRET') && !r.text.includes('PRIVATE'), p);
  }
  const cfg = await read('config.json');
  assert.ok(!cfg.text.includes('a1b2c3d4e5f6g7h8i9j0k1') && cfg.text.includes('"apiKey": "[redacted]"') && cfg.text.includes('"name": "proj"'), 'credential values are redacted, the rest stays');
  assert.ok(!cfg.text.includes('correct-horse') && cfg.text.includes('"password": "[redacted]"'), 'a quoted password without digits is redacted too');
  assert.ok(info.paths.some((p) => p.path === 'latin1.txt'), 'listed (the scan does not decode), but not readable:');
  for (const p of ['utf16.txt', 'latin1.txt']) assert.equal((await read(p)).status, 404, `${p} is not readable as UTF-8 text`);
  const hidden = path.join(os.homedir(), `.panelshow-test-${process.pid}`);
  fs.mkdirSync(hidden, { recursive: true });
  try {
    assert.equal((await call('POST', `/api/rooms/${room.id}/folders`, { path: hidden })).status, 400, 'hidden folders in the home folder are refused');
  } finally {
    fs.rmSync(hidden, { recursive: true, force: true });
  }
  const room2 = { folders: [{ name: 'proj', path: root }] };
  for (const bad of ['C:/Windows/x', 'proj//etc', 'proj/../x']) assert.ok(resolveTarget(room2, bad).error, bad);
});

test('members read (line ranges), search and list a shared folder; secrets and absolute paths stay out', async () => {
  const { root } = makeProject();
  const { id } = await newRoom(['Opti', 'demo/optimist']);
  assert.equal((await call('POST', `/api/rooms/${id}/folders`, { path: root })).status, 201);
  const mark = fake.requests.length;
  fake.queue('demo/optimist', 'Let me look.\n@@read proj/src/app.js:2-3\n@@search greet\n@@list proj/sub', 'Seen it.\n@@read proj/.env', 'Done.');
  const room = await say(id, 'Review the code', { mode: 'roundtable' });
  const reqs = requestsFor('demo/optimist', mark);
  assert.equal(reqs.length, 3);
  const sys = reqs[0].body.messages[0].content;
  assert.match(sys, /Project folders \(read-only/);
  assert.match(sys, /\n\s+src\/\n\s+app\.js/);
  assert.ok(!/\n\s*\.env\s/.test(sys) && !sys.includes('node_modules') && !sys.includes('generated.js') && !sys.includes(root), 'no secrets, dependencies, ignored files or absolute paths in the tree');
  const second = flat(reqs[1]);
  assert.match(second, /2 \| function greet\(name\) \{/);
  assert.ok(!/[45] \| /.test(second), 'only the requested lines');
  assert.match(second, /lines 2-3 of 5, read-only/);
  assert.match(second, /proj\/src\/app\.js:2: function greet/);
  assert.match(second, /proj\/sub\/real\.js:1: greet\(1\)/);
  assert.ok(!second.includes('greet in logs') && !second.includes('greet debug') && !second.includes('greet hidden'), 'search skips ignored files');
  assert.match(second, /=== RESOURCE: proj\/sub ===\\n[^=]*real\.js  9 B/);
  const third = flat(reqs[2]);
  assert.ok(!third.includes('SUPER-SECRET-VALUE'));
  assert.match(third, /not a readable file/);
  assert.deepEqual(replies(room)[0].tools.map((t) => [t.type, t.ok]), [['read', true], ['search', true], ['list', true], ['read', false]]);
});

test('a member that keeps asking to read still answers when its reads run out; leaked tool markers are removed', async () => {
  const { root } = makeProject();
  const { id } = await newRoom(['Opti', 'demo/optimist']);
  assert.equal((await call('POST', `/api/rooms/${id}/folders`, { path: root })).status, 201);
  const mark = fake.requests.length;
  const ask = '@@read proj/README.md\n@@read proj/src/app.js\n@@read proj/sub/real.js';
  fake.queue('demo/optimist', `Reading.]<]minimax[>[<tool_call>\n<mm:think>Let me wait for the content.\n\nI should issue reads.</mm:think>\nmm:thinkStill waiting.\n\n<tool_call>\n${ask}`, ask, ask, ask, ask, ask, 'FINAL-ANSWER based on what I read.');
  const room = await say(id, 'Review it', { mode: 'roundtable' });
  const reqs = requestsFor('demo/optimist', mark);
  assert.equal(reqs.length, 7, 'five read steps (a shared folder allows more), then one last call for the answer');
  assert.match(flat(reqs[6]), /You have used all 20 reads for this turn/);
  const msg = replies(room)[0];
  assert.equal(msg.status, 'done');
  assert.match(msg.text, /FINAL-ANSWER/);
  assert.ok(!msg.text.includes(']<]minimax[>[') && !msg.text.includes('<tool_call>') && !msg.text.includes('mm:think') && !msg.text.includes('I should issue reads') && !msg.text.includes('Still waiting'), 'vendor markers and leaked thinking are cleaned');
  assert.equal(msg.tools.filter((t) => t.error === 'no reads left this turn').length, 3);
});

test('round 2 of the self-review: cross-site reads, a swapped root, PGP / Bearer secrets, room files, an empty answer', async () => {
  // Another site in the browser cannot read the API, not even with GET.
  assert.equal((await fetch(base + '/api/rooms', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(base + '/api/rooms', { headers: { Origin: 'http://evil.test' } })).status, 403);
  assert.equal((await fetch(base + '/api/rooms', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);

  // A shared folder that is later replaced by a link to somewhere else shares nothing.
  const { base: tmp, root } = makeProject();
  const room = (await call('POST', '/api/rooms', { title: 'Swap' })).json;
  const add = (await call('POST', `/api/rooms/${room.id}/folders`, { path: root })).json;
  const other = path.join(tmp, 'elsewhere');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'README.md'), 'STOLEN-CONTENT');
  fs.renameSync(root, root + '-moved');
  fs.symlinkSync(other, root);
  const info = (await call('GET', `/api/rooms/${room.id}/folders/${add.id}`)).json;
  assert.equal(info.paths.length, 0);
  const r = await call('GET', `/api/rooms/${room.id}/folder-file?folder=${add.id}&path=README.md`);
  assert.equal(r.status, 404);
  assert.ok(!r.text.includes('STOLEN'));

  // More credential shapes; uploads are redacted for members (the download stays the original).
  assert.equal(redactSecrets('-----BEGIN PGP PRIVATE KEY BLOCK-----\nabc\n-----END PGP PRIVATE KEY BLOCK-----\nx'), '[redacted private key]\n\n\nx');
  assert.equal(redactSecrets('"Authorization": "Bearer abcdefghijklmnop1234"'), '"Authorization": "Bearer [redacted]"');
  const up = await fetch(`${base}/api/rooms/${room.id}/upload?name=notes.txt`, { method: 'POST', body: 'DB_PASSWORD=hunter2hunter2\nother=1\n' });
  assert.equal(up.status, 201);
  const shown = await call('GET', `/api/rooms/${room.id}/file?path=uploads/notes.txt`);
  assert.ok(shown.text.includes('DB_PASSWORD=[redacted]') && !shown.text.includes('hunter2'));
  assert.ok((await call('GET', `/api/rooms/${room.id}/file?path=uploads/notes.txt&download=1`)).text.includes('hunter2'), 'the Host can still download the original');

  // A member that reads and then writes nothing is asked once for its answer.
  const { root: root2 } = makeProject();
  const { id } = await newRoom(['Opti', 'demo/optimist']);
  await call('POST', `/api/rooms/${id}/folders`, { path: root2 });
  const mark = fake.requests.length;
  fake.queue('demo/optimist', 'Reading.\n@@read proj/README.md', '', 'NUDGED-ANSWER');
  const done = await say(id, 'Review it', { mode: 'roundtable' });
  const reqs = requestsFor('demo/optimist', mark);
  assert.equal(reqs.length, 3);
  assert.match(flat(reqs[2]), /You wrote nothing after reading/);
  assert.match(replies(done)[0].text, /NUDGED-ANSWER/);
});

test('reads a streamed reply even when its header says JSON, and a plain JSON reply', async () => {
  fake.queue('demo/writer', { mislabeled: 'Hello from a mislabeled stream.' }, { json: 'Plain JSON reply.' });
  const ask = () => chat({ model: 'demo/writer', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal((await ask()).text, 'Hello from a mislabeled stream.');
  assert.equal((await ask()).text, 'Plain JSON reply.');
});
