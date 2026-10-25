/* cIM panel: a thin client over the daemon's loopback API (spec section 5).
 *
 * Everything an agent wrote is untrusted text. This file never assigns it to innerHTML:
 * nodes are built with h() and text goes in through textContent. The page's CSP also forbids inline script.
 */
'use strict';

// ---- small helpers ---------------------------------------------------------------------------

const PROPS = new Set(['disabled', 'checked', 'value', 'open', 'selected', 'readOnly']);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : String(kid));
  }
  return el;
}

const enc = encodeURIComponent;
const $ = (sel, root) => (root || document).querySelector(sel);

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* an empty or non-JSON body */
  }
  if (!res.ok) throw new Error((json && json.error) || `${res.status} from ${path}`);
  return json;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return rtf.format(-m, 'minute');
  const hr = Math.round(m / 60);
  if (hr < 24) return rtf.format(-hr, 'hour');
  return rtf.format(-Math.round(hr / 24), 'day');
}

const isStopped = (a) => a.pid === undefined || a.pid === null;
const isMessageable = (a) => !!a.inboxSocketPath;
const shortID = (a) => a.sessionID.slice(0, 8);
const projectOf = (a) => a.cwd.split('/').filter(Boolean).pop() || a.cwd;

// ---- state -----------------------------------------------------------------------------------------

const S = {
  snap: null,
  right: null, // { kind, key, data }
  chips: new Map(), // turn id -> { report, chores } | { report: null }
  expanded: new Map(), // turn id -> boolean
  drafts: new Map(), // draft key -> text
  seenToasts: null, // Set once the first snapshot has been taken
  scroll: new Map(), // transcript key -> { top, atBottom }
  lastSig: '',
  offline: false,
};

function toast(text, kind) {
  const el = h('div', { class: 'toast' + (kind === 'err' ? ' err' : ''), text });
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 9000 : 6000);
}

/** Run an action; show an error as a toast; then refresh. */
async function act(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'err');
  } finally {
    await load();
  }
}

// ---- loading ---------------------------------------------------------------------------------------------

async function prefetchChips(turns) {
  const todo = turns.filter((t) => t.role === 'assistant' && t.text.includes('```cim-status') && !S.chips.has(t.id));
  await Promise.all(
    todo.map(async (t) => {
      try {
        S.chips.set(t.id, await api('POST', '/chip', { turnText: t.text }));
      } catch {
        S.chips.set(t.id, { report: null });
      }
    })
  );
}

async function fetchRight(sel) {
  if (!sel) return null;
  try {
    if (sel.kind === 'agent') {
      let t;
      try {
        t = await api('GET', `/agents/${enc(sel.sessionID)}/thread`);
      } catch {
        t = await api('POST', `/agents/${enc(sel.sessionID)}/select`);
      }
      await prefetchChips(t.turns);
      return { kind: 'agent', key: `agent:${sel.sessionID}`, data: t };
    }
    if (sel.kind === 'group') {
      const g = await api('GET', `/groups/${enc(sel.key)}`);
      await prefetchChips(g.turns.map((x) => x.turn));
      return { kind: 'group', key: `group:${sel.key}`, data: g };
    }
    if (sel.kind === 'volunteer') {
      const v = await api('GET', `/volunteer/${enc(sel.id)}`);
      return { kind: 'volunteer', key: `volunteer:${sel.id}`, data: v };
    }
  } catch {
    return null;
  }
  return null;
}

let loading = null;
async function load() {
  // Coalesce: one load in flight, one queued.
  if (loading) {
    loading.again = true;
    return loading.promise;
  }
  const run = { again: false, promise: null };
  loading = run;
  run.promise = (async () => {
    try {
      do {
        run.again = false;
        const snap = await api('GET', '/state');
        S.snap = snap;
        S.right = await fetchRight(snap.selection);
        S.offline = false;
        showNewToasts(snap.toasts);
        render();
      } while (run.again);
    } catch {
      S.offline = true;
      render();
    } finally {
      loading = null;
    }
  })();
  return run.promise;
}

function showNewToasts(list) {
  if (S.seenToasts === null) {
    S.seenToasts = new Set(list.map((t) => t.id));
    return;
  }
  for (const t of list) {
    if (S.seenToasts.has(t.id)) continue;
    S.seenToasts.add(t.id);
    toast(t.text);
    if (t.clipboard && navigator.clipboard) navigator.clipboard.writeText(t.clipboard).catch(() => {});
  }
}

// ---- rendering: orchestration (keeps focus, selection and scroll across re-renders) ------------------------

function render() {
  if (!S.snap) return;
  const sig = JSON.stringify([S.snap, S.right, S.offline], (k, v) => (k === 'at' || k === 'toasts' ? undefined : v));
  if (sig === S.lastSig) return;
  S.lastSig = sig;

  const active = document.activeElement;
  const focusKey = active && active.dataset ? active.dataset.draft : undefined;
  const caret = focusKey !== undefined ? [active.selectionStart, active.selectionEnd] : null;
  for (const el of document.querySelectorAll('.transcript')) {
    S.scroll.set(el.dataset.scroll, { top: el.scrollTop, atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 48 });
  }
  const leftTop = $('#left').scrollTop;

  // replaceChildren turns a null argument into the text "null", so empty slots are dropped here, in one place.
  const mount = (el, nodes) => el.replaceChildren(...nodes.filter(Boolean));
  mount($('#header'), renderHeader());
  mount($('#left'), renderLeft());
  mount($('#right'), renderRight());

  $('#left').scrollTop = leftTop;
  for (const el of document.querySelectorAll('.transcript')) {
    const prev = S.scroll.get(el.dataset.scroll);
    el.scrollTop = !prev || prev.atBottom ? el.scrollHeight : prev.top;
  }
  if (focusKey !== undefined) {
    const el = document.querySelector(`[data-draft="${CSS.escape(focusKey)}"]`);
    if (el) {
      el.focus();
      if (caret) el.setSelectionRange(caret[0], caret[1]);
    }
  }
}

