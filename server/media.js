// ffmpeg helpers. ffmpeg is optional: without it images are passed through as they are
// and videos are described by their address only.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function run(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, out, err: String(e) });
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

let ffmpegState = null;
export async function hasFfmpeg() {
  if (ffmpegState === null) {
    const [a, b] = await Promise.all([run('ffmpeg', ['-version'], 5000), run('ffprobe', ['-version'], 5000)]);
    ffmpegState = a.code === 0 && b.code === 0;
  }
  return ffmpegState;
}

/** Re-encode any image as a JPEG no wider than 1280 px. Returns false when it could not. */
export async function normalizeImage(inFile, outFile) {
  if (!(await hasFfmpeg())) return false;
  const r = await run('ffmpeg', ['-y', '-v', 'error', '-i', inFile, '-vf', "scale='min(1280,iw)':-2", '-frames:v', '1', '-q:v', '4', outFile]);
  return r.code === 0 && fs.existsSync(outFile);
}

const NET = ['-protocol_whitelist', 'http,https,tcp,tls,crypto'];

/**
 * Sample 12 frames across a video at an http(s) address and tile them into one contact sheet.
 * The caller must already have checked that the address is allowed.
 */
export async function videoSheet(url, dir) {
  if (!(await hasFfmpeg())) return { error: 'ffmpeg is not installed, so video frames cannot be sampled' };
  const probe = await run('ffprobe', ['-v', 'error', ...NET, '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', url], 40000);
  let info;
  try {
    info = JSON.parse(probe.out);
  } catch {
    return { error: 'could not read the video' };
  }
  const duration = Number(info.format && info.format.duration) || 0;
  const stream = (info.streams && info.streams[0]) || {};
  if (!duration) return { error: 'could not read the video duration' };

  fs.mkdirSync(dir, { recursive: true });
  const n = 12;
  const times = Array.from({ length: n }, (_, i) => (duration * (i + 0.5)) / n);
  const grab = async (t, i) => {
    const file = path.join(dir, `raw_${i}.jpg`);
    const r = await run('ffmpeg', ['-y', '-v', 'error', ...NET, '-ss', t.toFixed(2), '-i', url, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', file], 30000);
    return r.code === 0 && fs.existsSync(file) ? { t, file } : null;
  };
  const got = [];
  for (let i = 0; i < n; i += 3) got.push(...(await Promise.all(times.slice(i, i + 3).map((t, j) => grab(t, i + j)))));
  const frames = got.filter(Boolean);
  if (!frames.length) return { error: 'no frames could be read from the video', duration };
  frames.forEach((f, i) => fs.renameSync(f.file, path.join(dir, `f_${String(i).padStart(2, '0')}.jpg`)));
  const rows = Math.ceil(frames.length / 4);
  const sheet = path.join(dir, 'sheet.jpg');
  const tile = await run('ffmpeg', ['-y', '-v', 'error', '-i', path.join(dir, 'f_%02d.jpg'), '-vf', `tile=4x${rows}`, '-frames:v', '1', '-q:v', '4', sheet]);
  if (tile.code !== 0 || !fs.existsSync(sheet)) return { error: 'could not build the contact sheet', duration };
  return { duration, width: stream.width || 0, height: stream.height || 0, times: frames.map((f) => Math.round(f.t * 10) / 10), sheet: 'sheet.jpg' };
}
