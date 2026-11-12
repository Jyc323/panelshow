// Try the app without a GMI key: starts a stand-in model server with five scripted "models"
// and points the app at it. Nothing is sent to GMI and nothing is spent.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeGmi } from '../test/fake-gmi.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fake = await createFakeGmi({ delayMs: 60 });
process.env.GMI_BASE_URL = fake.url;
process.env.GMI_API_KEY = 'demo-key-not-real';
process.env.PANELSHOW_DATA_DIR = process.env.PANELSHOW_DATA_DIR || process.env.MRT_DATA_DIR || path.join(root, 'data', 'demo');

const { config } = await import('../server/config.js');
const { createServer } = await import('../server/index.js');
createServer().listen(config.port, config.host, () => {
  console.log(`Demo mode (scripted stand-in models, no GMI calls): http://127.0.0.1:${config.port}`);
});