// ---- header --------------------------------------------------------------------------------------------------

function renderHeader() {
  const snap = S.snap;
  const agents = snap.roster.agents;
  const msgable = agents.filter(isMessageable).length;
  const running = agents.filter((a) => !isStopped(a)).length;
  const resumeN = snap.resumeSet ? snap.resumeSet.entries.length : 0;
  const btn = (label, onclick, disabled, title) => h('button', { class: 'btn', text: label, onclick, disabled, title });
  return [
    h('span', { class: 'title', text: 'cIM' }),
    snap.roster.liveCount > 0 ? h('span', { class: 'live', text: `${snap.roster.liveCount} LIVE` }) : null,
    h('span', { class: 'subtitle', text: 'Claude Instant Messenger: message a running Claude Code agent in its own session, and have it pass things along to another.' }),
    S.offline ? h('span', { class: 'pill red', text: 'daemon unreachable' }) : null,
    h(
      'div',
      { class: 'buttons' },
      btn('Message All', () => act(() => api('POST', '/message-all')), msgable < 2, 'Open a thread with every agent that has a live inbox (needs two or more)'),
      btn('Status Check', statusCheckSheet, msgable < 1, 'Ask agents for a structured status reply'),
      btn('Find Volunteer', volunteerSheet, msgable < 1, 'Ask who has context on a task'),
      btn('New Group', newGroupSheet, msgable < 2, 'A shared thread with chosen agents'),
      btn('Pause Agents', () => act(() => api('POST', '/pause')), running === 0 || snap.flags.isPausing, 'Ask every running agent to stop at a safe point'),
      btn(resumeN ? `Resume Agents (${resumeN})` : 'Resume Agents', () => act(() => api('POST', '/resume')), !resumeN || snap.flags.isResuming, 'Bring back the paused or stopped agents'),
      btn('Refresh', () => act(() => api('POST', '/refresh')), snap.roster.isRefreshing)
    ),
  ];
}

// ---- left column ---------------------------------------------------------------------------------------------

function renderLeft() {
  const snap = S.snap;
  const out = [];
  if (snap.roster.hasLoaded && snap.resumeSet) {
    const rs = snap.resumeSet;
    const n = rs.entries.length;
    out.push(
      h(
        'div',
        { class: 'banner' },
        h('strong', { text: rs.paused ? `${n} agent${n === 1 ? '' : 's'} paused ${ago(rs.recordedAt)}` : `${n} agent${n === 1 ? '' : 's'} stopped since cIM last saw them running` }),
        h('div', { class: 'names', text: rs.entries.map((e) => e.name).join(', ') }),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn small primary', text: 'Resume All', disabled: snap.flags.isResuming, onclick: () => act(() => api('POST', '/resume')) }),
          h('button', { class: 'btn small', text: 'Dismiss', title: 'Forget this list, sessions stay where they are', onclick: () => act(() => api('POST', '/resume/dismiss')) }),
          snap.flags.isResuming ? h('span', { class: 'spin' }) : null
        )
      )
    );
  }
  for (const a of snap.roster.agents) out.push(agentCard(a));
  if (snap.roster.agents.length === 0) {
    out.push(
      snap.roster.hasLoaded
        ? h('div', { class: 'empty-left' }, h('div', { class: 'big', text: '◯' }), h('div', { text: 'No agents running' }), h('div', { class: 'small', text: 'Start one with `claude -n "a name"` and it shows up here.' }))
        : h('div', { class: 'empty-left' }, h('span', { class: 'spin' }), snap.roster.lastError ? h('div', { class: 'small error', text: snap.roster.lastError }) : null)
    );
  }
  if (snap.volunteers.length) {
    out.push(h('div', { class: 'section-head', text: 'Volunteer Requests' }));
    for (const v of snap.volunteers) {
      const selected = snap.selection && snap.selection.kind === 'volunteer' && snap.selection.id === v.id;
      const badge = v.phase === 'failed' ? h('span', { class: 'pill red', text: 'failed' }) : v.assignee ? h('span', { class: 'pill green', text: v.assignee }) : h('span', { class: 'pill', text: `${v.volunteers} volunteered` });
      out.push(
        h(
          'div',
          { class: 'row-item' + (selected ? ' selected' : ''), onclick: () => act(() => api('POST', `/volunteer/${enc(v.id)}/select`)) },
          h('span', { text: v.assignee ? '✔' : '☝' }),
          h('button', { class: 'label', text: v.title, title: v.title }),
          badge,
          h('button', { class: 'iconbtn', text: '×', title: "Close this request. Agents already asked are not messaged again", onclick: (e) => (e.stopPropagation(), act(() => api('DELETE', `/volunteer/${enc(v.id)}`))) })
        )
      );
    }
  }
  if (snap.groups.length) {
    out.push(h('div', { class: 'section-head', text: 'Groups' }));
    for (const g of snap.groups) {
      const selected = snap.selection && snap.selection.kind === 'group' && snap.selection.key === g.key;
      const names = g.participants.map((p) => p.name).join(', ');
      out.push(
        h(
          'div',
          { class: 'row-item' + (selected ? ' selected' : ''), onclick: () => act(() => api('POST', `/groups/${enc(g.key)}/select`)) },
          h('span', { text: '◎' }),
          h('button', { class: 'label', text: names, title: names }),
          g.isAwaitingReply ? h('span', { class: 'spin' }) : null,
          h('button', { class: 'iconbtn', text: '×', title: 'Close this group thread', onclick: (e) => (e.stopPropagation(), act(() => api('DELETE', `/groups/${enc(g.key)}`))) })
        )
      );
    }
  }
  if (snap.archived.length) {
    out.push(
      h(
        'details',
        { class: 'archived' },
        h('summary', { text: `Archived (${snap.archived.length})` }),
        snap.archived.map((e) =>
          h(
            'div',
            { class: 'row-item' },
            h('span', { class: 'label', text: e.name, title: e.name }),
            h('span', { class: 'mono micro muted', text: e.projectName }),
            h('button', { class: 'iconbtn', text: '↶', title: 'Unarchive. It returns to the list if the session is still running', onclick: () => act(() => api('POST', `/archive/${enc(e.sessionID)}/restore`)) })
          )
        )
      )
    );
  }
  return out;
}

