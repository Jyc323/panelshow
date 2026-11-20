// Runs a conversation: who speaks when, what they can see, and what happens to what they write.
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { chat, GmiError } from './llm.js';
import { newId, saveRoom, setCapability } from './store.js';
import { writeMemberFile } from './files.js';
import { openUrl, extractUrls } from './resources.js';
import { buildMessages, parseReply, parseImageRequests, contextText, isPass, mentionsIn, addressees, memberVision, renderResources, continuation, readBudget } from './prompt.js';
import { imageCatalog, defaultImageModel, generateImage } from './images.js';
import { addImage, imageBytes } from './roomImages.js';

const bus = new EventEmitter();
bus.setMaxListeners(0);
const active = new Map(); // room id -> AbortController of the run in progress

export const emit = (room, event) => bus.emit(room.id, event);
export function subscribe(roomId, fn) {
  bus.on(roomId, fn);
  return () => bus.off(roomId, fn);
}
export const isRunning = (roomId) => active.has(roomId);
export function stopRun(roomId) {
  active.get(roomId)?.abort();
}

/** Take a room for a run (or a judge call). Returns the controller, or null when it is busy. */
export function claim(room) {
  if (active.has(room.id)) return null;
  const ctl = new AbortController();
  active.set(room.id, ctl);
  emit(room, { type: 'run', active: true });
  return ctl;
}
export function release(room) {
  active.delete(room.id);
  saveRoom(room);
  emit(room, { type: 'run', active: false });
}

const snapshot = (room) => room.messages.filter((m) => m.status !== 'streaming');
const textOnly = (messages) => messages.map((m) => (Array.isArray(m.content) ? { ...m, content: m.content.find((p) => p.type === 'text')?.text || '' } : m));
const refOf = (url, r) => ({ kind: 'url', url, id: r.id, ok: r.ok, title: r.title, type: r.type, error: r.error, thumb: r.images?.[0]?.file || r.video?.sheet || '', pictures: (r.images?.length || 0) + (r.video?.sheet ? 1 : 0) });

/** Open the web addresses written in a message, so the next speakers (and the Host) get their content. */
async function attachLinks(room, msg, signal) {
  const urls = extractUrls(contextText(msg.text, msg.files)).filter((u) => !msg.refs.some((r) => r.url === u));
  if (!urls.length) return;
  const opened = await Promise.all(urls.map((u) => openUrl(u, { signal })));
  opened.forEach((r, i) => msg.refs.push(refOf(urls[i], r)));
  emit(room, { type: 'message', message: msg });
}

/** The unfinished <<<FILE block at the end of a cut-off reply, if any, so the rest can be joined to it. */
function openFileBlock(text) {
  const start = text.lastIndexOf('<<<FILE ');
  if (start < 0 || text.indexOf('<<<END FILE>>>', start) >= 0) return '';
  if (start > 0 && text[start - 1] !== '\n') return '';
  return text.slice(start);
}

