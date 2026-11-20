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

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

/**
 * Gateways (Cloudflare) answer some failures with a whole HTML page. Keep its title, not the markup.
 * Other text is returned unchanged.
 */
export function readableBody(raw) {
  const s = String(raw || '');
  if (!/^\s*<(!doctype\s+html|html)\b/i.test(s)) return s;
  const title = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const text = (title || s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, k) => ENTITIES[k])
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return `${text || 'unknown error'} (an error page from GMI's gateway, not an answer from the model)`;
}

/** Answers worth trying again: rate limits, server errors and gateway errors (Cloudflare 520–530). */
export const isTransient = (status) => status === 429 || (status >= 500 && status <= 504) || (status >= 520 && status <= 530);

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason || new Error('aborted'));
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(t);
    reject(signal.reason || new Error('aborted'));
  }, { once: true });
});

async function errorFrom(res, tries = 1) {
  const raw = await res.text().catch(() => '');
  let detail = readableBody(raw);
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
  const after = tries > 1 ? ` Tried ${tries} times; this is usually temporary, so send the message again in a minute.` : '';
  return new GmiError(`GMI ${res.status}: ${String(detail).slice(0, 1500) || res.statusText}${after}`, res.status);
}

/** A timeout is reported as such (not as "Unexpected error"); a stop by the Host stays an abort. */
function timeoutError(e, signal, idle) {
  if (signal?.aborted) return e;
  if (e && (e.name === 'TimeoutError' || /timeout/i.test(e.message || ''))) {
    if (idle && !idle.fired) return new GmiError(`The reply took longer than ${Math.round(config.requestMaxMs / 60000)} min and was stopped. Ask for a shorter answer, or raise PANELSHOW_MAX_REPLY_MS.`);
    return new GmiError(`GMI sent nothing for ${Math.round(config.requestTimeoutMs / 1000)} s. Thinking models can think silently for a long time on long inputs; raise PANELSHOW_TIMEOUT_MS or ask for a shorter answer.`);
  }
  return e;
}

function withTimeout(signal) {
  const t = AbortSignal.timeout(config.requestTimeoutMs);
  return signal ? AbortSignal.any([signal, t]) : t;
}

/**
 * A timeout that counts only silence: every chunk from GMI (text, thinking or keep-alive) starts it again,
 * so a long answer that keeps streaming is not cut off. A hard limit still applies.
 */
function idleTimeout(signal) {
  const ctl = new AbortController();
  const state = { fired: false, timer: null };
  state.arm = () => {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.fired = true;
      ctl.abort(new DOMException('No data from GMI', 'TimeoutError'));
    }, config.requestTimeoutMs);
    state.timer.unref?.();
  };
  state.stop = () => clearTimeout(state.timer);
  state.arm();
  state.signal = AbortSignal.any([ctl.signal, AbortSignal.timeout(config.requestMaxMs), ...(signal ? [signal] : [])]);
  return state;
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
  const idle = idleTimeout(signal);
  const sig = idle.signal;
  // Nothing has been streamed yet, so a busy or failing gateway can be tried again without repeating text.
  const delays = config.chatRetryDelaysMs || [];
  let res;
  let tries = 0;
  for (;;) {
    tries++;
    let netError = null;
    try {
      res = await fetch(`${config.baseUrl}/chat/completions`, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: sig });
    } catch (e) {
      if (sig.aborted) throw timeoutError(e, signal, idle);
      netError = e;
    }
    if (!netError && !isTransient(res.status)) break;
    if (tries > delays.length) {
      if (netError) throw new GmiError(`Could not reach GMI (${netError.cause?.code || netError.message}).${tries > 1 ? ` Tried ${tries} times.` : ''}`);
      break;
    }
    if (res) await res.body?.cancel().catch(() => {});
    await sleep(delays[tries - 1], sig).catch((e) => {
      throw timeoutError(e, signal, idle);
    });
    idle.arm(); // waiting between tries is not silence from GMI
  }
  if (res.status === 400 && body.stream_options) {
    const err = await errorFrom(res);
    if (!/stream_options/i.test(err.message)) throw err;
    // This endpoint does not take stream_options: drop it for the rest of the session (token counts may be missing).
    streamUsageSupported = false;
    delete body.stream_options;
    res = await fetch(`${config.baseUrl}/chat/completions`, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: sig });
  }
  if (!res.ok) throw await errorFrom(res, tries);

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
      idle.arm();
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
    throw timeoutError(e, signal, idle);
  } finally {
    idle.stop();
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