function agentCard(a) {
  const snap = S.snap;
  const selected = snap.selection && snap.selection.kind === 'agent' && snap.selection.sessionID === a.sessionID;
  const state = a.status || 'stopped';
  const pending = snap.flags.donePending.includes(a.sessionID);
  const select = () => act(() => api('POST', `/agents/${enc(a.sessionID)}/select`));
  const card = h(
    'div',
    { class: 'card' + (selected ? ' selected' : ''), 'data-session': a.sessionID, onclick: select },
    // The button is what a keyboard or a screen reader reaches; a click on it bubbles to the card, so select runs once.
    h(
      'button',
      { class: 'card-main', 'aria-pressed': selected ? 'true' : 'false' },
      h('span', { class: 'top' }, h('span', { class: 'dot ' + (a.status || '') }), h('span', { class: 'small', text: state }), h('span', { class: 'spacer' }), h('span', { class: 'kind ' + a.kind, text: a.kind })),
      h('span', { class: 'name', text: a.name, title: a.name }),
      h('span', { class: 'meta mono' }, h('span', { class: 'project', text: projectOf(a), title: a.cwd }), h('span', { text: shortID(a), title: 'Session id prefix: what /resume, `claude attach`, and the job id show' }))
    ),
    h(
      'div',
      { class: 'bottom' },
      h('span', { text: ago(a.startedAt) }),
      isStopped(a) ? h('span', { text: '\u25B6', title: 'Stopped. Sending it a message resumes it in the background' }) : !isMessageable(a) ? h('span', { text: '\u2298', title: "No live inbox. This session can't be messaged" }) : null,
      h('span', { class: 'spacer' }),
      pending
        ? h('span', { class: 'spin' })
        : h('button', {
            class: 'btn small borderless green',
            text: 'Done',
            title: isMessageable(a) ? 'Ask this session to clean up worktrees and journal to the wiki, then archive it' : 'Archive this session. It has no live inbox, so nothing is sent',
            onclick: (e) => (e.stopPropagation(), act(() => api('POST', `/agents/${enc(a.sessionID)}/done`))),
          })
    )
  );
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      ['Rename…', () => renameSheet(a)],
      ['Copy Session ID', () => navigator.clipboard && navigator.clipboard.writeText(a.sessionID).then(() => toast('Copied the session id'), () => toast(a.sessionID))],
    ]);
  });
  return card;
}

function contextMenu(x, y, items) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const menu = h('div', { class: 'menu' }, items.map(([label, fn]) => h('button', { text: label, onclick: () => (menu.remove(), fn()) })));
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.append(menu);
  const close = () => (menu.remove(), document.removeEventListener('click', close, true));
  setTimeout(() => document.addEventListener('click', close, true), 0);
}

// ---- right column: shared pieces -------------------------------------------------------------------------------

function renderRight() {
  const r = S.right;
  if (!r) return [h('div', { class: 'pane-empty' }, h('div', { class: 'big', text: 'Pick an agent' }), h('div', { text: 'Its session log loads here, and anything you send lands in its live prompt box.' }))];
  if (r.kind === 'agent') return renderChat(r.data, r.key);
  if (r.kind === 'group') return renderGroup(r.data, r.key);
  return renderVolunteer(r.data, r.key);
}

function transcript(key, children) {
  return h('div', { class: 'transcript', 'data-scroll': key }, children);
}

function initials(name) {
  return (name || '?').trim().slice(0, 1).toUpperCase();
}

function bubble(turn, { mine, label, avatar }) {
  const body = h('div', { class: 'bubble', text: turn.text });
  return h(
    'div',
    { class: 'turn ' + (mine ? 'user' : 'assistant'), 'data-turn': turn.id },
    mine ? null : h('div', { class: 'avatar', text: avatar || 'C' }),
    h('div', { class: 'bubble-wrap' }, label ? h('div', { class: 'sender', text: label }) : null, body, turn.clipped ? h('div', { class: 'clipped', text: 'Clipped here. The rest is in the session log.' }) : null),
    mine ? h('div', { class: 'avatar', text: 'Y' }) : null
  );
}

function thinking(text) {
  return h('div', { class: 'turn assistant' }, h('div', { class: 'avatar', text: '…' }), h('div', { class: 'bubble-wrap' }, h('div', { class: 'bubble thinking', text })));
}

/** The composer. Its draft lives in S.drafts so a re-render never eats typed text. */
function composer({ draftKey, placeholder, enabled, onSend, secondary }) {
  const ta = h('textarea', { rows: 1, placeholder, 'data-draft': draftKey, value: S.drafts.get(draftKey) || '' });
  const send = h('button', { class: 'send', text: '↑', title: 'Send (Cmd/Ctrl-Return)', disabled: true });
  const second = secondary ? h('button', { class: 'btn secondary', text: secondary.label, title: secondary.title, disabled: true }) : null;
  const sync = () => {
    const has = ta.value.trim().length > 0;
    send.disabled = !(enabled && has);
    if (second) second.disabled = !(secondary.enabled && has);
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  };
  const fire = async (fn) => {
    const text = ta.value;
    if (!text.trim()) return;
    S.drafts.set(draftKey, '');
    ta.value = '';
    sync();
    const delivered = await fn(text);
    if (delivered === false) S.drafts.set(draftKey, text); // never lose typed text
    await load();
    lastRestore();
  };
  const lastRestore = () => {
    const el = document.querySelector(`[data-draft="${CSS.escape(draftKey)}"]`);
    if (el && !el.value && S.drafts.get(draftKey)) el.value = S.drafts.get(draftKey);
  };
  ta.addEventListener('input', () => (S.drafts.set(draftKey, ta.value), sync()));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (e.shiftKey && second && !second.disabled) fire(secondary.fn);
      else if (!send.disabled) fire(onSend);
    }
  });
  send.addEventListener('click', () => fire(onSend));
  if (second) second.addEventListener('click', () => fire(secondary.fn));
  queueMicrotask(sync);
  return h('div', { class: 'composer' }, ta, second, send);
}