/** One member speaks once. May include a few read/open steps before the reply is complete. */
export async function memberTurn(room, member, ctl, { visible, note = '', round = 0 }) {
  const msg = { id: newId(), role: 'member', memberId: member.id, name: member.name, model: member.model, text: '', status: 'streaming', at: Date.now(), round, files: [], refs: [], tools: [], notes: [], usage: { prompt: 0, completion: 0 } };
  room.messages.push(msg);
  emit(room, { type: 'message', message: msg });
  const started = Date.now();
  let vision = memberVision(member);
  let extra = [];
  let cutOff = false; // the last call stopped at the output limit
  let maxTokens = 0; // 0 = the configured limit; raised once when a model spends it all on thinking
  const call = async (messages) => {
    const ask = () =>
      chat({
        model: member.model,
        messages,
        signal: ctl.signal,
        maxTokens: maxTokens || undefined,
        onDelta: (d) => {
          msg.text += d;
          msg.thinking = false;
          emit(room, { type: 'delta', id: msg.id, text: d });
        },
        onThinking: () => {
          if (!msg.thinking) {
            msg.thinking = true;
            emit(room, { type: 'message', message: msg });
          }
        },
      });
    const start = msg.text.length;
    let r;
    try {
      r = await ask();
    } catch (e) {
      // A raised limit the model does not accept: try once more with a smaller raise.
      const tooBig = maxTokens > config.maxTokens * 2 && e instanceof GmiError && e.status === 400 && /token|max/i.test(e.message) && msg.text.length === start;
      if (!tooBig) throw e;
      maxTokens = config.maxTokens * 2;
      r = await ask();
    }
    msg.usage.prompt += r.usage?.prompt_tokens || 0;
    msg.usage.completion += r.usage?.completion_tokens || 0;
    cutOff = r.finishReason === 'length';
  };
  let finalStep = false;
  let nudged = false;
  let continued = 0;
  let carry = ''; // the start of a file block that was cut off, joined with its continuation
  try {
    for (let step = 0; ; step++) {
      const before = msg.text.length;
      let built = await buildMessages(room, member, visible, { note, extra, vision, signal: ctl.signal });
      try {
        await call(built.messages);
      } catch (e) {
        const imageRefused = e instanceof GmiError && e.status >= 400 && e.status < 500 && ![401, 403, 429].includes(e.status) && built.imageCount > 0 && msg.text.length === before;
        if (!imageRefused) throw e;
        // The request had pictures and was refused: assume this model takes text only, and say so.
        vision = false;
        setCapability(member.model, { vision: false, visionError: e.message });
        msg.notes.push('This model refused the attached pictures, so it answered from text only.');
        extra = textOnly(extra);
        built = await buildMessages(room, member, visible, { note, extra, vision, signal: ctl.signal });
        await call(built.messages);
      }
      // Some models leak their own tool-call markers into the text; they mean nothing here.
      const cleaned = msg.text.slice(before).replace(/\]<\]minimax\[>\[/g, '').replace(/<\/?tool_call>/g, '').replace(/<(mm:think|think)>[\s\S]*?(?:<\/\1>|$)/g, '').replace(/^mm:think[^\n]*(?:\n(?!\n)[^\n]*)*/gm, '');
      msg.text = msg.text.slice(0, before) + cleaned;
      const segment = cleaned;
      if (cutOff && !segment.trim() && !maxTokens) {
        // The whole output limit went into thinking and nothing visible came back: ask once more with room to answer.
        maxTokens = Math.max(config.maxTokens * 4, 32000);
        msg.notes.push(`The model spent its whole output limit (${config.maxTokens} tokens) on thinking, so it was asked again with a limit of ${maxTokens}.`);
        emit(room, { type: 'message', message: msg });
        step--;
        continue;
      }
      const parsed = parseReply(carry + segment);
      carry = cutOff ? openFileBlock(carry + segment) : '';
      const savedNow = [];
      for (const f of parsed.files) {
        const w = writeMemberFile(room, member, f.path, f.content);
        savedNow.push(w.error ? { path: f.path, error: w.error } : { path: w.file.path, size: w.file.size, renamedFrom: w.renamedFrom || undefined });
      }
      msg.files.push(...savedNow);
      if (savedNow.length) emit(room, { type: 'files', files: room.files });
      const budget = readBudget(room);
      const requests = parsed.directives.slice(0, budget.perStep);
      if (!requests.length && step > 0 && !segment.trim() && !nudged) {
        // Read the material, then wrote nothing (seen with thinking models): ask once for the answer.
        nudged = true;
        extra = [...extra, { role: 'assistant', content: '(no reply)' }, { role: 'user', content: '[System]: You wrote nothing after reading. Give your complete answer now, based on what you have read.' }];
        continue;
      }
      if (!requests.length && cutOff && segment.trim() && continued < config.continuations) {
        // Cut off by the output limit: let the member finish, joined seamlessly to what it wrote.
        continued++;
        extra = [...extra, { role: 'assistant', content: segment }, { role: 'user', content: '[System]: Your reply was cut off by the output limit. Continue exactly where it stopped, from the next character. Do not repeat anything and do not add an introduction.' }];
        step--;
        continue;
      }
      if (!requests.length) break;
      if (step >= budget.steps) {
        // Out of read steps: one last call so the member answers with what it has, instead of stopping mid-way.
        if (finalStep) break;
        finalStep = true;
        msg.tools.push(...requests.map((q) => ({ type: q.type, arg: q.arg, ok: false, title: '', error: 'no reads left this turn' })));
        extra = [...extra, { role: 'assistant', content: contextText(segment, savedNow) || '(requested more material)' }, { role: 'user', content: `[System]: You have used all ${budget.steps * budget.perStep} reads for this turn. Do not ask for more. Give your complete answer now, based on what you have read.` }];
        msg.text += '\n\n';
        emit(room, { type: 'message', message: msg });
        continue;
      }
      // Web searches have their own limit per turn (they use the Host's search quota).
      let webLeft = config.searchesPerTurn - msg.tools.filter((t) => t.type === 'web').length;
      const items = requests.map((q) => {
        if (q.type === 'read') return { kind: 'file', path: q.arg };
        if (q.type === 'open') return { kind: 'url', url: q.arg };
        if (q.type === 'web' && webLeft-- <= 0) return { kind: 'web', arg: q.arg, denied: `you have used the ${config.searchesPerTurn} web searches allowed this turn` };
        return { kind: q.type, arg: q.arg };
      });
      const rendered = await renderResources(room, items, { vision, signal: ctl.signal });
      requests.forEach((q, i) => {
        const res = rendered.results[i];
        msg.tools.push({ type: q.type, arg: q.arg, ok: res.ok, title: res.title || '', error: res.error || '' });
        // A page one member opened is attached for the others too, so they can check what was said about it.
        if (q.type === 'open' && res.ok && !msg.refs.some((r) => r.url === q.arg)) msg.refs.push({ kind: 'url', url: q.arg, id: res.id, ok: true, title: res.title, type: res.type, error: '', thumb: '', pictures: 0 });
      });
      extra = [...extra, ...continuation(contextText(segment, savedNow), rendered)];
      msg.text += '\n\n';
      emit(room, { type: 'message', message: msg });
    }
    if (cutOff) msg.notes.push('The reply hit the output limit and may be cut off.');
    if (!msg.text.trim() && !msg.files.length) {
      msg.status = 'error';
      msg.error = cutOff
        ? 'The model spent its whole output limit on thinking and wrote no reply. Ask again with a narrower question, or raise PANELSHOW_MAX_TOKENS.'
        : 'The model returned an empty reply. Ask again, or try another model.';
    } else msg.status = 'done';
  } catch (e) {
    if (ctl.signal.aborted) msg.status = 'stopped';
    else {
      msg.status = 'error';
      msg.error = e instanceof GmiError ? e.message : `Unexpected error: ${e.message}`;
    }
  }
  msg.thinking = false;
  msg.ms = Date.now() - started;
  msg.pass = msg.status === 'done' && isPass(msg.text);
  if (msg.status === 'done' && !msg.pass) await attachLinks(room, msg, ctl.signal).catch(() => {});
  emit(room, { type: 'message', message: msg });
  saveRoom(room);
  if (msg.status === 'done' && !msg.pass) await runImageRequests(room, ctl, { name: member.name, memberId: member.id }, parseImageRequests(msg.text));
  return msg;
}

