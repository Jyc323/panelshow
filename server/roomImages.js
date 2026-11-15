// Pictures in a room: uploaded by the Host or made by an image model. Each gets an id (img-1, img-2, ...)
// that members use to refer to it (@@edit img-2 ...). Files live in data/rooms/<id>/images/.
import fs from 'node:fs';
import path from 'node:path';
import { roomDir } from './store.js';
import { normalizeImage } from './media.js';

export const IMAGE_ID = /^img-\d{1,5}$/;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
export const IMAGE_MIMES = Object.keys(EXT);
const dir = (room) => path.join(roomDir(room.id), 'images');

/** The real image type from the first bytes (names and headers can lie). */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return '';
}

/** Store a picture and give it the next id. meta: { source: 'upload'|'generated', by, model?, prompt?, name? } */
export function addImage(room, buffer, meta = {}) {
  const mime = sniffImage(buffer);
  if (!mime) throw new Error('only PNG, JPEG, WebP and GIF pictures are accepted');
  room.images = room.images || [];
  room.imageSeq = (room.imageSeq || 0) + 1;
  const id = `img-${room.imageSeq}`;
  const file = `${id}.${EXT[mime]}`;
  fs.mkdirSync(dir(room), { recursive: true });
  fs.writeFileSync(path.join(dir(room), file), buffer);
  const entry = { id, file, mime, size: buffer.length, at: Date.now(), ...meta };
  room.images.push(entry);
  return entry;
}

export const findImage = (room, id) => (room.images || []).find((x) => x.id === id) || null;

export function imageBytes(room, id) {
  const entry = findImage(room, id);
  if (!entry) return null;
  try {
    return { entry, buffer: fs.readFileSync(path.join(dir(room), entry.file)), mime: entry.mime };
  } catch {
    return null;
  }
}

/**
 * A data URL small enough to send to a chat model: a JPEG no wider than 1280 px (made once, with ffmpeg).
 * Without ffmpeg, the original is used when it is under 4 MB.
 */
export async function imageForModel(room, id) {
  const got = imageBytes(room, id);
  if (!got) return null;
  const small = path.join(dir(room), `${id}.view.jpg`);
  if (!fs.existsSync(small)) await normalizeImage(path.join(dir(room), got.entry.file), small).catch(() => false);
  if (fs.existsSync(small)) return `data:image/jpeg;base64,${fs.readFileSync(small).toString('base64')}`;
  if (got.buffer.length > 4 * 1024 * 1024) return null;
  return `data:${got.mime};base64,${got.buffer.toString('base64')}`;
}

/** One line per picture, for the system prompt. */
export function imageLine(img) {
  const who = img.source === 'upload' ? `uploaded by ${img.by || 'the Host'}${img.name ? ` (${img.name})` : ''}` : `made by ${img.by} with ${img.model}${img.prompt ? ` from: "${String(img.prompt).slice(0, 160)}${String(img.prompt).length > 160 ? '…' : ''}"` : ''}`;
  return `- ${img.id}: ${who}`;
}
