// Ollama client for local models. Uses Ollama's own API (/api/chat), not its OpenAI-compatible /v1:
// only the native API takes num_ctx per request, and Ollama's default context is small enough to cut
// PanelShow's prompts without any error. Local requests run one at a time by default, because Ollama
// queues or swaps models when several different ones are asked at once.
import { config } from './config.js';
import { GmiError } from './gmi.js';

export const LOCAL_PREFIX = 'ollama:';
export const isLocal = (id) => String(id || '').startsWith(LOCAL_PREFIX);
export const localName = (id) => String(id || '').slice(LOCAL_PREFIX.length);

const base = () => config.ollamaUrl.replace(/\/+$/, '');
export const ollamaEnabled = () => Boolean(config.ollamaUrl);

function withTimeout(signal, ms = config.requestTimeoutMs) {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

async function errorFrom(res) {
  const raw = await res.text().catch(() => '');
  let detail = raw;
  try {
    const j = JSON.parse(raw);
    if (j && j.error) detail = typeof j.error === 'string' ? j.error : JSON.stringify(j.error);
  } catch {
    /* keep raw */
  }
  return new GmiError(`Ollama ${res.status}: ${String(detail).slice(0, 1000) || res.statusText}`, res.status);
}

function unreachable(e, signal) {
  if (signal?.aborted) return e;
  if (e && (e.name === 'TimeoutError' || /timeout/i.test(e.message || ''))) {
    return new GmiError(`The local model did not finish within ${Math.round(config.requestTimeoutMs / 1000)} s. Loading a model the first time can be slow; raise PANELSHOW_TIMEOUT_MS or use a smaller model.`);
  }
  return new GmiError(`Could not reach Ollama at ${base()} (${e && e.cause ? e.cause.code || e.cause.message : e.message}). Is \`ollama serve\` running?`);
}

// One request at a time (or PANELSHOW_OLLAMA_CONCURRENCY). Waiting requests keep their order.
let active = 0;
const waiting = [];
async function slot(signal) {
  if (active < Math.max(1, config.ollamaConcurrency)) {
    active++;
    return;
  }
  await new Promise((resolve, reject) => {
    const entry = { resolve, reject };
    waiting.push(entry);
    signal?.addEventListener('abort', () => {
      const i = waiting.indexOf(entry);
      if (i >= 0) waiting.splice(i, 1);
      reject(signal.reason || new Error('aborted'));
    }, { once: true });
  });
  active++;
}
function release() {
  active--;
  const next = waiting.shift();
  if (next) next.resolve();
}

let listCache = null;

/** Local models, as `ollama:<name>`. Empty when Ollama is off or not running (that is not an error). */
export async function listLocalModels({ refresh = false } = {}) {
  if (!ollamaEnabled()) return { models: [], reachable: false };
  if (listCache && !refresh && listCache.url === config.ollamaUrl && Date.now() - listCache.at < 60 * 1000) return listCache.value;
  let value;
  try {
    const res = await fetch(`${base()}/api/tags`, { signal: withTimeout(null, 3000) });
    if (!res.ok) throw await errorFrom(res);
    const body = await res.json();
    const models = (body.models || [])
      .map((m) => m.name || m.model)
      .filter((n) => n && !/embed/i.test(n))
      .sort((a, b) => a.localeCompare(b))
      .map((n) => ({ id: LOCAL_PREFIX + n, owner: 'local', provider: 'ollama' }));
    value = { models, reachable: true };
  } catch (e) {
    value = { models: [], reachable: false, error: e.message };
  }
  listCache = { at: Date.now(), url: config.ollamaUrl, value };
  return value;
}

/** What Ollama says about a model: can it chat, can it see images, how long a context it was trained for. */
export async function showModel(id, { signal } = {}) {
  try {
    const res = await fetch(`${base()}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: localName(id) }), signal: withTimeout(signal, 15000) });
    if (!res.ok) throw await errorFrom(res);
    const j = await res.json();
    const caps = Array.isArray(j.capabilities) ? j.capabilities : [];
    const info = j.model_info || {};
    const ctxKey = Object.keys(info).find((k) => k.endsWith('.context_length'));
    return { capabilities: caps, contextLength: ctxKey ? Number(info[ctxKey]) || 0 : 0 };
  } catch (e) {
    throw e instanceof GmiError ? e : unreachable(e, signal);
  }
}

/** The capability record for a local model (no test request needed: Ollama reports it). */
export async function probeLocal(id, { signal } = {}) {
  const out = { ok: false, vision: false, error: '', visionError: '', latencyMs: 0, local: true };
  try {
    const s = await showModel(id, { signal });
    // Older Ollama versions report no capabilities: assume a chat model without images.
    out.ok = !s.capabilities.length || s.capabilities.includes('completion');
    if (!out.ok) out.error = 'Ollama says this is not a chat model.';
    out.vision = s.capabilities.includes('vision');
    if (!out.vision) out.visionError = 'Ollama does not list vision for this model.';
    if (s.contextLength) out.contextLength = s.contextLength;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

/** OpenAI-style messages (text parts and data: image URLs) to Ollama messages (content + base64 images). */
export function toOllamaMessages(messages) {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return { role: m.role, content: String(m.content ?? '') };
    const text = [];
    const images = [];
    for (const part of m.content) {
      if (part.type === 'text') text.push(part.text);
      else if (part.type === 'image_url') {
        const url = String(part.image_url?.url || '');
        const i = url.indexOf('base64,');
        if (url.startsWith('data:') && i >= 0) images.push(url.slice(i + 7));
      }
    }
    return images.length ? { role: m.role, content: text.join('\n'), images } : { role: m.role, content: text.join('\n') };
  });
}

/** One streamed chat with a local model. Same result shape as the GMI client. */
export async function chatLocal({ model, messages, signal, onDelta, onThinking, maxTokens }) {
  const numCtx = config.ollamaNumCtx;
  const body = {
    model: localName(model),
    messages: toOllamaMessages(messages),
    stream: true,
    // The context window holds the prompt and the reply, so the reply gets at most a quarter of it.
    options: { num_ctx: numCtx, num_predict: Math.min(maxTokens || config.maxTokens, Math.floor(numCtx / 4)) },
  };
  await slot(signal);
  let text = '';
  let usage = null;
  let finishReason = null;
  try {
    const sig = withTimeout(signal);
    let res;
    try {
      res = await fetch(`${base()}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: sig });
    } catch (e) {
      throw unreachable(e, signal);
    }
    if (!res.ok) throw await errorFrom(res);
    const decoder = new TextDecoder();
    let buf = '';
    const handle = (line) => {
      if (!line.trim()) return;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }
      if (obj.error) throw new GmiError(`Ollama: ${typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error)}`.slice(0, 1000));
      const m = obj.message || {};
      if (m.thinking && onThinking) onThinking();
      if (typeof m.content === 'string' && m.content) {
        text += m.content;
        if (onDelta) onDelta(m.content);
      }
      if (obj.done) {
        finishReason = obj.done_reason || 'stop';
        usage = { prompt_tokens: obj.prompt_eval_count || 0, completion_tokens: obj.eval_count || 0 };
      }
    };
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          handle(line);
        }
      }
      handle(buf + decoder.decode());
    } catch (e) {
      throw e instanceof GmiError ? e : unreachable(e, signal);
    }
  } finally {
    release();
  }
  return { text, usage, finishReason };
}
