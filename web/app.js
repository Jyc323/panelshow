import { html, render, Component, useState, useEffect, useRef, useMemo } from '/vendor/htm-preact.js';
import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

// ---------- helpers ----------

async function api(method, url, body) {
  const raw = body instanceof Blob || body instanceof ArrayBuffer;
  const res = await fetch(url, { method, headers: body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});
const md = (text) => DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }), { FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'], FORBID_ATTR: ['style'] });

const FILE_RE = /^<<<FILE ([^\n>]+)>>>\n([\s\S]*?)\n?<<<END FILE>>>[ \t]*$/gm;
const OPEN_FILE_RE = /^<<<FILE ([^\n>]+)>>>\n[\s\S]*$/m;
const DIRECTIVE_RE = /(^|[^`\w@])@@(read|open|search|list)[ \t]+(?:(?!\s@@(?:read|open|search|list)\b)[^\n`])+/gm; // same rule as the server: on its own line or after a sentence

/** Split a reply into Markdown parts and file cards. Model text is untrusted: it only ever reaches the page through md(). */
function parts(text) {
  const out = [];
  let last = 0;
  const pushText = (t) => {
    let rest = t.replace(DIRECTIVE_RE, '$1');
    const open = rest.match(OPEN_FILE_RE);
    let writing = null;
    if (open) {
      writing = open[1].trim();
      rest = rest.slice(0, open.index);
    }
    if (rest.trim()) out.push({ type: 'md', html: md(rest.trim()) });
    if (writing) out.push({ type: 'writing', path: writing });
  };
  for (const m of text.matchAll(FILE_RE)) {
    pushText(text.slice(last, m.index));
    out.push({ type: 'file', path: m[1].trim(), content: m[2] });
    last = m.index + m[0].length;
  }
  pushText(text.slice(last));
  return out;
}

const isLocal = (id) => String(id || '').startsWith('ollama:');
// "ollama:qwen3:8b" -> "qwen3:8b"; "Qwen/Qwen3.8-Max" -> "Qwen3.8-Max"
const shortModel = (id) => String(id || '').replace(/^ollama:/, '').split('/').pop();
const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
};
const kb = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const canSee = (member, caps) => (typeof member.vision === 'boolean' ? member.vision : Boolean(caps[member.model] && caps[member.model].vision));

// Keep the texts in sync with ROLE_PRESETS in server/prompt.js.
const ROLES = [
  ['No role', ''],
  ['Skeptic', 'Challenge weak claims and ask for evidence. Point out what could go wrong. Do not agree just to be polite.'],
  ['Fact checker', 'Check the factual claims others make. Open the links people cite and say whether the source really supports the claim. Mark anything you could not verify.'],
  ["Devil's advocate", 'Argue the strongest case against whatever the room is leaning toward.'],
  ['Critic', "Review other members' work in detail: what works, what does not, and the single most important fix."],
  ['Synthesizer', 'Listen to the others, then merge the best points into one clear position. Name the disagreements that remain.'],
  ['Writer', 'Turn the discussion into finished text. Save longer pieces as files so others can read them.'],
];

/** Short role name for display and for @Role mentions. */
function roleLabel(m, strict = false) {
  if (m.roleName && m.roleName.trim()) return m.roleName.trim();
  const lead = String(m.role || '').match(/^\s*([^:\n]{1,40}):/);
  if (lead) return lead[1].trim();
  const preset = ROLES.find(([label, text]) => text && text === String(m.role || '').trim());
  if (preset) return preset[0];
  if (strict) return ''; // same rule as the server: only these names work as @Role
  const words = String(m.role || '').trim().split(/\s+/).filter(Boolean);
  return words.length ? words.slice(0, 3).join(' ') + (words.length > 3 ? '…' : '') : '';
}

// ---------- small pieces ----------