/**
 * Make the pictures asked for with @@draw / @@edit (by a member or the Host), one after another.
 * Each request becomes an "image" message that shows progress, then the picture (img-N) or the error.
 */
export async function runImageRequests(room, ctl, by, requests) {
  if (!requests.length) return;
  const perTurn = requests.slice(0, Math.max(0, config.imagesPerTurn));
  const skipped = requests.length - perTurn.length;
  let models = [];
  let catalogError = '';
  if (config.apiKey) {
    try {
      models = await imageCatalog();
    } catch (e) {
      catalogError = e.message;
    }
  }
  for (const q of perTurn) {
    if (ctl.signal.aborted) break;
    // "Note: …" is not a model: put it back into the prompt.
    if (q.model && !models.some((m) => m.id.toLowerCase() === q.model.toLowerCase()) && !/[.\-/]\d|-/.test(q.model)) {
      q.prompt = `${q.model}: ${q.prompt}`.trim();
      q.model = '';
    }
    const named = q.model && models.find((m) => m.id.toLowerCase() === q.model.toLowerCase());
    let model = named ? named.id : '';
    if (!q.model) {
      model = defaultImageModel(models);
      if (q.type === 'edit' && !(models.find((m) => m.id === model) || {}).imageToImage) model = (models.find((m) => m.imageToImage && m.textToImage) || models.find((m) => m.imageToImage) || {}).id || model;
    }
    const msg = { id: newId(), role: 'image', name: by.name, memberId: by.memberId || null, action: q.type, model: model || q.model, prompt: q.prompt, refs: q.refs, aspect: q.aspect, images: [], status: 'generating', progress: 'starting', at: Date.now() };
    room.messages.push(msg);
    emit(room, { type: 'message', message: msg });
    const fail = (text) => {
      msg.status = 'error';
      msg.error = text;
    };
    ctl.imagesMade = ctl.imagesMade || 0;
    if (!config.apiKey) fail('Pictures are made on GMI Cloud, and GMI_API_KEY is not set.');
    else if (catalogError) fail(`The list of image models could not be loaded: ${catalogError}`);
    else if (q.model && !named) fail(`${q.model} is not an image model on this GMI key.`);
    else if (!model) fail('No image model is available on this GMI key.');
    else if (!q.prompt) fail('The request has no prompt.');
    else if (ctl.imagesMade >= config.imagesPerRun) fail(`This run already made ${config.imagesPerRun} pictures (PANELSHOW_IMAGES_PER_RUN). Send a new message to make more.`);
    else {
      const refs = [];
      for (const id of q.refs) {
        const got = imageBytes(room, id);
        if (!got) {
          fail(`There is no picture ${id} in this room.`);
          break;
        }
        refs.push({ buffer: got.buffer, mime: got.mime });
      }
      if (msg.status === 'generating') {
        ctl.imagesMade++;
        const t0 = Date.now();
        try {
          const r = await generateImage({
            model,
            prompt: q.prompt,
            refs,
            aspect: q.aspect,
            signal: ctl.signal,
            onStatus: (s) => {
              msg.progress = s;
              msg.elapsed = Math.round((Date.now() - t0) / 1000);
              emit(room, { type: 'message', message: msg });
            },
          });
          const img = addImage(room, r.buffer, { source: 'generated', by: by.name, model, prompt: q.prompt, refs: q.refs, requestId: r.requestId });
          msg.images = [img.id];
          setCapability(`image:${model}`, { ok: true, error: '', at: Date.now() });
          msg.payload = r.payload;
          msg.seconds = r.seconds;
          msg.status = 'done';
        } catch (e) {
          if (ctl.signal.aborted) msg.status = 'stopped';
          else {
            fail(e instanceof GmiError ? e.message : `Unexpected error: ${e.message}`);
            setCapability(`image:${model}`, { ok: false, error: msg.error.slice(0, 160), at: Date.now() });
          }
        }
      }
    }
    delete msg.progress;
    emit(room, { type: 'message', message: msg });
    if (msg.images.length) emit(room, { type: 'images', images: room.images });
    saveRoom(room);
  }
  if (skipped > 0) {
    const note = { id: newId(), role: 'system', name: 'System', text: `${skipped} more picture request${skipped === 1 ? ' was' : 's were'} skipped: at most ${config.imagesPerTurn} per turn.`, status: 'done', at: Date.now() };
    room.messages.push(note);
    emit(room, { type: 'message', message: note });
  }
}