const NO_INBOX = 'This session has no live inbox, so it can’t be messaged. Its log is still readable above.';

// ---- 1:1 chat ---------------------------------------------------------------------------------------------------

function renderChat(t, key) {
  const a = t.agent;
  const canTarget = isMessageable(a) || (isStopped(a) && !t.isResuming);
  const presets = S.snap.settings.modelPresets;
  const model = t.selectedModel;
  const termDisabled = !isStopped(a) && a.kind === 'interactive';
  const termTitle = termDisabled
    ? `This session is running in a terminal already (pid ${a.pid})`
    : !isStopped(a) && a.jobID
      ? `Opens a terminal and runs claude attach ${a.jobID}`
      : `Opens a terminal and runs claude --resume ${shortID(a)} in ${projectOf(a)}`;
  const items = [];
  if (t.isLoading) items.push(h('div', { class: 'muted small' }, h('span', { class: 'spin' }), ' Loading session log…'));
  else if (t.turns.length === 0) items.push(h('div', { class: 'pane-empty' }, h('div', { class: 'big', text: 'No conversation yet' }), h('div', { text: "This session hasn't written any turns to its transcript." })));
  for (const turn of t.turns) items.push(turnNode(turn, { mine: turn.role === 'user', agentId: a.sessionID, agentName: a.name, groupKey: null, expandDefault: false }));
  if (t.isResuming) items.push(thinking(`Resuming ${a.name} in the background…`));
  else if (t.isAwaitingReply) items.push(thinking(`Delivered, waiting for ${a.name}…`));
  return [
    h(
      'div',
      { class: 'chat-head' },
      h('div', { class: 'who' }, h('div', { class: 'nm', text: a.name }), h('div', { class: 'cwd mono', text: a.cwd, title: a.cwd })),
      h('button', { class: 'iconbtn', text: '✎', title: 'Rename', onclick: () => renameSheet(a) }),
      h('button', { class: 'btn small', text: 'Open in Terminal', disabled: termDisabled, title: termTitle, onclick: () => act(async () => { const r = await api('POST', `/agents/${enc(a.sessionID)}/terminal`); if (r.opened) toast('Opened a terminal'); }) }),
      h(
        'select',
        {
          'aria-label': 'Model',
          disabled: !isMessageable(a),
          onchange: (e) => act(async () => { await api('POST', `/agents/${enc(a.sessionID)}/model`, { model: e.target.value }); }),
        },
        model ? null : h('option', { value: '', text: 'Model…', selected: true }),
        model && !presets.some((p) => p.id === model) ? h('option', { value: model, text: model, selected: true }) : null,
        presets.map((p) => h('option', { value: p.id, text: p.label, selected: p.id === model }))
      )
    ),
    transcript(key, items),
    t.errorMessage ? h('div', { class: 'error', text: t.errorMessage }) : null,
    isMessageable(a) || isStopped(a)
      ? composer({
          draftKey: key,
          placeholder: isMessageable(a) ? `Message ${a.name}…` : `Message ${a.name} to resume it…`,
          enabled: canTarget,
          onSend: async (text) => (await api('POST', `/agents/${enc(a.sessionID)}/message`, { text })).delivered,
          secondary: t.offersSendAsUser
            ? {
                label: 'Send as me',
                title: 'Send as me (Cmd/Ctrl-Shift-Return): restarts this idle session with your text as a real user turn, so it carries your authority instead of arriving as a peer message',
                enabled: !t.isResuming,
                fn: async (text) => (await api('POST', `/agents/${enc(a.sessionID)}/send-as-me`, { text })).delivered,
              }
            : null,
        })
      : h('div', { class: 'notice', text: NO_INBOX }),
  ];
}

// ---- turns and status chips ---------------------------------------------------------------------------------------

function turnNode(turn, { mine, agentId, agentName, groupKey, expandDefault, label }) {
  const chip = S.chips.get(turn.id);
  if (!mine && chip && chip.report) return chipNode(turn, chip, { agentId, agentName, groupKey, expandDefault, label });
  return bubble(turn, { mine, label, avatar: initials(agentName) });
}

const TINT = { working: 'blue', planning: 'grey', paused: 'amber', waiting_for_human: 'red', blocked: 'amber', gave_up: 'red', done: 'green' };
const statusBadge = (r) => h('span', { class: 'badge ' + (TINT[r.status] || 'grey'), text: (r.status || r.statusRaw || 'unknown').replace(/_/g, ' ') });

