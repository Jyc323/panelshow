// Read-only project folders on this computer that members can browse: a file tree, files (or line ranges),
// text search and directory listings. Nothing here ever writes to a shared folder.
//
// Safety rules:
// - Only files found by the scan can be read. The scan skips dependency and build folders, secrets
//   (.env, keys, credentials), binaries, symbolic links, and whatever .gitignore files exclude.
// - Files with more than one hard link are skipped (a hard link can point at a secret outside the folder).
// - Reads open the file without following links and check that it is the same file the scan saw
//   (same device and inode), so a file swapped for a link after the scan is refused.
// - Text that looks like a credential (private keys, API keys, passwords in config) is replaced by [redacted].
// - A .panelshowignore file (same syntax as .gitignore) lets the Host leave out more files.
// - Members see folder names, never the absolute path (which would reveal the user name).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_FOLDERS = 3;
const MAX_ENTRIES = 5000; // files and folders visited per scan
const MAX_FILE_BYTES = 1024 * 1024; // larger files are listed but not read
const SCAN_TTL_MS = 15000;

const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', 'bower_components', 'jspm_packages', 'vendor', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.turbo', '.vercel', '.cache', '.parcel-cache', 'coverage', '.nyc_output', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', 'target', 'Pods', 'DerivedData', '.gradle', '.idea', '.terraform', '.ssh', '.aws', '.gnupg', '.docker', '.kube', '.azure', '.gcloud', 'gcloud', 'gh', 'azure', 'configstore', '.password-store', 'keychains', 'Keychains', '1Password']);
const BINARY_EXT = new Set('png jpg jpeg gif webp bmp ico icns tif tiff psd ai sketch fig pdf doc docx xls xlsx ppt pptx key numbers pages zip gz tgz bz2 xz 7z rar tar jar war class dll exe so dylib a o obj bin dat iso dmg pkg deb rpm apk ipa wasm mp3 wav flac ogg m4a aac mp4 mov avi mkv webm woff woff2 ttf otf eot sqlite sqlite3 db pyc pyo lockb glb gltf fbx blend npy npz pt pth ckpt safetensors onnx parquet'.split(' '));
const SAFE_ENV = /^\.env\.(example|sample|template|dist|defaults)$/i;
const SECRET_FILE = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|crt|cer|der|asc|gpg|kdbx|ovpn|mobileprovision)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(npmrc|netrc|pypirc|htpasswd|pgpass|git-credentials|dockercfg)$/i,
  /(^|[._-])(secret|secrets|credential|credentials)([._-]|$)/i,
  /service[-_]?account.*\.json$/i,
  /\.tfstate(\.backup)?$/i,
];
const isSecret = (name) => !SAFE_ENV.test(name) && SECRET_FILE.some((re) => re.test(name));

// ---------- .gitignore ----------

function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end > i) {
        re += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = end;
      } else re += '\\[';
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return re;
}