function Dialog({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class=${'dialog' + (wide ? ' wide' : '')} role="dialog" aria-label=${title}>
      <header><h2>${title}</h2><button class="ghost" onClick=${onClose} aria-label="Close">✕</button></header>
      <div class="dialog-body">${children}</div>
    </div>
  </div>`;
}

function FileCard({ path, content, saved }) {
  const [open, setOpen] = useState(false);
  const failed = saved && saved.error;
  return html`<div class=${'filecard' + (failed ? ' bad' : '')}>
    <div class="filecard-head">
      <span>📄 <b>${saved && !failed ? saved.path : path}</b> ${saved && saved.renamedFrom ? html`<span class="muted">(saved under a new name: ${saved.renamedFrom} belongs to someone else)</span>` : ''}
        ${failed ? html`<span class="err-text">not saved: ${saved.error}</span>` : html`<span class="muted">${kb(new Blob([content]).size)}</span>`}</span>
      <button class="link" onClick=${() => setOpen(!open)}>${open ? 'Hide' : 'Show'}</button>
    </div>
    ${open ? html`<pre>${content}</pre>` : ''}
  </div>`;
}

function Refs({ refs }) {
  if (!refs || !refs.length) return '';
  return html`<div class="chips">
    ${refs.map(
      (r) => html`<a class=${'chip' + (r.ok ? '' : ' bad')} href=${r.url} target="_blank" rel="noopener noreferrer" title=${r.ok ? r.url : `${r.url}\nCould not be opened: ${r.error}`}>
        ${r.ok && r.thumb ? html`<img src=${`/cache/${r.id}/${r.thumb}`} alt="" />` : ''}
        <span>${r.ok ? '🔗' : '⚠️'} ${r.ok ? r.title || hostOf(r.url) : `${hostOf(r.url)}: ${r.error}`}</span>
        ${r.ok ? html`<span class="muted">${hostOf(r.url)}${r.pictures ? ` · ${r.pictures} picture${r.pictures > 1 ? 's' : ''}` : ''}</span>` : ''}
      </a>`
    )}
  </div>`;
}

function Verdict({ v, members }) {
  const color = (id) => (members.find((m) => m.id === id) || {}).color || '#888';
  const nameOf = (messageId) => (v.candidates.find((c) => c.messageId === messageId) || {}).name || '?';
  const pending = v.judges.filter((j) => j.pending).length;
  return html`<div class="verdict">
    <div class="verdict-title">⚖️ Verdict <span class="muted">· ${v.rubric} rubric · ${v.judges.length} judge${v.judges.length > 1 ? 's' : ''}${pending ? ` · waiting for ${pending}` : v.agreement !== 'none' ? ` · first choices ${v.agreement}` : ''}</span></div>
    ${v.rows.length
      ? html`<table>
          <thead><tr><th>#</th><th>Reply by</th>${v.names.map((n) => html`<th>${n}</th>`)}<th>Mean</th><th>1st picks</th></tr></thead>
          <tbody>
            ${v.rows.map(
              (r, i) => html`<tr class=${i === 0 && r.mean !== null ? 'best' : ''}>
                <td>${r.mean === null ? '–' : i + 1}</td>
                <td><span class="dot" style=${`background:${color(r.memberId)}`}></span>${r.name}</td>
                ${v.names.map((n) => html`<td>${r.byCriterion[n] === null ? '–' : r.byCriterion[n].toFixed(1)}</td>`)}
                <td><b>${r.mean === null ? '–' : r.mean.toFixed(1)}</b></td>
                <td>${r.firsts}</td>
              </tr>`
            )}
          </tbody>
        </table>`
      : ''}
    ${v.judges.map((j) =>
      j.pending
        ? html`<div class="judge muted">${j.name} is judging…</div>`
        : html`<details class="judge">
            <summary><span class="dot" style=${`background:${color(j.memberId)}`}></span><b>${j.name}</b> ${j.result ? html`<span class="muted">ranked ${j.result.ranking.map(nameOf).join(' › ')}${j.excludedOwn ? ' (own reply left out)' : ''}</span>` : html`<span class="err-text">no usable verdict</span>`}</summary>
            ${j.result
              ? html`<p class="muted">This judge saw: ${Object.entries(j.mapping || {}).map(([label, id]) => `${label} = ${nameOf(id)}`).join(', ')}</p><p>${j.result.summary}</p>
                  ${j.result.issues.length ? html`<ul>${j.result.issues.map((i) => html`<li><b>${nameOf(i.messageId)}:</b> ${i.issue}</li>`)}</ul>` : ''}`
              : html`<p class="err-text">${j.error}</p>${j.raw ? html`<pre>${j.raw}</pre>` : ''}`}
          </details>`
    )}
  </div>`;
}

class Message extends Component {
  shouldComponentUpdate(next) {
    return next.m !== this.props.m || next.members !== this.props.members;
  }
  render({ m, members }) {
    if (m.kind === 'verdict') return html`<div class="msg system"><${Verdict} v=${m.verdict} members=${members} /></div>`;
    const member = members.find((x) => x.id === m.memberId);
    const color = m.role === 'host' ? 'var(--host)' : (member && member.color) || '#888';
    if (m.pass) return html`<div class="msg pass"><span class="dot" style=${`background:${color}`}></span>${m.name} passed</div>`;
    const segs = parts(m.text || '');
    let fileIndex = 0;
    return html`<div class=${'msg ' + m.role}>
      <div class="avatar" style=${`background:${color}`}>${(m.name || '?')[0].toUpperCase()}</div>
      <div class="bubble">
        <div class="meta">
          <b style=${`color:${color}`}>${m.name}</b>
          ${m.model ? html`<span class="muted">${shortModel(m.model)}</span>` : ''}
          ${m.round ? html`<span class="muted">round ${m.round}</span>` : ''}
          ${m.status === 'streaming' ? html`<span class="live">${m.thinking ? 'thinking…' : m.text ? 'writing…' : 'waiting…'}</span>` : ''}
          ${m.status === 'stopped' ? html`<span class="muted">stopped</span>` : ''}
        </div>
        ${segs.map((s) =>
          s.type === 'md'
            ? html`<div class="md" dangerouslySetInnerHTML=${{ __html: s.html }}></div>`
            : s.type === 'writing'
              ? html`<div class="filecard"><div class="filecard-head"><span>📄 writing <b>${s.path}</b>…</span></div></div>`
              : html`<${FileCard} path=${s.path} content=${s.content} saved=${(m.files || [])[fileIndex++]} />`
        )}
        ${m.role === 'host' && m.files && m.files.length ? html`<div class="chips">${m.files.map((f) => html`<span class="chip">📎 ${f.path}</span>`)}</div>` : ''}
        ${m.tools && m.tools.length
          ? html`<div class="chips">${m.tools.map((t) => html`<span class=${'chip' + (t.ok ? '' : ' bad')} title=${t.error || t.arg}>${t.ok ? '✓' : '✗'} ${{ read: 'read', open: 'opened', search: 'searched', list: 'listed' }[t.type] || t.type} ${t.type === 'open' ? t.title || hostOf(t.arg) : t.arg}${t.ok ? '' : `: ${t.error}`}</span>`)}</div>`
          : ''}
        <${Refs} refs=${m.refs} />
        ${(m.notes || []).map((n) => html`<div class="note">${n}</div>`)}
        ${m.error ? html`<div class="error">${m.error}</div>` : ''}
        ${m.role === 'member' && m.status !== 'streaming' && m.usage && (m.usage.prompt || m.usage.completion)
          ? html`<div class="foot muted">${m.usage.prompt.toLocaleString()} in · ${m.usage.completion.toLocaleString()} out tokens · ${(m.ms / 1000).toFixed(1)} s</div>`
          : ''}
      </div>
    </div>`;
  }
}

// ---------- dialogs ----------

function autoName(id, taken) {
  const stem = (shortModel(id).match(/[A-Za-z]+/) || ['Model'])[0];
  const base = (stem[0].toUpperCase() + stem.slice(1)).slice(0, 20);
  let n = base;
  for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${base}${i}`;
  taken.add(n.toLowerCase());
  return n;
}

const tagBadges = (m) => [m.vision ? 'sees images' : 'text only', m.tags && m.tags.reasoning && 'reasoning', m.tags && m.tags.fast && 'fast', m.tags && m.tags.flagship && 'flagship', m.latencyMs && `${(m.latencyMs / 1000).toFixed(1)}s`].filter(Boolean);

function SmartInvite({ room, onClose, onError }) {
  const lastHost = [...room.messages].reverse().find((m) => m.role === 'host');
  const [topic, setTopic] = useState(lastHost ? lastHost.text.slice(0, 1000) : '');
  const [count, setCount] = useState(Math.min(6, 8 - room.members.length));
  const [cost, setCost] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [rows, setRows] = useState([]);
  const seatsLeft = 8 - room.members.length;
  useEffect(() => {
    api('GET', `/api/rooms/${room.id}/suggest`).then(setCost, () => setCost(null));
  }, []);
  const suggest = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api('POST', `/api/rooms/${room.id}/suggest`, { topic, count });
      setResult(r);
      setRows(r.members.map((m) => ({ ...m, on: true })));
      api('GET', `/api/rooms/${room.id}/suggest`).then(setCost, () => {});
    } catch (e) {
      onError(e.message);
    }
    setBusy(false);
  };
  const edit = (i, patch) => setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const swap = (i, model) => {
    const alt = result.alternatives.find((a) => a.model === model);
    if (!alt) return;
    const taken = new Set([...room.members.map((m) => m.name.toLowerCase()), ...rows.filter((_, k) => k !== i).map((r) => r.name.toLowerCase())]);
    const old = rows[i];
    result.alternatives = [...result.alternatives.filter((a) => a.model !== model), { model: old.model, vendor: old.vendor, tags: old.tags, vision: old.vision, latencyMs: old.latencyMs }];
    edit(i, { ...alt, name: autoName(model, taken), reason: 'Swapped in by you.' });
  };
  const chosen = rows.filter((r) => r.on);
  const invite = async () => {
    setBusy(true);
    try {
      await api('POST', `/api/rooms/${room.id}/members`, { members: chosen.map(({ name, model, role, roleName }) => ({ name, model, role, roleName })) });
      onClose();
    } catch (e) {
      onError(e.message);
      setBusy(false);
    }
  };
  const usedVendors = (i) => new Set([...rows.filter((r, k) => k !== i && r.on).map((r) => r.vendor)]);
  return html`
    <p class="muted">Describe what the room will discuss. A planning model picks ${count} models that fit, at most one per vendor (each local model family counts as one), and suggests a name and role for each. Nothing is added until you click Invite.</p>
    <textarea rows="3" placeholder="e.g. Review my YouTube thumbnail ideas for a video about GPU cloud pricing" value=${topic} onInput=${(e) => setTopic(e.target.value)} autofocus></textarea>
    <div class="row">
      <label class="inline">How many
        <select onChange=${(e) => setCount(Number(e.target.value))}>${[3, 4, 5, 6].filter((n) => n <= seatsLeft).map((n) => html`<option value=${n} selected=${n === count}>${n}</option>`)}</select>
      </label>
      <span class="muted grow">${busy && !result ? 'Testing new models and asking the planner… this can take a minute.' : cost ? (cost.planning || cost.probes ? `Costs about ${cost.planning} planning request${cost.probes ? ` + ${cost.probes} tiny test call${cost.probes === 1 ? '' : 's'}` : ''}.` : 'No paid requests: only local models, picked by simple rules.') : ''}</span>
      <button class="primary" disabled=${!topic.trim() || busy || seatsLeft <= 0} onClick=${suggest}>${result ? 'Suggest again' : 'Suggest'}</button>
    </div>
    ${seatsLeft <= 0 ? html`<div class="error">This room is full (8 members).</div>` : ''}
    ${result && result.note ? html`<div class="muted pad">${result.note}</div>` : ''}
    ${result && result.director ? html`<div class="muted small">Planned by ${shortModel(result.director)}${result.needVision ? ' · the topic involves pictures, so image-capable models were preferred' : ''}${result.probed ? ` · tested ${result.probed} new model${result.probed === 1 ? '' : 's'}` : ''}</div>` : ''}
    ${rows.length ? html`<div class="suggestions">
      ${rows.map((r, i) => html`<div class=${'suggestion' + (r.on ? '' : ' off')}>
        <div class="row tight">
          <input type="checkbox" checked=${r.on} onChange=${(e) => edit(i, { on: e.target.checked })} aria-label="Include" />
          <input class="name" value=${r.name} maxlength="24" onInput=${(e) => edit(i, { name: e.target.value })} aria-label="Name" />
          <input class="rolename" value=${r.roleName || ''} maxlength="40" placeholder="Role" onInput=${(e) => edit(i, { roleName: e.target.value })} aria-label="Role name" />
          <span class="muted grow mono">${shortModel(r.model)}${isLocal(r.model) ? ' · local' : ''}</span>
          ${result.alternatives.some((a) => !usedVendors(i).has(a.vendor)) ? html`<select class="swap" onChange=${(e) => swap(i, e.target.value)}>
            <option value="" selected>Swap…</option>
            ${result.alternatives.filter((a) => !usedVendors(i).has(a.vendor)).map((a) => html`<option value=${a.model}>${shortModel(a.model)}${isLocal(a.model) ? ' (local)' : ''}</option>`)}
          </select>` : ''}
        </div>
        <div class="badges"><span class="badge">${r.vendor}</span>${tagBadges(r).map((b) => html`<span class="badge">${b}</span>`)}</div>
        ${r.reason ? html`<div class="reason">${r.reason}</div>` : ''}
        <textarea rows="2" placeholder="Role (optional)" value=${r.role} onInput=${(e) => edit(i, { role: e.target.value })}></textarea>
      </div>`)}
    </div>
    <div class="row end">
      <span class="muted grow">${chosen.length} selected · each member replies once per round</span>
      <button class="primary" disabled=${!chosen.length || busy} onClick=${invite}>Invite ${chosen.length}</button>
    </div>` : ''}
  `;
}

