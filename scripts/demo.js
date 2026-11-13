// Try the app without a GMI key: starts stand-in GMI and Ollama servers with scripted "models"
// and points the app at them. Nothing is sent to GMI or to a real Ollama, and nothing is spent.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeGmi } from '../test/fake-gmi.js';
import { createFakeOllama } from '../test/fake-ollama.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fake = await createFakeGmi({ delayMs: 60 });
process.env.GMI_BASE_URL = fake.url;
process.env.GMI_API_KEY = 'demo-key-not-real';
const fakeOllama = await createFakeOllama({ delayMs: 60 });
process.env.PANELSHOW_OLLAMA_URL = fakeOllama.url; // stand-in local models: qwen3:8b and llava:7b
process.env.PANELSHOW_DATA_DIR = process.env.PANELSHOW_DATA_DIR || process.env.MRT_DATA_DIR || path.join(root, 'data', 'demo');

const { config } = await import('../server/config.js');
const { createServer } = await import('../server/index.js');
createServer().listen(config.port, config.host, () => {
  console.log(`Demo mode (scripted stand-in models, no GMI calls): http://127.0.0.1:${config.port}`);
});