function chipNode(turn, chip, ctx) {
  const r = chip.report;
  const open = S.expanded.has(turn.id) ? S.expanded.get(turn.id) : !!ctx.expandDefault;
  const toggle = () => (S.expanded.set(turn.id, !open), (S.lastSig = ''), render());
  const summary = r.remainingFile ? r.remainingFile : r.remaining.length ? `${r.remaining.length} remaining item${r.remaining.length === 1 ? '' : 's'}` : 'Nothing outstanding';
  const c = chip.chores;
  const choreBtn = (name, state, glyph, onclick, disabled) =>
    h('button', { class: 'chore ' + state, disabled, title: `${name}: ${state.replace('-', ' ')}`, 'aria-label': `${name}, ${state.replace('-', ' ')}`, onclick }, h('span', { class: 'glyph', 'aria-hidden': 'true', text: glyph }), name);
  const glyph = { done: '✓', 'needs-attention': '!', pending: '○' };
  const chores = c.anyReported
    ? h(
        'div',
        { class: 'chores' },
        choreBtn('wiki', c.wiki, glyph[c.wiki], () => runChore('wiki', ctx, turn)),
        choreBtn('worktrees', c.worktrees, glyph[c.worktrees], () => runChore('worktrees', ctx, turn), c.worktrees === 'done'),
        choreBtn('TB/UV', c.tbUv, glyph[c.tbUv], () => runChore('tbuv', ctx, turn))
      )
    : null;
  return h(
    'div',
    { class: 'turn assistant', 'data-turn': turn.id, 'data-chip': r.status || 'unknown' },
    h('div', { class: 'avatar', text: initials(ctx.agentName) }),
    h(
      'div',
      { class: 'bubble-wrap' },
      ctx.label ? h('div', { class: 'sender', text: ctx.label }) : null,
      h(
        'div',
        { class: 'chip' },
        h('div', { class: 'head' }, statusBadge(r), h('span', { class: 'scope', text: r.scope || '(no scope given)', title: r.scope || '' })),
        h('button', { class: 'disclosure', onclick: toggle, 'aria-expanded': open }, h('span', { class: r.remainingFile ? 'mono' : '', text: summary }), h('span', { text: open ? '▴' : '▾' })),
        open && r.remaining.length ? h('ol', null, r.remaining.map((x) => h('li', { text: x }))) : null,
        open ? chores : null
      )
    )
  );
}

async function runChore(kind, ctx, turn) {
  const body = { turnText: turn.text, ...(ctx.groupKey ? { groupKey: ctx.groupKey } : {}) };
  const path = `/agents/${enc(ctx.agentId)}/chore/${kind}`;
  await act(async () => {
    let out = await api('POST', path, body);
    if (out.action === 'needs-confirmation') {
      const wiki = kind === 'wiki';
      const ok = await confirmSheet({
        title: wiki ? out.text : 'Clean up worktrees?',
        reasons: out.reasons,
        intro: wiki ? 'This session has not completed its assigned tasks. It will be asked to journal now and to say in the entry that it is incomplete.' : 'Check before cleaning up:',
        confirmLabel: wiki ? 'Write to Wiki' : out.text,
      });
      if (!ok) return;
      out = await api('POST', path, { ...body, confirmed: true });
    }
    if (out.action === 'sent' && kind !== 'tbuv') toast(kind === 'wiki' ? `Asked ${ctx.agentName} to journal to the wiki` : `Asked ${ctx.agentName} to clean up its worktrees`);
    if (out.action === 'open-wiki-entry') infoSheet('Wiki entry', [`${out.path}`, '', 'Looked for in:', ...out.searchDirs]);
    if (out.action === 'sign-off') signOffSheet(out.records, ctx);
  });
}

// ---- group chat and review --------------------------------------------------------------------------------------------

function renderGroup(g, key) {
  const names = g.participants.map((p) => p.name).join(', ');
  const anyInbox = g.participants.some(isMessageable);
  const head = h(
    'div',
    { class: 'chat-head' },
    h('div', { class: 'who' }, h('div', { class: 'nm', text: names, title: names }), h('div', { class: 'cwd', text: `${g.participants.length} agents in this thread` })),
    h(
      'div',
      { class: 'segmented' },
      h('button', { class: g.isReviewing ? '' : 'on', text: 'Thread', onclick: () => act(() => api('POST', `/groups/${enc(g.key)}/review`, { isReviewing: false })) }),
      h('button', { class: g.isReviewing ? 'on' : '', text: 'Review', onclick: () => act(() => api('POST', `/groups/${enc(g.key)}/review`, { isReviewing: true })) })
    )
  );
  const rollup = g.rollup.length
    ? h('div', { class: 'rollup' }, g.rollup.map((x) => h('span', { class: 'badge ' + (TINT[x.status] || 'grey'), text: `${x.count} ${x.status.replace(/_/g, ' ')}` })))
    : null;
  if (g.isReviewing) return [head, rollup, renderReview(g)];
  const items = [];
  if (g.isLoading) items.push(h('div', { class: 'muted small' }, h('span', { class: 'spin' }), ' Loading session logs…'));
  for (const gt of g.turns) {
    const mine = gt.sessionID === '';
    items.push(
      turnNode(gt.turn, {
        mine,
        agentId: gt.sessionID,
        agentName: gt.agentName,
        groupKey: g.key,
        expandDefault: false,
        label: mine ? `You${gt.recipients ? ' → ' + gt.recipients.map((id) => (g.participants.find((p) => p.sessionID === id) || {}).name || id).join(', ') : ''}` : gt.agentName,
      })
    );
  }
  if (g.isAwaitingReply) items.push(thinking('Delivered, waiting on the group…'));
  return [
    head,
    rollup,
    transcript(key, items),
    g.errorMessage ? h('div', { class: 'error', text: g.errorMessage }) : null,
    composer({ draftKey: key, placeholder: 'Message the group…', enabled: anyInbox, onSend: async (text) => (await api('POST', `/groups/${enc(g.key)}/message`, { text })).delivered }),
  ];
}