function PickModels({ room, caps, onClose, onError }) {
  const [models, setModels] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState([]); // [{model, name}]
  const [role, setRole] = useState('');
  const [roleName, setRoleName] = useState('');
  const [busy, setBusy] = useState(false);
  const seatsLeft = 8 - room.members.length;
  const load = (refresh) => {
    setModels(null);
    api('GET', '/api/models' + (refresh ? '?refresh=1' : '')).then((r) => {
      setModels(r.models);
      setLoadError(r.error || '');
    }, (e) => setLoadError(e.message));
  };
  useEffect(() => load(false), []);
  const toggle = (id) => {
    if (picked.some((p) => p.model === id)) return setPicked(picked.filter((p) => p.model !== id));
    if (picked.length >= seatsLeft) return onError(`This room has room for ${seatsLeft} more member${seatsLeft === 1 ? '' : 's'}.`);
    const taken = new Set([...room.members.map((m) => m.name.toLowerCase()), ...picked.map((p) => p.name.toLowerCase())]);
    setPicked([...picked, { model: id, name: autoName(id, taken) }]);
  };
  const shown = (models || []).filter((m) => m.id.toLowerCase().includes(q.toLowerCase()));
  const groups = [['GMI Cloud', shown.filter((m) => !isLocal(m.id))], ['Local (Ollama) · free, runs on your machine', shown.filter((m) => isLocal(m.id))]].filter(([, list]) => list.length);
  const invite = async () => {
    setBusy(true);
    try {
      await api('POST', `/api/rooms/${room.id}/members`, { members: picked.map((p) => ({ ...p, role, roleName })) });
      onClose();
    } catch (e) {
      onError(e.message);
      setBusy(false);
    }
  };
  return html`
    <div class="row">
      <input class="grow" placeholder="Search models…" value=${q} onInput=${(e) => setQ(e.target.value)} />
      <button class="ghost" onClick=${() => load(true)} title="Ask GMI and Ollama for the list again">Refresh</button>
    </div>
    <div class="modellist">
      ${models === null && !loadError ? html`<div class="muted pad">Loading the model list…</div>` : ''}
      ${loadError ? html`<div class="error">${loadError}</div>` : ''}
      ${models && !models.length && !loadError ? html`<div class="muted pad">No models found. Add a GMI key to .env, or start Ollama and pull a model (ollama pull qwen3:8b).</div>` : ''}
      ${groups.map(([label, list]) => html`
        ${groups.length > 1 || isLocal(list[0].id) ? html`<div class="groupname">${label}</div>` : ''}
        ${list.map((m) => {
          const c = caps[m.id];
          const on = picked.some((p) => p.model === m.id);
          return html`<button class=${'model' + (on ? ' on' : '')} onClick=${() => toggle(m.id)}>
            <span>${on ? '✓ ' : ''}${isLocal(m.id) ? shortModel(m.id) : m.id}</span>
            ${c ? html`<span class=${'badge' + (c.ok === false ? ' bad' : '')}>${c.ok === false ? (c.local ? 'not a chat model' : 'failed a test call') : c.vision ? 'sees images' : 'text only'}</span>` : ''}
          </button>`;
        })}`)}
    </div>
    ${picked.length ? html`<div class="picked">
      ${picked.map((p, i) => html`<div class="row tight">
        <input class="name" value=${p.name} maxlength="24" onInput=${(e) => setPicked(picked.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
        <span class="muted grow mono">${p.model}</span>
        <button class="ghost" onClick=${() => toggle(p.model)} aria-label="Remove">✕</button>
      </div>`)}
    </div>` : ''}
    <label>Role${picked.length > 1 ? ' (for all of them; change one later by clicking its name)' : ''}
      <select onChange=${(e) => {
        const preset = ROLES.find(([, text]) => text === e.target.value);
        setRole(e.target.value);
        setRoleName(preset && preset[1] ? preset[0] : '');
      }}>${ROLES.map(([label, text]) => html`<option value=${text} selected=${text === role}>${label}</option>`)}</select>
    </label>
    <textarea rows="2" placeholder="Optional: describe the job in the room" value=${role} onInput=${(e) => setRole(e.target.value)}></textarea>
    <div class="row end">
      <span class="muted grow">Click several models to invite them together. New GMI models get two tiny test calls; local models are checked for free.</span>
      <button class="primary" disabled=${!picked.length || picked.some((p) => !p.name) || busy} onClick=${invite}>Invite${picked.length > 1 ? ` ${picked.length}` : ''}</button>
    </div>
  `;
}

