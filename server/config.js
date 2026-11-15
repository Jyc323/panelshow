import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env reader: KEY=value lines; values already in the environment win.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnvFile(path.join(ROOT, '.env'));

const env = process.env;
// Settings are PANELSHOW_*; the older MRT_* names (from the project's first name) still work.
const opt = (name) => env[`PANELSHOW_${name}`] ?? env[`MRT_${name}`];

// A plain mutable object so tests can point it at a fake server and a temp folder.
export const config = {
  apiKey: env.GMI_API_KEY || '',
  baseUrl: (env.GMI_BASE_URL || 'https://api.gmi-serving.com/v1').replace(/\/+$/, ''),
  // GMI's request queue: image (and video) models live here, not in /v1/models.
  queueUrl: (env.GMI_QUEUE_URL || 'https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey').replace(/\/+$/, ''),
  port: Number(env.PORT || 8790),
  host: env.HOST || '127.0.0.1',
  dataDir: path.resolve(opt('DATA_DIR') || path.join(ROOT, 'data')),
  directorModel: opt('DIRECTOR_MODEL') || '', // the model that plans Smart invite; empty = pick a well-known one
  allowPrivateUrls: opt('ALLOW_PRIVATE_URLS') === '1',
  maxTokens: Number(opt('MAX_TOKENS') || 8000),
  requestTimeoutMs: Number(opt('TIMEOUT_MS') || 300000),
  autoProbe: opt('AUTO_PROBE') !== '0', // two tiny requests when a model is first invited: does it answer, can it see images

  // Local models through Ollama. "off" switches them off; otherwise the server is looked for at this address.
  ollamaUrl: ['off', 'none', '0'].includes(String(opt('OLLAMA_URL') || '').toLowerCase()) ? '' : (opt('OLLAMA_URL') || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
  ollamaNumCtx: Number(opt('OLLAMA_NUM_CTX') || 16384), // context window per local request (prompt + reply)
  ollamaConcurrency: Number(opt('OLLAMA_CONCURRENCY') || 1), // local requests at the same time

  // Image generation (GMI request queue). Members ask for images with @@draw / @@edit lines.
  defaultImageModel: opt('IMAGE_MODEL') || '', // used when a member names no model; empty = seedream-5.0-lite if available
  imagesPerRun: Number(opt('IMAGES_PER_RUN') || 8), // safety cap against loops; how many to make is decided in the chat
  imagesPerTurn: Number(opt('IMAGES_PER_TURN') || 4),
  imageTimeoutMs: Number(opt('IMAGE_TIMEOUT_MS') || 300000),
  imagePollMs: Number(opt('IMAGE_POLL_MS') || 3000),

  // Context budgets (characters, not tokens).
  transcriptChars: 60000,
  resourceChars: 12000, // per file or page shown to a member
  resourcesTotalChars: 48000, // all attached material in one request
  imagesPerRequest: 6,

  // Limits on what members and the host can bring in.
  fileMaxBytes: 200 * 1024, // a file written by a member
  uploadMaxBytes: 20 * 1024 * 1024,
  pageMaxBytes: 5 * 1024 * 1024,
  docMaxBytes: 20 * 1024 * 1024,
  imageMaxBytes: 10 * 1024 * 1024,
  urlsPerMessage: 4,
  imagesPerPage: 3,
  toolRounds: 3, // read/open steps a member may chain in one turn
  folderToolRounds: 5, // when a project folder is shared: reviews need more context
  folderToolRequestsPerRound: 4,
  toolRequestsPerRound: 3,
};