export const RELAY_FANOUTS = 2; // "ask everyone" steps allowed in one relay run, to keep the cost bounded

const RELAY_NOTE = 'You have the floor. Answer, and if another member should continue, mention them as @Name. To hear from everyone at once, write @all (or @Role, for example @Skeptic, to ask everyone with that role): they answer together, then the floor comes back to you.';

/** Several members answer at once, blind to each other. */
function fanOut(room, ctl, asker, group) {
  const visible = snapshot(room);
  const who = asker ? asker.name : 'The Host';
  const after = asker ? ` ${asker.name} continues after you.` : '';
  const note = `${who} asked ${group.length > 1 ? 'several members' : 'you'} at once. Answer independently: the others are answering at the same time and you cannot see their replies yet. Do not hand the floor to anyone.${after}`;
  return Promise.all(group.map((m) => memberTurn(room, m, ctl, { visible, note })));
}

/**
 * Relay: one speaker at a time; @Name hands the floor on.
 * @all or a role group (@Skeptic) asks several members at once; afterwards the floor returns to whoever asked
 * (when the Host asked, the run ends and it is the Host's turn).
 */
async function runRelay(room, ctl, host, maxHops) {
  let hops = 0;
  let fanouts = 0;
  const queue = [];
  const start = addressees(host.text, room.members);
  if (start.broadcast && start.list.length > 1) {
    fanouts++;
    hops++;
    await fanOut(room, ctl, null, start.list);
    return;
  }
  for (const m of start.list.length ? start.list : [room.members[0]]) queue.push({ member: m, note: RELAY_NOTE });
  while (queue.length && hops < maxHops && !ctl.signal.aborted) {
    const { member: m, note } = queue.shift();
    hops++;
    const msg = await memberTurn(room, m, ctl, { visible: snapshot(room), note });
    if (msg.status !== 'done' || queue.length) continue;
    const next = addressees(contextText(msg.text, msg.files), room.members.filter((x) => x.id !== m.id));
    if (next.broadcast && next.list.length > 1 && fanouts < RELAY_FANOUTS && hops + 1 < maxHops) {
      fanouts++;
      hops++;
      await fanOut(room, ctl, m, next.list);
      if (!ctl.signal.aborted) queue.push({ member: m, note: 'The members you asked have answered above. Continue: weigh their answers, decide, or hand the floor on with @Name.' });
    } else if (next.list.length) queue.push({ member: next.list[0], note: RELAY_NOTE });
  }
}