function InviteDialog({ room, caps, onClose, onError }) {
  const [tab, setTab] = useState('smart');
  return html`<${Dialog} title="Invite models" onClose=${onClose} wide=${true}>
    <div class="tabs">
      <button class=${tab === 'smart' ? 'on' : ''} onClick=${() => setTab('smart')}>Smart invite</button>
      <button class=${tab === 'pick' ? 'on' : ''} onClick=${() => setTab('pick')}>Pick models</button>
    </div>
    ${tab === 'smart' ? html`<${SmartInvite} room=${room} onClose=${onClose} onError=${onError} />` : html`<${PickModels} room=${room} caps=${caps} onClose=${onClose} onError=${onError} />`}
  <//>`;
}

function MemberDialog({ room, member, caps, running, onClose, onError }) {
  const [role, setRole] = useState(member.role || '');
  const [roleName, setRoleName] = useState(roleLabel(member));
  const c = caps[member.model];
  const patch = (body) => api('PATCH', `/api/rooms/${room.id}/members/${member.id}`, body).catch((e) => onError(e.message));
  return html`<${Dialog} title=${member.name} onClose=${onClose}>
    <p class="muted">${member.model}${c ? ` · test: ${c.ok === false ? `failed (${c.error})` : c.vision ? 'answers, accepts images' : 'answers, text only'}` : ' · not tested yet'}</p>
    <label>Role name <input value=${roleName} maxlength="40" placeholder="e.g. Skeptic" onInput=${(e) => setRoleName(e.target.value)} /></label>
    <p class="muted">Shown next to the name. Writing @${(roleName || 'Role').replace(/[^A-Za-z0-9]+/g, '')} in a message addresses everyone with this role.</p>
    <label>What this member should do <textarea rows="4" value=${role} onInput=${(e) => setRole(e.target.value)}></textarea></label>
    <label>Images
      <select onChange=${(e) => patch({ vision: e.target.value === 'auto' ? null : e.target.value === 'yes' })}>
        <option value="auto" selected=${member.vision === null || member.vision === undefined}>Automatic (from the test call)</option>
        <option value="yes" selected=${member.vision === true}>Send images to this member</option>
        <option value="no" selected=${member.vision === false}>Never send images</option>
      </select>
    </label>
    <div class="row end">
      <button class="ghost" disabled=${running} onClick=${() => patch({ move: 'up' })}>Speak earlier</button>
      <button class="ghost" disabled=${running} onClick=${() => patch({ move: 'down' })}>Speak later</button>
      <span class="grow"></span>
      <button class="danger" disabled=${running} onClick=${() => api('DELETE', `/api/rooms/${room.id}/members/${member.id}`).then(onClose, (e) => onError(e.message))}>Remove</button>
      <button class="primary" disabled=${running} onClick=${() => patch({ role, roleName }).then(onClose)}>Save</button>
    </div>
  <//>`;
}