function renderReview(g) {
  const hd = g.header;
  const sel = g.entries.find((e) => e.sessionID === g.selection) || g.entries[0];
  const idx = g.entries.indexOf(sel);
  const rows = g.entries.map((e) => {
    const status = e.state === 'awaiting' ? h('span', { class: 'micro muted' }, h('span', { class: 'spin' }), ' awaiting reply') : e.state === 'noReply' ? h('span', { class: 'micro muted', text: 'no reply' }) : e.report ? statusBadge(e.report) : h('span', { class: 'badge grey', text: 'prose reply' });
    const pick = () => act(() => api('POST', `/groups/${enc(g.key)}/review`, { selection: e.sessionID }));
    return h(
      'div',
      { class: 'review-row' + (e === sel ? ' selected' : ''), 'data-review': e.sessionID, onclick: pick },
      h('button', { class: 'tick' + (e.isReviewed ? ' on' : ''), text: e.isReviewed ? '\u2713' : '', disabled: !e.latestReplyID, title: e.isReviewed ? 'Reviewed' : 'Mark reviewed', 'aria-label': `${e.isReviewed ? 'Reviewed' : 'Mark reviewed'}: ${e.name}`, onclick: (ev) => (ev.stopPropagation(), act(() => api('POST', `/groups/${enc(g.key)}/review/${enc(e.sessionID)}/mark-reviewed`))) }),
      h('button', { class: 'body', 'aria-current': e === sel ? 'true' : null }, h('span', { class: 'nm', text: e.name }), status, e.report && e.report.scope ? h('span', { class: 'micro muted', text: e.report.scope }) : null)
    );
  });
  const list = h('div', { class: 'review-list' }, h('div', { class: 'hd', text: `${hd.replied} of ${hd.total} replied · ${hd.reviewed} reviewed` }), rows);
  if (!sel) return h('div', { class: 'review' }, list);
  const participant = g.participants.find((p) => p.sessionID === sel.sessionID);
  const move = (d) => g.entries[idx + d] && act(() => api('POST', `/groups/${enc(g.key)}/review`, { selection: g.entries[idx + d].sessionID }));
  const body = [];
  if (sel.state === 'awaiting') body.push(thinking(`Delivered, waiting for ${sel.name}…`));
  else if (sel.state === 'noReply') body.push(h('div', { class: 'pane-empty' }, h('div', { class: 'big', text: 'No reply yet' }), h('div', { text: `${sel.name} has not answered since the last status check.` })));
  for (const gt of sel.since) {
    const mine = gt.sessionID === '';
    body.push(turnNode(gt.turn, { mine, agentId: gt.sessionID, agentName: gt.agentName, groupKey: g.key, expandDefault: true, label: mine ? 'You' : undefined }));
  }
  const detail = h(
    'div',
    { class: 'review-detail' },
    h(
      'div',
      { class: 'chat-head' },
      h('div', { class: 'who' }, h('div', { class: 'nm', text: sel.name }), h('div', { class: 'cwd mono', text: sel.cwd })),
      h('button', { class: 'iconbtn', text: '↑', title: 'Previous (Option-Cmd-Up)', disabled: idx <= 0, onclick: () => move(-1) }),
      h('button', { class: 'iconbtn', text: '↓', title: 'Next (Option-Cmd-Down)', disabled: idx >= g.entries.length - 1, onclick: () => move(1) }),
      h('button', { class: 'btn small primary', text: 'Mark Reviewed', disabled: !sel.latestReplyID || sel.isReviewed, title: 'Cmd-Shift-Return', onclick: () => act(() => api('POST', `/groups/${enc(g.key)}/review/${enc(sel.sessionID)}/mark-reviewed`)) })
    ),
    transcript(`review:${g.key}:${sel.sessionID}`, body),
    participant && isMessageable(participant)
      ? composer({ draftKey: `review:${g.key}:${sel.sessionID}`, placeholder: `Reply to ${sel.name} only…`, enabled: true, onSend: async (text) => (await api('POST', `/groups/${enc(g.key)}/review/${enc(sel.sessionID)}/reply`, { text })).delivered })
      : h('div', { class: 'notice', text: NO_INBOX })
  );
  return h('div', { class: 'review' }, list, detail);
}

// ---- volunteer ----------------------------------------------------------------------------------------------------------

