// The shared file area of a room: text files written by members, and files the host uploads.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { roomDir } from './store.js';
import { redactSecrets } from './workspace.js';

const filesDir = (room) => path.join(roomDir(room.id), 'files');
const extractedDir = (room) => path.join(roomDir(room.id), 'extracted');

/** A safe relative path, or null. No "..", no absolute paths, a short list of characters. */
export function sanitizePath(raw) {
  let p = String(raw || '').trim().replace(/\\/g, '/').replace(/^\.?\/+/, '');
  if (!p || p.length > 120) return null;
  const parts = p.split('/');
  if (parts.length > 4) return null;
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.startsWith('.')) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(part)) return null;
  }
  return parts.join('/');
}

function abs(room, rel) {
  const base = filesDir(room);
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error('path outside the file area');
  return full;
}

export function kindOf(name, buffer) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  // Anything without NUL bytes that decodes as UTF-8 counts as text.
  if (buffer && buffer.subarray(0, 8000).includes(0)) return null;
  return 'text';
}

function record(room, entry) {
  const i = room.files.findIndex((f) => f.path === entry.path);
  if (i >= 0) room.files[i] = { ...room.files[i], ...entry, version: (room.files[i].version || 1) + 1 };
  else room.files.push({ ...entry, version: 1 });
  return room.files.find((f) => f.path === entry.path);
}

/**
 * Save a text file written by a member. A member may overwrite its own files;
 * a path owned by someone else gets the member's name added, so nothing is lost.
 */
export function writeMemberFile(room, member, rawPath, content) {
  let rel = sanitizePath(rawPath);
  if (!rel) return { error: `"${String(rawPath).slice(0, 60)}" is not an allowed file path` };
  const text = String(content);
  if (Buffer.byteLength(text) > config.fileMaxBytes) return { error: `${rel} is larger than ${Math.round(config.fileMaxBytes / 1024)} KB and was not saved` };
  const existing = room.files.find((f) => f.path === rel);
  let renamedFrom = null;
  if (existing && existing.author !== member.id) {
    const ext = path.extname(rel);
    renamedFrom = rel;
    rel = `${rel.slice(0, rel.length - ext.length)}.by-${member.name}${ext}`;
  }
  const full = abs(room, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  const entry = record(room, { path: rel, kind: 'text', author: member.id, authorName: member.name, size: Buffer.byteLength(text), updatedAt: Date.now() });
  return { file: entry, renamedFrom };
}

/** Save an upload from the host. `extract` turns PDF / Word bytes into text. */
export async function saveUpload(room, rawName, buffer, extract) {
  const base = sanitizePath(path.basename(String(rawName || 'file')).replace(/[^A-Za-z0-9._ -]/g, '_'));
  if (!base) throw new Error('that file name is not allowed');
  if (buffer.length > config.uploadMaxBytes) throw new Error('the file is too large');
  const kind = kindOf(base, buffer);
  if (!kind) throw new Error('only text, PDF and Word (.docx) files can be read');
  let rel = `uploads/${base}`;
  for (let i = 2; room.files.some((f) => f.path === rel); i++) {
    const ext = path.extname(base);
    rel = `uploads/${base.slice(0, base.length - ext.length)}-${i}${ext}`;
  }
  const full = abs(room, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buffer);
  let note = '';
  if (kind !== 'text') {
    let text = '';
    try {
      text = await extract(buffer, kind);
    } catch (e) {
      note = `text could not be extracted: ${e.message}`;
    }
    const side = path.join(extractedDir(room), rel + '.txt');
    fs.mkdirSync(path.dirname(side), { recursive: true });
    fs.writeFileSync(side, text);
    if (!text.trim() && !note) note = 'no text found (a scanned document?)';
  }
  return record(room, { path: rel, kind, author: 'host', authorName: 'Host', size: buffer.length, updatedAt: Date.now(), note });
}

/** Text of a room file (for PDF / Word: the extracted text). */
export function readFileText(room, rawPath) {
  const rel = sanitizePath(rawPath);
  const entry = rel && room.files.find((f) => f.path === rel);
  if (!entry) return { error: `no file named "${String(rawPath).slice(0, 80)}" in this room` };
  const file = entry.kind === 'text' ? abs(room, rel) : path.join(extractedDir(room), rel + '.txt');
  try {
    // What members and judges get; the Host's Download button still serves the original file.
    return { entry, text: redactSecrets(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { error: `${rel} could not be read` };
  }
}

export function rawFilePath(room, rawPath) {
  const rel = sanitizePath(rawPath);
  if (!rel || !room.files.some((f) => f.path === rel)) return null;
  return abs(room, rel);
}