/**
 * The Host sends a message and the members answer in the chosen mode.
 * Returns once the Host message is recorded; the run continues in the background.
 */
export function startRun(room, { text, mode, rounds, maxHops, attachments = [], images = [] }) {
  const ctl = claim(room);
  if (!ctl) throw Object.assign(new Error('The members are still replying. Stop them first.'), { status: 409 });
  mode = ['roundtable', 'parallel', 'relay'].includes(mode) ? mode : 'roundtable';
  rounds = Math.min(5, Math.max(1, Number(rounds) || 1));
  maxHops = Math.min(12, Math.max(1, Number(maxHops) || 6));
  room.settings = { mode, rounds, maxHops };
  const host = { id: newId(), role: 'host', name: 'Host', text: String(text), status: 'done', at: Date.now(), files: attachments.filter((p) => room.files.some((f) => f.path === p)).map((p) => ({ path: p })), images: images.filter((id) => (room.images || []).some((x) => x.id === id)), refs: [] };
  room.messages.push(host);
  emit(room, { type: 'message', message: host });

  const done = (async () => {
    try {
      await attachLinks(room, host, ctl.signal).catch(() => {});
      saveRoom(room);
      // Pictures the Host asked for come first, so the members can see them.
      await runImageRequests(room, ctl, { name: 'Host' }, parseImageRequests(host.text));
      if (ctl.signal.aborted) return;
      const mentioned = mentionsIn(host.text, room.members);
      const targets = mentioned.length ? mentioned : [...room.members];
      if (mode === 'parallel') {
        const visible = snapshot(room);
        const note = 'Answer independently. The other members are answering at the same time and you cannot see their replies yet.';
        await Promise.all(targets.map((m) => memberTurn(room, m, ctl, { visible, note })));
      } else if (mode === 'relay') {
        await runRelay(room, ctl, host, maxHops);
      } else {
        for (let r = 1; r <= rounds && !ctl.signal.aborted; r++) {
          let spoke = 0;
          for (const m of targets) {
            if (ctl.signal.aborted) break;
            const msg = await memberTurn(room, m, ctl, { visible: snapshot(room), round: r, note: rounds > 1 ? `This is round ${r} of ${rounds}.` : '' });
            if (msg.status === 'done' && !msg.pass) spoke++;
          }
          if (!spoke) break; // everyone passed or failed: nothing left to say
        }
      }
    } finally {
      release(room);
    }
  })();
  return { host, done };
}