function renderVolunteer(v) {
  const name = (id) => (v.recipients.find((a) => a.sessionID === id) || {}).name || id;
  const parts = [];
  parts.push(h('div', null, h('div', { class: 'nm', text: v.title }), h('div', { class: 'muted small', text: `Asked by ${v.requester} · ${v.reached.length} agent${v.reached.length === 1 ? '' : 's'}` })));
  parts.push(h('div', { class: 'small', 'data-summary': v.phase }, v.phase === 'collecting' && v.isListening ? h('span', { class: 'spin' }) : null, ' ', v.summary, ' ', v.phase === 'collecting' && !v.isListening ? h('button', { class: 'btn small', text: 'Listen Again', onclick: () => act(() => api('POST', `/volunteer/${enc(v.id)}/listen`)) }) : null));
  if (v.errorMessage) parts.push(h('div', { class: 'error', text: v.errorMessage }));
  if (v.assignee) {
    parts.push(
      h(
        'div',
        { class: 'cardbox assigned' },
        h('div', { class: 'grow' }, h('strong', { text: v.assignee.spawned ? `Started ${v.assignee.name}${v.assignee.model ? ' on ' + v.assignee.model : ''}` : `Briefed ${v.assignee.name}` }), h('div', { class: 'small muted', text: 'Everyone else was told no more volunteers are needed.' })),
        v.assigneeAgent ? h('button', { class: 'btn small', text: 'Open thread', onclick: () => act(() => api('POST', `/agents/${enc(v.assigneeAgent.sessionID)}/select`)) }) : h('span', { class: 'small muted' }, h('span', { class: 'spin' }), ` Waiting for ${v.assignee.name} to show up in the agent list…`)
      )
    );
  }
  if (v.volunteers.length) {
    parts.push(h('div', { class: 'section-head', text: 'Volunteers' }));
    for (const a of v.volunteers) {
      const ans = v.answers[a.sessionID];
      const picked = v.assignee && v.assignee.sessionID === a.sessionID;
      parts.push(
        h(
          'div',
          { class: 'cardbox', 'data-volunteer': a.sessionID },
          h('div', { class: 'grow' }, h('strong', { text: a.name }), h('span', { class: 'mono micro muted', text: ` ${projectOf(a)}` }), h('div', { class: 'small', text: ans.context || '(no context given)' })),
          picked ? h('span', { class: 'pill green', text: 'picked' }) : h('button', { class: 'btn small primary', text: 'Pick', disabled: v.phase === 'assigned' || v.isAssigning, onclick: () => act(() => api('POST', `/volunteer/${enc(v.id)}/assign`, { sessionID: a.sessionID })) })
        )
      );
    }
  }
  const names = (label, list) => (list.length ? h('div', { class: 'small' }, h('strong', { text: `${label}: ` }), list.join(', ')) : null);
  parts.push(names('Declined', v.declined.map((a) => a.name)));
  parts.push(names('No answer yet', v.unanswered.filter((a) => !v.silent[a.sessionID]).map((a) => a.name)));
  parts.push(names('Busy, no answer', Object.keys(v.silent).filter((id) => v.silent[id] === 'busy').map(name)));
  parts.push(names('Offline, no answer', Object.keys(v.silent).filter((id) => v.silent[id] === 'offline').map(name)));
  if (v.phase !== 'assigned') {
    const sel = h('select', { 'aria-label': 'Agent to assign' }, S.snap.roster.agents.filter(isMessageable).map((a) => h('option', { value: a.sessionID, text: a.name })));
    parts.push(
      h(
        'div',
        { class: 'assign-row' },
        h('span', { class: 'small muted', text: 'Assign anyway:' }),
        sel,
        h('button', { class: 'btn small', text: 'Assign', disabled: v.isAssigning, onclick: () => act(() => api('POST', `/volunteer/${enc(v.id)}/assign`, { sessionID: sel.value })) }),
        h('button', { class: 'btn small', text: 'Start New Agent…', onclick: () => spawnSheet(v) })
      )
    );
  }
  parts.push(h('details', null, h('summary', { class: 'small', text: 'Task description' }), h('div', { class: 'pre', text: v.description })));
  return [h('div', { class: 'vol' }, parts)];
}

// ---- sheets ---------------------------------------------------------------------------------------------------------------------

function openSheet(title, body, actions) {
  const dlg = h('dialog', { class: 'sheet' }, h('h2', { text: title }), body, h('div', { class: 'sheet-actions' }, actions(() => dlg.close())));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}
const cancelBtn = (close) => h('button', { class: 'btn', text: 'Cancel', onclick: close });

function checks(agents, selected) {
  return h(
    'div',
    { class: 'checks' },
    agents.map((a) => h('label', null, h('input', { type: 'checkbox', value: a.sessionID, checked: selected }), h('span', { text: a.name }), h('span', { class: 'mono micro muted', text: projectOf(a) })))
  );
}
const checked = (root) => [...root.querySelectorAll('input[type=checkbox]')].filter((c) => c.checked).map((c) => c.value);

function statusCheckSheet() {
  const list = checks(S.snap.roster.agents.filter(isMessageable), true);
  openSheet('Status Check', h('div', null, h('div', { class: 'small muted', text: 'Each checked agent is asked to reply with one structured status block. The thread opens in review mode.' }), list), (close) => [
    cancelBtn(close),
    h('button', { class: 'btn primary', text: 'Send Status Check', onclick: () => { const ids = checked(list); close(); if (ids.length) act(() => api('POST', '/status-check', { sessionIDs: ids })); } }),
  ]);
}

function newGroupSheet() {
  const list = checks(S.snap.roster.agents.filter(isMessageable), false);
  const create = h('button', { class: 'btn primary', text: 'Create Group', disabled: true });
  list.addEventListener('change', () => (create.disabled = checked(list).length < 2));
  create.addEventListener('click', () => { const ids = checked(list); dlgClose(); act(() => api('POST', '/groups', { sessionIDs: ids })); });
  let dlgClose = () => {};
  openSheet('New Group', h('div', null, h('div', { class: 'small muted', text: 'Pick two or more agents with a live inbox.' }), list), (close) => ((dlgClose = close), [cancelBtn(close), create]));
}

function volunteerSheet() {
  const requester = h('input', { type: 'text', value: S.snap.volunteerRequesterName || '' });
  const title = h('input', { type: 'text', placeholder: 'review MR !1364' });
  const desc = h('textarea', { placeholder: 'Sent only to the volunteer you pick' });
  const go = h('button', { class: 'btn primary', text: 'Ask for Volunteers', disabled: true });
  const sync = () => (go.disabled = !(requester.value.trim() && title.value.trim() && desc.value.trim()));
  for (const el of [requester, title, desc]) el.addEventListener('input', sync);
  let dlgClose = () => {};
  go.addEventListener('click', () => { const body = { requester: requester.value.trim(), title: title.value.trim(), description: desc.value.trim() }; dlgClose(); act(() => api('POST', '/volunteer', body)); });
  openSheet(
    'Find a volunteer',
    h('div', null, h('div', { class: 'small muted', text: 'Every agent gets the title and is asked to volunteer if it has context. Only the one you pick gets the description.' }), field('Your name', requester), field('Task', title), field('Description', desc)),
    (close) => ((dlgClose = close), [cancelBtn(close), go])
  );
}

const field = (label, input) => h('div', { class: 'field' }, h('label', { text: label }), input);