function JudgeDialog({ room, rubrics, onClose, onError }) {
  const replies = room.messages.filter((m) => m.role === 'member' && m.status === 'done' && !m.pass);
  const lastHost = room.messages.map((m) => m.role).lastIndexOf('host');
  const recent = room.messages.slice(lastHost + 1).filter((m) => replies.includes(m)).map((m) => m.id);
  const [picked, setPicked] = useState(recent.length >= 2 ? recent : replies.slice(-4).map((m) => m.id));
  const [judges, setJudges] = useState(room.members.map((m) => m.id));
  const [rubric, setRubric] = useState('general');
  const [custom, setCustom] = useState('');
  const [extra, setExtra] = useState('');
  const toggle = (list, set, id) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const go = () => {
    const criteria = custom.split('\n').map((s) => s.trim()).filter(Boolean);
    api('POST', `/api/rooms/${room.id}/judge`, { messageIds: picked, judgeIds: judges, rubric, criteria: criteria.length ? criteria : undefined, extra }).then(onClose, (e) => onError(e.message));
  };
  return html`<${Dialog} title="Judge replies" onClose=${onClose} wide>
    <p class="muted">Judges get the replies as Candidate A, B, C… in shuffled order, without names. A judge does not score its own reply when at least two others remain.</p>
    <h3>Replies to judge</h3>
    <div class="picklist">
      ${replies.slice(-12).map((m) => html`<label class="check"><input type="checkbox" checked=${picked.includes(m.id)} onChange=${() => toggle(picked, setPicked, m.id)} /> <b>${m.name}</b> <span class="muted">${(m.text || '').replace(/<<<FILE[\s\S]*?(<<<END FILE>>>|$)/g, '[file]').replace(/\s+/g, ' ').slice(0, 90)}</span></label>`)}
      ${replies.length < 2 ? html`<div class="muted">There are not yet two finished replies in this room.</div>` : ''}
    </div>
    <h3>Judges</h3>
    <div class="row wrap">${room.members.map((m) => html`<label class="check"><input type="checkbox" checked=${judges.includes(m.id)} onChange=${() => toggle(judges, setJudges, m.id)} /> ${m.name}</label>`)}</div>
    <h3>Rubric</h3>
    <select onChange=${(e) => setRubric(e.target.value)}>${Object.entries(rubrics || {}).map(([k, r]) => html`<option value=${k} selected=${k === rubric}>${r.name}: ${r.criteria.map((c) => c.split(':')[0]).join(', ')}</option>`)}</select>
    <textarea rows="3" placeholder="Or write your own criteria, one per line, e.g.  Originality: is the idea new?" value=${custom} onInput=${(e) => setCustom(e.target.value)}></textarea>
    <input placeholder="Optional: extra instructions for the judges" value=${extra} onInput=${(e) => setExtra(e.target.value)} />
    <div class="row end">
      <span class="muted grow">${judges.length} request${judges.length === 1 ? '' : 's'} will be sent.</span>
      <button class="primary" disabled=${picked.length < 2 || !judges.length} onClick=${go}>Judge</button>
    </div>
  <//>`;
}