/** Rules from one .gitignore: [{ re, negate, dirOnly }]. Later rules win. */
export function parseGitignore(text) {
  const rules = [];
  for (let line of String(text).split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    line = line.replace(/\s+$/, '');
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes('/');
    line = line.replace(/^\//, '');
    if (!line) continue;
    const body = globToRe(line);
    rules.push({ re: new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`), negate, dirOnly });
  }
  return rules;
}

function ignoredBy(sets, rel, isDir) {
  let ignored = false;
  for (const { base, rules } of sets) {
    if (base && !rel.startsWith(base + '/')) continue;
    const sub = base ? rel.slice(base.length + 1) : rel;
    for (const r of rules) if ((!r.dirOnly || isDir) && r.re.test(sub)) ignored = !r.negate;
  }
  return ignored;
}

// ---------- scanning ----------

const scans = new Map(); // real path -> { at, scan }

/** Read a small regular file without following links; null if it is a link, hard-linked, too large or unreadable. */
function readSmallFile(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink > 1 || st.size > maxBytes) return null;
    return fs.readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Walk a folder. Returns { files: [{rel, size}], dirs: [rel], skipped: {...}, truncated }.
 * Directories are visited in name order; skipped folders are not entered at all.
 */
/** The shared folder must still be the folder that was shared: not replaced by a link, not moved. */
function rootIntact(root) {
  try {
    return !fs.lstatSync(root).isSymbolicLink() && fs.realpathSync(root) === root;
  } catch {
    return false;
  }
}

export function scanFolder(root, { fresh = false } = {}) {
  const hit = scans.get(root);
  if (!fresh && hit && Date.now() - hit.at < SCAN_TTL_MS) return hit.scan;
  const scan = { files: [], dirs: [], skipped: { secret: 0, ignored: 0, binary: 0, links: 0, dependencies: 0, large: 0 }, truncated: false };
  if (!rootIntact(root)) {
    scan.moved = true; // the folder was replaced or moved: share nothing until the Host shares it again
    scans.set(root, { at: Date.now(), scan });
    return scan;
  }
  let visited = 0;
  const walk = (dirRel, sets) => {
    const dirAbs = path.join(root, dirRel);
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const name of ['.gitignore', '.panelshowignore']) {
      if (!entries.some((e) => e.name === name && e.isFile())) continue;
      const text = readSmallFile(path.join(dirAbs, name), 256 * 1024);
      if (text !== null) sets = [...sets, { base: dirRel, rules: parseGitignore(text) }];
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (visited >= MAX_ENTRIES) {
        scan.truncated = true;
        return;
      }
      visited++;
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        scan.skipped.links++;
        continue;
      }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) scan.skipped.dependencies++;
        else if (isSecret(e.name) || /^(secrets?|credentials?|private|keys)$/i.test(e.name)) scan.skipped.secret++; // secrets/, credentials/ …
        else if (ignoredBy(sets, rel, true)) scan.skipped.ignored++;
        else {
          scan.dirs.push(rel);
          walk(rel, sets);
        }
        continue;
      }
      if (!e.isFile()) continue;
      if (isSecret(e.name)) scan.skipped.secret++;
      else if (e.name === '.DS_Store' || ignoredBy(sets, rel, false)) scan.skipped.ignored++;
      else if (BINARY_EXT.has(path.extname(e.name).slice(1).toLowerCase())) scan.skipped.binary++;
      else {
        let st;
        try {
          st = fs.lstatSync(path.join(root, rel));
        } catch {
          continue;
        }
        if (!st.isFile() || st.nlink > 1) {
          scan.skipped.links++; // a hard link may lead outside the folder
          continue;
        }
        if (st.size > MAX_FILE_BYTES) scan.skipped.large++;
        scan.files.push({ rel, size: st.size, dev: st.dev, ino: st.ino });
      }
    }
  };
  walk('', []);
  scans.set(root, { at: Date.now(), scan });
  return scan;
}

// ---------- adding a folder ----------

const expandHome = (p) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

/** Check a folder the Host wants to share. Returns { path, name } or throws with a readable message. */
export function checkFolder(rawPath, existing = []) {
  const wanted = String(rawPath || '').trim();
  if (!wanted) throw new Error('Type the path of a folder, for example ~/code/my-app.');
  let real;
  try {
    real = fs.realpathSync(path.resolve(expandHome(wanted)));
  } catch {
    throw new Error(`There is no folder at ${wanted}.`);
  }
  if (!fs.statSync(real).isDirectory()) throw new Error(`${wanted} is a file, not a folder.`);
  const home = fs.realpathSync(os.homedir());
  if (real === path.parse(real).root || real === home || home.startsWith(real + path.sep)) throw new Error('That folder is too broad. Share a project folder, not your whole home folder or disk.');
  const name = path.basename(real);
  if (SKIP_DIRS.has(name) || isSecret(name)) throw new Error('That folder holds dependencies or secrets and cannot be shared.');
  // Hidden folders in the home folder (~/.config, ~/.local …) and ~/Library hold app settings and tokens, not projects.
  if (real.startsWith(home + path.sep)) {
    const first = path.relative(home, real).split(path.sep)[0];
    if (first.startsWith('.') || first === 'Library') throw new Error('Hidden and settings folders in your home folder (like ~/.config or ~/Library) cannot be shared: they hold app settings and tokens.');
  }
  const system = ['/etc', '/private/etc', '/bin', '/sbin', '/usr/bin', '/usr/sbin', '/usr/lib', '/System', '/Library', '/dev', '/proc', '/sys', '/boot', '/root'];
  if (system.some((s) => real === s || real.startsWith(s + path.sep)) && !real.startsWith(home + path.sep)) throw new Error('System folders cannot be shared.');
  if (existing.some((f) => f.path === real)) throw new Error('That folder is already shared in this room.');
  if (existing.length >= MAX_FOLDERS) throw new Error(`A room can share at most ${MAX_FOLDERS} folders.`);
  let label = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 40) || 'project';
  for (let i = 2; existing.some((f) => f.name.toLowerCase() === label.toLowerCase()); i++) label = `${label.replace(/-\d+$/, '')}-${i}`;
  return { id: crypto.randomUUID().replace(/-/g, '').slice(0, 10), name: label, path: real, addedAt: Date.now() };
}

export function folderSummary(folder) {
  const s = scanFolder(folder.path, { fresh: true });
  return { ...folder, files: s.files.length, bytes: s.files.reduce((n, f) => n + f.size, 0), skipped: s.skipped, truncated: s.truncated };
}

// ---------- what members see ----------

const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`);

/** An indented tree. Deep levels are folded into "dir/ (N files)" when the tree would be too long. */
export function renderTree(folder, maxChars = 5000) {
  const s = scanFolder(folder.path);
  const countUnder = (dir) => s.files.filter((f) => f.rel.startsWith(dir + '/')).length;
  for (let depth = 12; depth >= 1; depth--) {
    const lines = [];
    const items = [...s.dirs.map((rel) => ({ rel, dir: true })), ...s.files.map((f) => ({ rel: f.rel, size: f.size }))].sort((a, b) => {
      const pa = a.rel.split('/');
      const pb = b.rel.split('/');
      for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
        if (pa[i] === pb[i]) continue;
        const aDir = i < pa.length - 1 || a.dir;
        const bDir = i < pb.length - 1 || b.dir;
        if (aDir !== bDir) return aDir ? -1 : 1;
        return pa[i].localeCompare(pb[i]);
      }
      return pa.length - pb.length;
    });
    for (const it of items) {
      const level = it.rel.split('/').length;
      if (level > depth) continue;
      const name = it.rel.split('/').pop();
      const pad = '  '.repeat(level);
      if (it.dir) lines.push(level === depth ? `${pad}${name}/ (${countUnder(it.rel)} files)` : `${pad}${name}/`);
      else lines.push(`${pad}${name}  ${kb(it.size)}`);
    }
    const text = lines.join('\n');
    if (text.length <= maxChars || depth === 1) return text.length > maxChars ? `${text.slice(0, maxChars)}\n  … (more: use @@list ${folder.name}/<folder>)` : text;
  }
  return '';
}

export function treeHeader(folder) {
  const s = scanFolder(folder.path);
  const k = s.skipped;
  const parts = [k.dependencies && 'dependency/build folders', k.secret && `${k.secret} secret file(s)`, k.ignored && `${k.ignored} ignored by .gitignore`, k.binary && `${k.binary} binary file(s)`, k.links && `${k.links} link(s)`].filter(Boolean);
  return `${folder.name}/  (${s.files.length} files${s.truncated ? ', scan stopped early: very large folder' : ''}${parts.length ? `; not shown: ${parts.join(', ')}` : ''})`;
}

/** Split "name/rel/path:120-200" (or "#L120-L200") into a folder, a relative path and a line range. */
export function resolveTarget(room, raw) {
  const folders = room.folders || [];
  let p = String(raw || '').trim().replace(/^["'`]|["'`]$/g, '').replace(/\\/g, '/').replace(/^\.?\/+/, '');
  let from = 0;
  let to = 0;
  const range = p.match(/(?::|#L)(\d+)(?:\s*-\s*L?(\d+))?$/);
  if (range) {
    p = p.slice(0, range.index);
    from = Number(range[1]);
    to = Number(range[2] || range[1]);
  }
  const first = p.split('/')[0].toLowerCase();
  let folder = folders.find((f) => f.name.toLowerCase() === first);
  let rel = folder ? p.split('/').slice(1).join('/') : p;
  if (!folder && folders.length === 1) folder = folders[0];
  if (!folder) return { error: `no shared folder matches "${String(raw).slice(0, 80)}" (folders: ${folders.map((f) => f.name).join(', ') || 'none'})` };
  if (rel.split('/').some((part) => part === '..')) return { error: 'paths may not use ".."' };
  if (/^[A-Za-z]:/.test(rel) || rel.startsWith('/') || /\/\/|^\/|\0/.test(rel)) return { error: 'use a path inside the shared folder, like name/src/file.js' };
  rel = rel.replace(/\/+$/, '');
  return { folder, rel, from, to };
}

const inside = (root, p) => {
  const r = path.relative(root, p);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
};

function safeAbs(folder, rel) {
  const full = path.resolve(folder.path, rel);
  if (!inside(folder.path, full)) return null;
  try {
    const real = fs.realpathSync(full);
    return inside(folder.path, real) ? real : null;
  } catch {
    return null;
  }
}

// High-confidence credential shapes. Matches are replaced; the rest of the file stays readable.
// Generic "key = value" matches only count when the value looks random (letters and digits, 16+ characters),
// so ordinary code such as `token = generateAccessToken(user)` is left alone.
const looksRandom = (v) => v.length >= 16 && /\d/.test(v) && /[A-Za-z]/.test(v);
const SECRET_TEXT = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, (m) => '[redacted private key]' + '\n'.repeat((m.match(/\n/g) || []).length)], // keeps line numbers
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, () => '[redacted]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, (m, b) => `${b}[redacted]`],
  [/\b(?:ghp|gho|ghu|ghs|github_pat|glpat|xox[abprs])[-_][A-Za-z0-9_-]{16,}\b/g, () => '[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, () => '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, () => '[redacted]'],
  [/\b(?:sk|rk)[-_][A-Za-z0-9_-]{16,}\b/g, (m) => (looksRandom(m) ? '[redacted]' : m)],
  [/((?:api[_-]?key|apikey|secret|token|passw(?:or)?d|pwd|private[_-]?key|client[_-]?secret|access[_-]?key)["']?\s*[:=]\s*["']?)([A-Za-z0-9+/=_\-.~]{16,})/gi, (m, k, v) => (looksRandom(v) ? `${k}[redacted]` : m)],
  // A quoted literal assigned to a sensitive name ("password": "correct-horse-battery-staple"); UI text with spaces stays.
  [/((?:api[_-]?key|apikey|secret|token|passw(?:or)?d|pwd|passphrase|private[_-]?key|client[_-]?secret|access[_-]?key|auth)\w*["']?\s*[:=]\s*)(["'])([^\s"']{8,})\2/gi, (m, k, q) => `${k}${q}[redacted]${q}`],
  // .env-style lines (also in .env.example, where live values get copied by mistake).
  [/^(\s*(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Z0-9_]*\s*=\s*)(["']?)([^\s"'#]{6,})\2/gm, (m, k, q) => `${k}${q}[redacted]${q}`],
  [/(\/\/[^\s:@/]+:)([^\s@/]{6,})(@)/g, (m, a, v, b) => `${a}[redacted]${b}`],
];
export function redactSecrets(text) {
  let out = text;
  for (const [re, fn] of SECRET_TEXT) out = out.replace(re, fn);
  return out;
}

/** Raw text of a shared file (only files the scan lists). */
export function readFolderRaw(folder, rel) {
  const s = scanFolder(folder.path);
  const entry = s.files.find((f) => f.rel === rel);
  if (!entry) return { error: `${folder.name}/${rel} is not a readable file in the shared folder (it may be missing, skipped as a secret, binary or ignored file, or in a skipped folder)` };
  if (entry.size > MAX_FILE_BYTES) return { error: `${folder.name}/${rel} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB` };
  if (!rootIntact(folder.path)) return { error: `the shared folder ${folder.name} was moved or replaced; share it again` };
  const full = safeAbs(folder, rel);
  if (!full) return { error: `${folder.name}/${rel} is outside the shared folder` };
  let fd;
  try {
    fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const st = fs.fstatSync(fd);
    // Must still be the very file the scan listed: same device and inode, one link, not too large.
    if (!st.isFile() || st.nlink > 1 || st.dev !== entry.dev || st.ino !== entry.ino) return { error: `${folder.name}/${rel} changed since the folder was scanned; try again` };
    if (st.size > MAX_FILE_BYTES) return { error: `${folder.name}/${rel} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB` };
    const buf = fs.readFileSync(fd);
    if (buf.includes(0)) return { error: `${folder.name}/${rel} is a binary file` };
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf); // UTF-16 or other encodings could hide text from the checks
    } catch {
      return { error: `${folder.name}/${rel} is not UTF-8 text` };
    }
    return { text: redactSecrets(text), size: st.size };
  } catch (e) {
    return { error: e.code === 'ELOOP' ? `${folder.name}/${rel} is a link` : `${folder.name}/${rel} could not be read` };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** A file (or a line range) with line numbers, cut at a line boundary to fit maxChars. */
export function readFolderFile(folder, rel, { from = 0, to = 0, maxChars = 12000 } = {}) {
  const r = readFolderRaw(folder, rel);
  if (r.error) return r;
  const lines = r.text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  let a = from ? Math.min(Math.max(1, from), Math.max(total, 1)) : 1;
  let b = to ? Math.min(Math.max(a, to), total) : total;
  const width = String(b).length;
  const out = [];
  let used = 0;
  let last = a - 1;
  for (let i = a; i <= b; i++) {
    const line = `${String(i).padStart(width)} | ${lines[i - 1]}`;
    if (used + line.length + 1 > maxChars && out.length) break;
    out.push(line);
    used += line.length + 1;
    last = i;
  }
  const shown = total ? `lines ${a}-${last} of ${total}` : 'empty file';
  const more = last < b ? `\n[cut to save space: ask for the rest with @@read ${folder.name}/${rel}:${last + 1}-${Math.min(b, last + 400)}]` : '';
  return { title: `${folder.name}/${rel}`, header: `${shown}, read-only`, body: `${out.join('\n')}${more}` };
}

/** Case-insensitive text search in the shared folders (optionally only under "name/dir"). */
export function searchFolders(room, rawArg, { maxHits = 40, perFile = 5 } = {}) {
  let arg = String(rawArg || '').trim();
  let scope = '';
  const m = arg.match(/^(.*?)\s+in\s+(\S+)$/i);
  if (m) {
    arg = m[1].trim();
    scope = m[2];
  }
  const query = arg.replace(/^["'`](.*)["'`]$/, '$1');
  if (query.length < 2) return { error: 'search for at least 2 characters' };
  let targets = (room.folders || []).map((folder) => ({ folder, dir: '' }));
  if (scope) {
    const t = resolveTarget(room, scope);
    if (t.error) return { error: t.error };
    targets = [{ folder: t.folder, dir: t.rel }];
  }
  const needle = query.toLowerCase();
  const hits = [];
  let files = 0;
  for (const { folder, dir } of targets) {
    for (const f of scanFolder(folder.path).files) {
      if (hits.length >= maxHits) break;
      if (dir && !f.rel.startsWith(dir + '/') && f.rel !== dir) continue;
      if (f.size > MAX_FILE_BYTES) continue;
      const r = readFolderRaw(folder, f.rel);
      if (r.error) continue;
      if (!r.text.toLowerCase().includes(needle)) continue;
      files++;
      let n = 0;
      r.text.split('\n').forEach((line, i) => {
        if (n >= perFile || hits.length >= maxHits || !line.toLowerCase().includes(needle)) return;
        n++;
        hits.push(`${folder.name}/${f.rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
  }
  const title = `search "${query}"${scope ? ` in ${scope}` : ''}`;
  if (!hits.length) return { title, body: 'No matches.' };
  return { title, body: `${hits.length} match(es) in ${files} file(s)${hits.length >= maxHits ? ' (stopped at the limit; narrow the search with "in name/dir")' : ''}:\n${hits.join('\n')}` };
}

/** The direct children of a shared directory. */
export function listFolder(room, rawArg) {
  const t = resolveTarget(room, rawArg || (room.folders?.[0]?.name ?? ''));
  if (t.error) return t;
  const s = scanFolder(t.folder.path);
  const dir = t.rel;
  if (dir && !s.dirs.includes(dir)) return { error: `${t.folder.name}/${dir} is not a shared directory` };
  const prefix = dir ? dir + '/' : '';
  const children = new Map();
  for (const d of s.dirs) if (d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) children.set(d, `${d.slice(prefix.length)}/ (${s.files.filter((f) => f.rel.startsWith(d + '/')).length} files)`);
  for (const f of s.files) if (f.rel.startsWith(prefix) && !f.rel.slice(prefix.length).includes('/')) children.set(f.rel, `${f.rel.slice(prefix.length)}  ${kb(f.size)}`);
  return { title: `${t.folder.name}/${dir}`, body: [...children.values()].join('\n') || '(empty)' };
}