async function spawnSheet(v) {
  let defaults = { name: v.title.slice(0, 60), model: S.snap.settings.planningModel, directories: [] };
  try {
    defaults = await api('GET', `/spawn-defaults?title=${enc(v.title)}`);
  } catch {
    /* fall back to the plain defaults */
  }
  const name = h('input', { type: 'text', value: defaults.name });
  const presets = S.snap.settings.modelPresets;
  const model = h('select', null, !presets.some((p) => p.id === defaults.model) ? h('option', { value: defaults.model, text: defaults.model, selected: true }) : null, presets.map((p) => h('option', { value: p.id, text: p.label, selected: p.id === defaults.model })));
  const dirs = h('datalist', { id: 'dirs' }, defaults.directories.map((d) => h('option', { value: d })));
  const cwd = h('input', { type: 'text', class: 'mono', list: 'dirs', value: defaults.directories[0] || '' });
  const go = h('button', { class: 'btn primary', text: 'Start', disabled: !(name.value.trim() && cwd.value.trim()) });
  const sync = () => (go.disabled = !(name.value.trim() && cwd.value.trim()));
  name.addEventListener('input', sync);
  cwd.addEventListener('input', sync);
  let dlgClose = () => {};
  go.addEventListener('click', () => { const body = { name: name.value.trim(), model: model.value, cwd: cwd.value.trim() }; dlgClose(); act(async () => { await api('POST', `/volunteer/${enc(v.id)}/spawn`, body); toast(`Started ${body.name}. It shows up in the list in a few seconds.`); }); });
  openSheet('Start a new agent', h('div', null, field('Name', name), field('Model', model), field('Directory', cwd), dirs), (close) => ((dlgClose = close), [cancelBtn(close), go]));
}

function renameSheet(a) {
  const input = h('input', { type: 'text', value: a.name });
  let dlgClose = () => {};
  const save = h('button', { class: 'btn primary', text: 'Save', onclick: () => { const name = input.value; dlgClose(); act(() => api('POST', `/agents/${enc(a.sessionID)}/rename`, { name })); } });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && save.click());
  openSheet('Rename session', h('div', null, h('div', { class: 'small muted', text: 'Empty goes back to the name Claude Code gave it.' }), field('Name', input)), (close) => ((dlgClose = close), [cancelBtn(close), save]));
}

function confirmSheet({ title, intro, reasons, confirmLabel }) {
  return new Promise((resolve) => {
    let answer = false;
    const dlg = openSheet(title, h('div', null, h('div', { text: intro }), h('ul', null, (reasons || []).map((r) => h('li', { text: r })))), (close) => [
      cancelBtn(close),
      h('button', { class: 'btn primary', text: confirmLabel, onclick: () => ((answer = true), close()) }),
    ]);
    dlg.addEventListener('close', () => resolve(answer));
  });
}

function infoSheet(title, lines) {
  openSheet(title, h('div', { class: 'pre mono small' }, lines.map((l) => h('div', { text: l || ' ' }))), (close) => [h('button', { class: 'btn primary', text: 'OK', onclick: close })]);
}

function signOffSheet(records, ctx) {
  const recs = records.map((r) => {
    const sent = h('span', { class: 'small muted' });
    const review = (looksRight) => act(async () => { await api('POST', `/agents/${enc(ctx.agentId)}/tbuv-review`, { id: r.id, looksRight, ...(ctx.groupKey ? { groupKey: ctx.groupKey } : {}) }); sent.textContent = 'Sent.'; });
    return h(
      'div',
      { class: 'rec', 'data-record': r.id },
      h('div', null, h('span', { class: 'badge ' + (r.kind === 'tombstone' ? 'red' : r.kind === 'unverified' ? 'amber' : 'grey'), text: r.id }), r.date ? h('span', { class: 'micro muted', text: ` ${r.date}` }) : null),
      r.kind === 'not-found' ? h('div', { class: 'small muted', text: "not found in this repo's ledgers" }) : h('div', { class: 'small', text: r.claim || '' }),
      r.supersededBy ? h('div', { class: 'small muted', text: `Superseded by: ${r.supersededBy}` }) : null,
      r.doubt ? h('div', { class: 'small muted', text: `Doubt: ${r.doubt}` }) : null,
      h('div', { class: 'recbtns' }, h('button', { class: 'btn small', text: 'Looks right', onclick: () => review(true) }), h('button', { class: 'btn small', text: 'Needs follow-up', onclick: () => review(false) }), sent)
    );
  });
  openSheet('TB/UV sign-off', h('div', null, h('div', { class: 'small muted', text: 'Your answer is relayed to the agent. The panel never writes the ledger files.' }), recs.length ? recs : h('div', { class: 'muted', text: 'The agent reported no TB/UV ids.' })), (close) => [h('button', { class: 'btn primary', text: 'Done', onclick: close })]);
}

// ---- keyboard, live updates, start ----------------------------------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || !S.right || S.right.kind !== 'group' || !S.right.data.isReviewing) return;
  const g = S.right.data;
  const idx = g.entries.findIndex((x) => x.sessionID === g.selection);
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    const next = g.entries[idx + (e.key === 'ArrowUp' ? -1 : 1)];
    if (next) act(() => api('POST', `/groups/${enc(g.key)}/review`, { selection: next.sessionID }));
  } else if (e.shiftKey && e.key === 'Enter' && document.activeElement && !document.activeElement.dataset.draft) {
    e.preventDefault();
    const cur = g.entries[idx];
    if (cur && cur.latestReplyID && !cur.isReviewed) act(() => api('POST', `/groups/${enc(g.key)}/review/${enc(cur.sessionID)}/mark-reviewed`));
  }
});

let timer = null;
const schedule = () => {
  clearTimeout(timer);
  timer = setTimeout(load, 120);
};
try {
  const es = new EventSource('/events');
  for (const type of ['roster', 'selection', 'conversation', 'group', 'volunteer', 'toast', 'claim', 'canary']) es.addEventListener(type, schedule);
} catch {
  /* polling below still works */
}
setInterval(load, 3000);
load();