/** Read-only project folders on this computer, shared with the members. */
function FolderPanel({ room, onError, onOpen }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const [info, setInfo] = useState({});
  const folders = room.folders || [];
  const add = async () => {
    if (!input.trim() || busy) return;
    setBusy(true);
    try {
      const f = await api('POST', `/api/rooms/${room.id}/folders`, { path: input.trim() });
      setInput('');
      setInfo((x) => ({ ...x, [f.id]: f }));
    } catch (e) {
      onError(e.message);
    }
    setBusy(false);
  };
  const toggle = async (f) => {
    if (open === f.id) return setOpen(null);
    setOpen(f.id);
    try {
      const d = await api('GET', `/api/rooms/${room.id}/folders/${f.id}`);
      setInfo((x) => ({ ...x, [f.id]: d }));
    } catch (e) {
      onError(e.message);
    }
  };
  const skippedText = (k) => [k.dependencies && 'dependency/build folders', k.secret && `${k.secret} secret file${k.secret === 1 ? '' : 's'}`, k.ignored && `${k.ignored} ignored by .gitignore`, k.binary && `${k.binary} binary`, k.links && `${k.links} link${k.links === 1 ? '' : 's'}`].filter(Boolean).join(', ');
  return html`<div class="folders">
    <h3>Project folders</h3>
    <div class="muted">Read-only. Members can read, search and list these files; whatever they read is sent to the model provider. Secrets (.env, keys), dependencies and .gitignore'd files are left out.</div>
    <div class="row tight addfolder">
      <input class="grow" placeholder="~/code/my-app" value=${input} onInput=${(e) => setInput(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && add()} aria-label="Folder path" />
      <button class="ghost" disabled=${!input.trim() || busy} onClick=${add}>Share</button>
    </div>
    ${folders.map((f) => {
      const d = info[f.id];
      return html`<div class="folder" key=${f.id}>
        <div class="row tight">
          <button class="fileitem grow" onClick=${() => toggle(f)} title=${f.path}><span>${open === f.id ? '▾' : '▸'} 🗂 ${f.name}</span><span class="muted">${d ? `${d.files} files · read-only` : 'read-only'}</span></button>
          <button class="ghost" title="Stop sharing this folder" aria-label="Stop sharing" onClick=${() => api('DELETE', `/api/rooms/${room.id}/folders/${f.id}`).catch((e) => onError(e.message))}>✕</button>
        </div>
        ${open === f.id && d && d.paths
          ? html`<div class="foldertree">
              ${d.paths.slice(0, 400).map((x) => html`<button class="fileitem sub" onClick=${() => onOpen(f, x.path)}><span>${x.path}</span><span class="muted">${kb(x.size)}</span></button>`)}
              ${d.paths.length > 400 ? html`<div class="muted">…and ${d.paths.length - 400} more</div>` : ''}
              ${skippedText(d.skipped) ? html`<div class="muted">Not shared: ${skippedText(d.skipped)}.</div>` : ''}
            </div>`
          : ''}
      </div>`;
    })}
  </div>`;
}

function FolderFileDialog({ room, folder, path, onClose }) {
  const [text, setText] = useState(null);
  useEffect(() => {
    fetch(`/api/rooms/${room.id}/folder-file?folder=${folder.id}&path=${encodeURIComponent(path)}`).then((r) => r.text().then((t) => setText(r.ok ? t : `(could not be read: ${(JSON.parse(t || '{}').error) || r.status})`)), () => setText('(could not be read)'));
  }, [folder.id, path]);
  return html`<${Dialog} title=${`${folder.name}/${path}`} onClose=${onClose} wide>
    <p class="muted">Read-only view of a file in your shared folder. Members ask for it with <code>@@read ${folder.name}/${path}</code>.</p>
    <pre class="filetext">${text === null ? 'Loading…' : text}</pre>
  <//>`;
}

function FileDialog({ room, file, onClose }) {
  const [text, setText] = useState(null);
  useEffect(() => {
    fetch(`/api/rooms/${room.id}/file?path=${encodeURIComponent(file.path)}`).then((r) => r.text()).then(setText, () => setText('(could not be read)'));
  }, [file.path, file.version]);
  return html`<${Dialog} title=${file.path} onClose=${onClose} wide>
    <p class="muted">${file.kind === 'text' ? 'Text file' : `${file.kind.toUpperCase()}: the extracted text is shown`} · ${kb(file.size)} · by ${file.authorName}${file.note ? ` · ${file.note}` : ''} · <a href=${`/api/rooms/${room.id}/file?download=1&path=${encodeURIComponent(file.path)}`}>Download</a></p>
    <pre class="filetext">${text === null ? 'Loading…' : text}</pre>
  <//>`;
}

// ---------- the app ----------

