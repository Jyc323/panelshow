// Rooms live in memory and are written to data/rooms/<id>/room.json after every change.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const rooms = new Map();
let loaded = false;

export const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);
export const roomDir = (id) => path.join(config.dataDir, 'rooms', id);

function load() {
  if (loaded) return;
  loaded = true;
  const dir = path.join(config.dataDir, 'rooms');
  if (!fs.existsSync(dir)) return;
  for (const id of fs.readdirSync(dir)) {
    const file = path.join(dir, id, 'room.json');
    try {
      const room = JSON.parse(fs.readFileSync(file, 'utf8'));
      // A reply that was streaming when the server stopped can never finish.
      for (const m of room.messages) if (m.status === 'streaming') m.status = 'stopped';
      rooms.set(room.id, room);
    } catch {
      /* unreadable room folder: skip it */
    }
  }
}

/** Forget what is in memory (tests switch data folders). */
export function resetStore() {
  rooms.clear();
  loaded = false;
}

export function listRooms() {
  load();
  return [...rooms.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getRoom(id) {
  load();
  return rooms.get(id) || null;
}

export function createRoom(title) {
  load();
  const now = Date.now();
  const room = {
    id: newId(),
    title: String(title || 'New room').slice(0, 80),
    createdAt: now,
    updatedAt: now,
    settings: { mode: 'roundtable', rounds: 1, maxHops: 6 },
    members: [],
    messages: [],
    files: [],
    folders: [], // read-only project folders on this computer (see workspace.js)
  };
  rooms.set(room.id, room);
  saveRoom(room);
  return room;
}

export function saveRoom(room) {
  room.updatedAt = Date.now();
  const dir = roomDir(room.id);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, 'room.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(room, null, 1));
  fs.renameSync(tmp, path.join(dir, 'room.json'));
}

export function deleteRoom(id) {
  load();
  rooms.delete(id);
  fs.rmSync(roomDir(id), { recursive: true, force: true });
}

// What we learned about each model id (can it see images, did it answer at all).
const capFile = () => path.join(config.dataDir, 'capabilities.json');
let caps = null;

export function getCapabilities() {
  if (!caps) {
    try {
      caps = JSON.parse(fs.readFileSync(capFile(), 'utf8'));
    } catch {
      caps = {};
    }
  }
  return caps;
}

export function setCapability(model, patch) {
  const all = getCapabilities();
  all[model] = { ...all[model], ...patch, at: Date.now() };
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(capFile(), JSON.stringify(all, null, 1));
  return all[model];
}

export function resetCapabilities() {
  caps = null;
}
