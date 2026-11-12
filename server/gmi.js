// GMI Cloud client: OpenAI-compatible chat completions with streaming.
// Rules: the key comes only from the environment and is never logged or returned;
// no sampling defaults are sent (some models reject frequency_penalty);
// on an error the provider's own detail text is surfaced.
import { config } from './config.js';

export class GmiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'GmiError';
    this.status = status;
  }
}

function headers() {
  if (!config.apiKey) throw new GmiError('GMI_API_KEY is not set. Copy .env.example to .env, add your key, and restart.');
  return { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' };
}

async function errorFrom(res) {
  const raw = await res.text().catch(() => '');
  let detail = raw;
  try {
    const j = JSON.parse(raw);
    const e = j.error && typeof j.error === 'object' ? j.error : j;
    const parts = [e.message, typeof e.details === 'string' ? e.details : e.details ? JSON.stringify(e.details) : '']
      .concat(typeof j.error === 'string' ? [j.error] : [])
      .filter(Boolean);
    if (parts.length) detail = [...new Set(parts)].join(' | ');
  } catch {
    /* not JSON: keep the raw body */
  }
  return new GmiError(`GMI ${res.status}: ${String(detail).slice(0, 1500) || res.statusText}`, res.status);
}

/** A timeout is reported as such (not as "Unexpected error"); a stop by the Host stays an abort. */
function timeoutError(e, signal) {
  if (signal?.aborted) return e;
  if (e && (e.name === 'TimeoutError' || /timeout/i.test(e.message || ''))) return new GmiError(`GMI did not finish within ${Math.round(config.requestTimeoutMs / 1000)} s. Thinking models can be slow on long inputs; raise PANELSHOW_TIMEOUT_MS or ask for a shorter answer.`);
  return e;
}

function withTimeout(signal) {
  const t = AbortSignal.timeout(config.requestTimeoutMs);
  return signal ? AbortSignal.any([signal, t]) : t;
}

let modelCache = null;

export async function listModels({ refresh = false } = {}) {
  if (modelCache && !refresh && Date.now() - modelCache.at < 10 * 60 * 1000) return modelCache.models;
  const res = await fetch(`${config.baseUrl}/models`, { headers: headers(), signal: withTimeout() });
  if (!res.ok) throw await errorFrom(res);
  const body = await res.json();
  const models = (body.data || body.models || [])
    .map((m) => ({ id: m.id || m.name, owner: m.owned_by || '' }))
    .filter((m) => m.id)
    .sort((a, b) => a.id.localeCompare(b.id));
  modelCache = { at: Date.now(), models };
  return models;
}

let streamUsageSupported = true;

/**
 * One chat completion, streamed.
 * @returns {Promise<{text:string, usage:object|null, finishReason:string|null}>}
 */
export async function chat({ model, messages, signal, onDelta, onThinking, maxTokens }) {
  const body = { model, messages, stream: true, max_tokens: maxTokens || config.maxTokens };
  if (streamUsageSupported) body.stream_options = { include_usage: true };
  const sig = withTimeout(signal);
  let res = await fetch(`${config.baseUrl}/chat/completions`, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: sig }).catch((e) => {
    throw timeoutError(e, signal);
  });
  if (res.status === 400 && body.stream_options) {
    const err = await errorFrom(res);
    if (!/stream_options/i.test(err.message)) throw err;
    // This endpoint does not take stream_options: drop it for the rest of the session (token counts may be missing).
    streamUsageSupported = false;
    delete body.stream_options;
    res = await fetch(`${config.baseUrl}/chat/completions`, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: sig });
  }
  if (!res.ok) throw await errorFrom(res);

  let text = '';
  let usage = null;
  let finishReason = null;
  const take = (obj) => {
    if (obj.error) throw new GmiError(`GMI stream error: ${typeof obj.error === 'string' ? obj.error : obj.error.message || JSON.stringify(obj.error)}`.slice(0, 1500));
    if (obj.usage) usage = obj.usage;
    const choice = obj.choices && obj.choices[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const d = choice.delta || choice.message || {};
    if ((d.reasoning_content || d.reasoning) && onThinking) onThinking();
    if (typeof d.content === 'string' && d.content) {
      text += d.content;
      if (onDelta) onDelta(d.content);
    }
  };

  // Decide by the body, not the header: some models come back as SSE labelled application/json.
  const labelledSse = (res.headers.get('content-type') || '').includes('text/event-stream');
  const decoder = new TextDecoder();
  let sse = labelledSse ? true : null; // null until the first non-blank bytes arrive
  let buf = '';
  const drainLines = () => {
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let obj;
      try {
        obj = JSON.parse(data);
      } catch {
        continue; // a partial or non-JSON keep-alive line
      }
      take(obj);
    }
  };
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      if (sse === null) {
        const head = buf.trimStart();
        if (!head) continue;
        sse = !head.startsWith('{') && !head.startsWith('[');
      }
      if (sse) drainLines();
    }
    buf += decoder.decode();
  } catch (e) {
    throw timeoutError(e, signal);
  }
  if (sse) {
    buf += '\n';
    drainLines();
  } else if (buf.trim()) {
    let obj;
    try {
      obj = JSON.parse(buf);
    } catch {
      throw new GmiError(`GMI sent a reply PanelShow could not read: ${buf.slice(0, 200)}`);
    }
    take(obj); // the server answered without streaming
  }
  return { text, usage, finishReason };
}

// 16x16 red PNG used to find out whether a model accepts images.
const PROBE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGO4IydHEmIY1TCqYfhqAACaMxgQdGu1YAAAAABJRU5ErkJggg==';

/**
 * Two tiny requests: does the model answer, and can it really see an image?
 * A model that accepts the image but cannot say it is red is marked text-only (some models silently drop images).
 */
export async function probeModel(model, { signal } = {}) {
  const out = { ok: false, vision: false, error: '', visionError: '', latencyMs: 0 };
  try {
    const t0 = Date.now();
    await chat({ model, signal, messages: [{ role: 'user', content: 'Reply with the single word OK.' }], maxTokens: 1024 });
    out.latencyMs = Date.now() - t0;
    out.ok = true;
  } catch (e) {
    out.error = e.message;
    return out;
  }
  try {
    const { text } = await chat({
      model,
      signal,
      maxTokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What colour is this square? One word.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${PROBE_PNG}` } },
          ],
        },
      ],
    });
    if (/red|红/i.test(text)) out.vision = true;
    else out.visionError = `Accepted the image but did not see it (answered: ${String(text).trim().slice(0, 80) || 'nothing'}).`;
  } catch (e) {
    out.visionError = e.message;
  }
  return out;
}