function App() {
  const [rooms, setRooms] = useState([]);
  const [roomId, setRoomId] = useState(location.hash.slice(1) || '');
  const [room, setRoom] = useState(null);
  const [caps, setCaps] = useState({});
  const [running, setRunning] = useState(false);
  const [health, setHealth] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [toast, setToast] = useState('');
  const [text, setText] = useState('');
  const [mode, setMode] = useState('roundtable');
  const [rounds, setRounds] = useState(1);
  const [hops, setHops] = useState(6);
  const [pending, setPending] = useState([]); // uploaded files waiting to go with the next message
  const [showFiles, setShowFiles] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const thread = useRef(null);
  const stick = useRef(true);
  const fileInput = useRef(null);

  const fail = (msg) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? '' : t)), 6000);
  };
  const loadRooms = () => api('GET', '/api/rooms').then(setRooms, (e) => fail(e.message));

  useEffect(() => {
    api('GET', '/api/health').then(setHealth, () => {});
    loadRooms();
    const onHash = () => setRoomId(location.hash.slice(1));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    setRoom(null);
    setPending([]);
    setConfirmDelete(false);
    if (!roomId) return;
    let closed = false;
    api('GET', `/api/rooms/${roomId}`).then(
      (r) => {
        if (closed) return;
        setRoom(r.room);
        setCaps(r.capabilities);
        setRunning(r.room.running);
        setMode(r.room.settings.mode);
        setRounds(r.room.settings.rounds);
        setHops(r.room.settings.maxHops);
      },
      () => {
        location.hash = '';
      }
    );
    const es = new EventSource(`/api/rooms/${roomId}/events`);
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === 'run') {
        setRunning(ev.active);
        if (!ev.active) loadRooms();
      } else if (ev.type === 'capabilities') setCaps(ev.capabilities);
      else if (ev.type === 'notice') fail(ev.text);
      else if (ev.type === 'room') {
        setRoom((r) => (r ? { ...r, title: ev.room.title, members: ev.room.members, folders: ev.room.folders || [] } : r));
        // Keep the member count in the sidebar current (members are added or removed outside a run).
        setRooms((list) => list.map((x) => (x.id === ev.room.id ? { ...x, title: ev.room.title, members: ev.room.members.length } : x)));
      }
      else if (ev.type === 'files') setRoom((r) => (r ? { ...r, files: ev.files } : r));
      else if (ev.type === 'message')
        setRoom((r) => {
          if (!r) return r;
          const i = r.messages.findIndex((m) => m.id === ev.message.id);
          const messages = i >= 0 ? r.messages.map((m, k) => (k === i ? ev.message : m)) : [...r.messages, ev.message];
          return { ...r, messages };
        });
      else if (ev.type === 'delta') setRoom((r) => (r ? { ...r, messages: r.messages.map((m) => (m.id === ev.id ? { ...m, text: m.text + ev.text, thinking: false } : m)) } : r));
    };
    return () => {
      closed = true;
      es.close();
    };
  }, [roomId]);

  // Follow the newest message unless the reader scrolled up.
  useEffect(() => {
    const el = thread.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [room && room.messages]);

  const newRoom = () => api('POST', '/api/rooms', { title: 'New room' }).then((r) => {
    loadRooms();
    location.hash = r.id;
  }, (e) => fail(e.message));

  const targets = useMemo(() => {
    if (!room) return { n: 0, broadcast: false };
    let broadcast = false;
    const norm = (x) => String(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const hit = new Set();
    for (const m of text.matchAll(/(?<![\p{L}\p{N}_.])@([\p{L}\p{N}_.-]+)/gu)) {
      const raw = m[1].toLowerCase().replace(/[.-]+$/, '');
      if (['all', 'everyone', 'everybody'].includes(raw)) return { n: room.members.length, broadcast: true };
      const byName = room.members.find((x) => x.name.toLowerCase() === raw);
      if (byName) hit.add(byName.id);
      else {
        const k = norm(raw);
        let group = room.members.filter((x) => k && norm(roleLabel(x, true)) === k);
        if (!group.length && k.endsWith('s')) group = room.members.filter((x) => norm(roleLabel(x, true)) === k.slice(0, -1));
        group.forEach((x) => hit.add(x.id));
        if (group.length > 1) broadcast = true;
      }
    }
    return { n: hit.size || room.members.length, broadcast };
  }, [text, room && room.members]);
  // Relay: each hop is one reply, except an @all step, where several members answer at once (at most 2 per run).
  // A Host @all / @Role-group in Relay is one step: everyone named answers once.
  const requests = mode === 'roundtable' ? targets.n * rounds : mode === 'parallel' || targets.broadcast ? targets.n : hops + Math.min(2, hops) * Math.max(0, (room ? room.members.length : 1) - 1);

  const sendMessage = () => {
    if (!text.trim() || running) return;
    stick.current = true;
    api('POST', `/api/rooms/${roomId}/send`, { text, mode, rounds, maxHops: hops, attachments: pending.map((f) => f.path) }).then(() => {
      setText('');
      setPending([]);
    }, (e) => fail(e.message));
  };
  const upload = async (files) => {
    for (const f of files) {
      try {
        const entry = await api('POST', `/api/rooms/${roomId}/upload?name=${encodeURIComponent(f.name)}`, f);
        setPending((p) => [...p, entry]);
      } catch (e) {
        fail(e.message);
      }
    }
  };

  const ollama = health && health.providers ? health.providers.ollama : null;
  const noKey = health && !health.hasKey && !(ollama && ollama.reachable);
  const missingGmi = room && health && !health.hasKey && room.members.some((m) => !isLocal(m.model));
  return html`<div class="layout">
    <aside class="side">
      <div class="brand">PanelShow</div>
      <button class="primary block" onClick=${newRoom}>+ New room</button>
      <nav>
        ${rooms.map((r) => html`<a class=${'roomlink' + (r.id === roomId ? ' on' : '')} href=${'#' + r.id}><span>${r.title}</span><span class="muted">${r.members} model${r.members === 1 ? '' : 's'} · ${r.messages} msg</span></a>`)}
        ${!rooms.length ? html`<div class="muted pad">No rooms yet.</div>` : ''}
      </nav>
      <div class="sidefoot muted">
        ${health ? html`<div>API: ${health.hasKey ? hostOf(health.baseUrl) : 'GMI Cloud off (no key)'}</div>${ollama && ollama.enabled ? html`<div>Ollama: ${ollama.reachable ? `${ollama.models} local model${ollama.models === 1 ? '' : 's'}` : 'not running'}</div>` : ''}<div>${health.ffmpeg ? 'ffmpeg found: images and video frames are prepared' : 'ffmpeg not found: video frames are skipped'}</div>` : ''}
      </div>
    </aside>

    <main class="main">
      ${noKey ? html`<div class="banner">No models are set up. For GMI Cloud, copy <code>.env.example</code> to <code>.env</code>, put your key after <code>GMI_API_KEY=</code>, and restart the server. For local models, start Ollama and pull a model (<code>ollama pull qwen3:8b</code>).</div>` : ''}
      ${!noKey && missingGmi ? html`<div class="banner">This room has GMI Cloud members, but no GMI key is set. Add <code>GMI_API_KEY</code> to <code>.env</code> and restart, or remove those members.</div>` : ''}
      ${!room
        ? html`<div class="empty"><h1>PanelShow</h1><p>Host your own AI panel: invite GMI Cloud or local models, let them argue, read links and files, and judge each other.</p><button class="primary" onClick=${newRoom}>+ New room</button></div>`
        : html`
            <header class="top">
              <input class="title" value=${room.title} onChange=${(e) => api('PATCH', `/api/rooms/${room.id}`, { title: e.target.value }).then(loadRooms, (er) => fail(er.message))} aria-label="Room title" />
              <div class="members">
                ${room.members.map(
                  (m) => html`<button class="member" onClick=${() => setDialog({ type: 'member', id: m.id })} title=${`${m.model}${m.role ? `\nRole: ${m.role}` : ''}\nClick to edit`}>
                    <span class="dot" style=${`background:${m.color}`}></span>${m.name}${roleLabel(m) ? html`<span class="role" title=${m.role}>${roleLabel(m)}</span>` : ''}<span class="muted">${shortModel(m.model)}</span>${isLocal(m.model) ? html`<span class="local" title="Runs on your machine through Ollama">local</span>` : ''}${canSee(m, caps) ? html`<span title="Gets images">👁</span>` : ''}${caps[m.model] && caps[m.model].ok === false ? html`<span title=${caps[m.model].error}>⚠️</span>` : ''}
                  </button>`
                )}
                <button class="ghost" onClick=${() => setDialog({ type: 'invite' })}>+ Invite</button>
              </div>
              <div class="actions">
                <button class="ghost" disabled=${running} onClick=${() => setDialog({ type: 'judge' })}>⚖️ Judge</button>
                <button class="ghost" onClick=${() => setShowFiles(!showFiles)}>📁 Files${room.files.length + (room.folders || []).length ? ` (${room.files.length + (room.folders || []).length})` : ''}</button>
                <a class="ghost btn" href=${`/api/rooms/${room.id}/export`}>Export</a>
                ${confirmDelete
                  ? html`<button class="danger" onClick=${() => api('DELETE', `/api/rooms/${room.id}`).then(() => { loadRooms(); location.hash = ''; }, (e) => fail(e.message))}>Really delete</button>`
                  : html`<button class="ghost" onClick=${() => setConfirmDelete(true)} title="Delete this room">🗑</button>`}
              </div>
            </header>

            <div class="content">
              <div class="thread" ref=${thread} onScroll=${(e) => (stick.current = e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight < 80)}>
                ${!room.members.length ? html`<div class="hint">Invite one or more models to start. <button class="link" onClick=${() => setDialog({ type: 'invite' })}>Invite models</button></div>` : ''}
                ${room.members.length && !room.messages.length ? html`<div class="hint">Write a message below. Paste links, attach files or share a project folder (📁 Files) and the members can read them. Mention <b>@Name</b> to address only some members.</div>` : ''}
                ${room.messages.map((m) => html`<${Message} key=${m.id} m=${m} members=${room.members} />`)}
              </div>
              ${showFiles
                ? html`<aside class="files">
                    <${FolderPanel} room=${room} onError=${fail} onOpen=${(folder, p) => setDialog({ type: 'folderfile', folder, path: p })} />
                    <h3>Shared files</h3>
                    ${!room.files.length ? html`<div class="muted">Nothing yet. Members can write files; you can attach text, PDF and Word files to a message.</div>` : ''}
                    ${room.files.map((f) => html`<button class="fileitem" onClick=${() => setDialog({ type: 'file', path: f.path })}><span>📄 ${f.path}</span><span class="muted">${kb(f.size)} · ${f.authorName}${f.version > 1 ? ` · v${f.version}` : ''}</span></button>`)}
                  </aside>`
                : ''}
            </div>

            <footer class="composer">
              ${pending.length ? html`<div class="chips">${pending.map((f) => html`<span class="chip">📎 ${f.path} <button class="link" onClick=${() => setPending(pending.filter((x) => x !== f))}>✕</button></span>`)}</div>` : ''}
              <textarea rows="3" placeholder=${!room.members.length ? 'Invite a model first' : mode === 'relay' ? 'Message the room…  @Name picks who starts · @all asks everyone at once · @Skeptic asks a role' : 'Message the room…  (Enter to send, Shift+Enter for a new line · @Name or @Role to address some members)'} value=${text}
                onInput=${(e) => setText(e.target.value)}
                onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); } }}></textarea>
              <div class="row">
                <input type="file" multiple hidden ref=${fileInput} onChange=${(e) => { upload([...e.target.files]); e.target.value = ''; }} />
                <button class="ghost" onClick=${() => fileInput.current.click()} title="Attach text, PDF or Word files">📎 Attach</button>
                <select value=${mode} onChange=${(e) => setMode(e.target.value)} title="How the members take turns">
                  <option value="roundtable">Roundtable: in order, seeing each other</option>
                  <option value="parallel">Parallel: at once, not seeing each other</option>
                  <option value="relay">Relay: hand over with @Name</option>
                </select>
                ${mode === 'roundtable' ? html`<label class="inline">rounds <input type="number" min="1" max="5" value=${rounds} onInput=${(e) => setRounds(Math.min(5, Math.max(1, Number(e.target.value) || 1)))} /></label>` : ''}
                ${mode === 'relay' ? html`<label class="inline">max turns <input type="number" min="1" max="12" value=${hops} onInput=${(e) => setHops(Math.min(12, Math.max(1, Number(e.target.value) || 1)))} /></label>` : ''}
                <span class="grow muted right">${room.members.length ? `${mode === 'relay' && !targets.broadcast ? 'up to ' : ''}${requests} request${requests === 1 ? '' : 's'}${mode === 'roundtable' && rounds > 1 ? ' at most' : ''}${room.members.some((m) => isLocal(m.model)) ? (room.members.every((m) => isLocal(m.model)) ? ' · all local, free' : ' · local ones are free') : ''}` : ''}</span>
                ${running ? html`<button class="danger" onClick=${() => api('POST', `/api/rooms/${roomId}/stop`)}>Stop</button>` : html`<button class="primary" disabled=${!text.trim() || !room.members.length} onClick=${sendMessage}>Send</button>`}
              </div>
            </footer>
          `}
    </main>

    ${room && dialog && dialog.type === 'invite' ? html`<${InviteDialog} room=${room} caps=${caps} onClose=${() => setDialog(null)} onError=${fail} />` : ''}
    ${room && dialog && dialog.type === 'member' && room.members.find((m) => m.id === dialog.id) ? html`<${MemberDialog} room=${room} member=${room.members.find((m) => m.id === dialog.id)} caps=${caps} running=${running} onClose=${() => setDialog(null)} onError=${fail} />` : ''}
    ${room && dialog && dialog.type === 'judge' ? html`<${JudgeDialog} room=${room} rubrics=${health && health.rubrics} onClose=${() => setDialog(null)} onError=${fail} />` : ''}
    ${room && dialog && dialog.type === 'file' && room.files.find((f) => f.path === dialog.path) ? html`<${FileDialog} room=${room} file=${room.files.find((f) => f.path === dialog.path)} onClose=${() => setDialog(null)} />` : ''}
    ${room && dialog && dialog.type === 'folderfile' ? html`<${FolderFileDialog} room=${room} folder=${dialog.folder} path=${dialog.path} onClose=${() => setDialog(null)} />` : ''}
    ${toast ? html`<div class="toast" role="alert">${toast}</div>` : ''}
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
