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
  scroll: new Map(), // scroller key -> { top, atBottom }
  lastSig: '',
  offline: false,
  // The standup's own UI state. It is not in the snapshot, so a change here calls redraw() to repaint.
  ui: {
    lane: null, // the open lane; null until chosen (then: lightning while a round runs, else triage)
    picked: null, // the picked board item's id
    picks: new Map(), // lightning item key -> { letter, stamp }: the option picked on its card
    votesOpen: new Set(), // lightning item keys whose Votes row is expanded
    busy: new Set(), // keys of actions in flight, so their buttons can be disabled
  },
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

/** Repaint now, even though the snapshot did not change (UI state moved). */
function redraw() {
  S.lastSig = '';
  render();
}

/** `act`, but one at a time per key; the key is in S.ui.busy meanwhile so the button that started it can show it. */
async function guarded(key, fn) {
  if (S.ui.busy.has(key)) return undefined;
  S.ui.busy.add(key);
  redraw();
  try {
    return await act(fn);
  } finally {
    S.ui.busy.delete(key);
    redraw();
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
    if (sel.kind === 'standup') {
      const [standup, lightning] = await Promise.all([api('GET', '/standup'), api('GET', '/lightning')]);
      return { kind: 'standup', key: 'standup', data: { standup, lightning } };
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
  for (const el of document.querySelectorAll('[data-scroll]')) {
    S.scroll.set(el.dataset.scroll, { top: el.scrollTop, atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 48 });
  }
  const leftTop = $('#left').scrollTop;

  // replaceChildren turns a null argument into the text "null", so empty slots are dropped here, in one place.
  const mount = (el, nodes) => el.replaceChildren(...nodes.filter(Boolean));
  const standup = S.right && S.right.kind === 'standup';
  $('main').classList.toggle('standup', !!standup);
  $('#left').setAttribute('aria-label', standup ? 'Standup' : 'Agents');
  mount($('#header'), renderHeader());
  mount($('#standup-bar'), standup ? renderStandupBar(S.right.data) : []);
  mount($('#left'), renderLeft());
  mount($('#right'), renderRight());

  $('#left').scrollTop = leftTop;
  for (const el of document.querySelectorAll('[data-scroll]')) {
    const prev = S.scroll.get(el.dataset.scroll);
    // A transcript follows its bottom; the standup's board and cards (data-top) start at the top.
    const top = el.dataset.top !== undefined;
    el.scrollTop = prev && (top || !prev.atBottom) ? prev.top : top ? 0 : el.scrollHeight;
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
      btn('Morning Standup', () => guarded('standup', () => api('POST', '/standup')), S.ui.busy.has('standup'), 'Build the standup from local git, the ledgers and the sessions. Nothing is sent to an agent'),
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
  if (S.right && S.right.kind === 'standup') return [renderStandupNav(S.right.data)];
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
  if (r.kind === 'standup') return renderStandupRight(r.data);
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

// ---- morning standup and lightning round ----------------------------------------------------------------------------------------

const LANES = [
  ['triage', 'Triage'],
  ['agents', 'Agents'],
  ['lightning', 'Lightning'],
];
const VERBS = { confirm: 'Confirm', deny: 'Deny', challenge: 'Challenge', no_change: 'No change' };
const VOTE_TINT = { concur: 'green', concern: 'amber', refuted: 'red' };
const BOARD_TINTS = new Set(['blue', 'grey', 'amber', 'red', 'green']);
const boardTint = (t) => (BOARD_TINTS.has(t) ? t : 'grey');
const isOpenPhase = (phase) => phase === 'presented' || phase === 'fallback';
const isSettled = (phase) => phase === 'decided' || phase === 'deferred';
const verbOf = (verb) => VERBS[verb] || verb;
const sentence = (s) => (s || '').replace(/_/g, ' ');

/** 'A', 'A or B', 'A, B or C'. */
const orList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);

const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const laneOf = (d) => S.ui.lane || (d.lightning.active ? 'lightning' : 'triage');
const roundStarted = (round) => round.active || round.items.length > 0;

/**
 * What the Lightning lane's right pane shows. A board row that is not in the round shows its own fields (the round cannot say anything
 * about it); otherwise, with a round, the card follows the round's current item.
 */
function lightningFocus(d) {
  const { standup, lightning: round } = d;
  const picked = standup.board.find((i) => i.lane === 'lightning' && i.id === S.ui.picked);
  if (picked && !round.items.some((i) => i.key === picked.rowKey)) return { kind: 'row', board: picked };
  if (roundStarted(round)) return { kind: 'card', item: round.items.find((i) => i.key === round.current) || null };
  return { kind: 'none' };
}

function setLane(lane) {
  S.ui.lane = lane;
  S.ui.picked = null;
  redraw();
}

/** A board row was clicked. In a round, a Lightning row becomes the current card (which asks an agent to present it if it has not been). */
function pickBoard(item, round) {
  S.ui.picked = item.id;
  redraw();
  if (item.lane === 'lightning' && round.items.some((i) => i.key === item.rowKey)) act(() => api('POST', '/lightning/select', { key: item.rowKey }));
}

const startLightning = (d, keys) =>
  guarded('start', async () => {
    S.ui.lane = 'lightning';
    S.ui.picked = null;
    await api('POST', '/lightning/start', { keys: keys || d.standup.board.filter((i) => i.lane === 'lightning').map((i) => i.rowKey) });
  });

// ---- the standup band and the navigator ----

function renderStandupBar({ standup: s, lightning: round }) {
  const covering = s.through === s.covering ? s.covering : `${s.covering} - ${s.through}`;
  const source = (c) => h('span', { class: 'pill green src', title: c.note }, `${c.label} ${c.count}`, c.note ? h('span', { class: 'mark', text: '!', role: 'img', 'aria-label': `Note: ${c.note}` }) : null);
  return [
    h(
      'div',
      { class: 'sb-main' },
      h('div', { class: 'sb-title' }, h('h2', { text: 'Morning Standup' }), h('span', { class: 'sb-sub', text: `covering ${covering}, run ${s.run}` })),
      h('div', { class: 'srcs' }, s.sources.map(source))
    ),
    h(
      'div',
      { class: 'sb-actions' },
      round.active ? h('button', { class: 'btn small', text: 'Abort', title: 'Stop the Lightning round. Decisions already made are kept', onclick: () => act(() => api('POST', '/lightning/abort')) }) : null,
      h('button', { class: 'btn small', text: 'Back to agents', onclick: () => act(() => api('POST', '/selection/clear')) })
    ),
  ];
}

function renderStandupNav(d) {
  const { standup: s, lightning: round } = d;
  const lane = laneOf(d);
  const items = s.board.filter((i) => i.lane === lane);
  const phases = new Map(round.items.map((i) => [i.key, i.phase]));
  let shown = S.ui.picked;
  if (lane === 'lightning') {
    const focus = lightningFocus(d);
    shown = focus.kind === 'row' ? focus.board.id : focus.kind === 'card' && focus.item ? focus.item.key : null;
  }
  const c = round.counts;
  const lanes = h(
    'div',
    { class: 'lanes', role: 'radiogroup', 'aria-label': 'Lane' },
    LANES.map(([id, label]) =>
      h('button', { class: 'lane' + (id === lane ? ' on' : ''), role: 'radio', 'aria-checked': id === lane ? 'true' : 'false', onclick: () => setLane(id) }, h('span', { class: 'radio' }), h('span', { class: 'nm', text: label }), h('span', { class: 'count', text: String(s.lanes[id]) }))
    )
  );
  const start =
    lane === 'lightning'
      ? h(
          'div',
          { class: 'lstart' },
          h('button', { class: 'btn primary', text: 'Start Lightning', disabled: items.length === 0 || S.ui.busy.has('start'), title: 'Settle this lane one card at a time. Asks an agent in each row’s repo to present it. A round that is running is replaced', onclick: () => startLightning(d) }),
          roundStarted(round) ? h('span', { class: 'muted small', text: `${c.remaining} of ${c.total} left${c.decided ? `, ${c.decided} decided` : ''}${c.deferred ? `, ${c.deferred} deferred` : ''}${round.active ? '' : ', stopped'}` }) : null
        )
      : null;
  const row = (item) =>
    h(
      'button',
      { class: 'board-row' + (item.id === shown ? ' on' : '') + (isSettled(phases.get(item.rowKey)) ? ' done' : ''), 'data-board': item.id, 'aria-pressed': item.id === shown ? 'true' : 'false', title: `${item.title}${item.repo ? ` (${item.repo})` : ''}`, onclick: () => pickBoard(item, round) },
      h('span', { class: 'tdot ' + boardTint(item.tint), 'aria-hidden': 'true' }),
      h('span', { class: 't' }, item.title, item.repo && lane !== 'lightning' ? h('span', { class: 'repo', text: ` (${item.repo})` }) : null)
    );
  return h('div', { class: 'nav' }, lanes, start, h('div', { class: 'board-head', text: 'Board' }), h('div', { class: 'board', 'data-scroll': `board:${lane}`, 'data-top': '' }, items.length ? items.map(row) : h('div', { class: 'muted small', text: 'Nothing in this lane.' })));
}

// ---- the right pane ----

const ASK_PICK = {
  triage: ['Pick a branch', 'Its ticket keys and the sessions working on it show here.'],
  agents: ['Pick a session', 'Its last status shows here, with a button to open its thread.'],
  lightning: ['Settle the open ledger rows', 'Start Lightning to go through this lane one card at a time, or pick a row to look at it.'],
};

function renderStandupRight(d) {
  const lane = laneOf(d);
  if (lane === 'lightning') {
    const focus = lightningFocus(d);
    if (focus.kind === 'card') return [cardView(d.lightning, focus.item)];
    if (focus.kind === 'row') return [detailView(focus.board, d)];
  } else {
    const picked = d.standup.board.find((i) => i.lane === lane && i.id === S.ui.picked);
    if (picked) return [detailView(picked, d)];
  }
  return [h('div', { class: 'pane-empty' }, h('div', { class: 'big', text: ASK_PICK[lane][0] }), h('div', { text: ASK_PICK[lane][1] }))];
}

/** A list of label/value rows; an empty value leaves its row out. */
function fieldList(rows) {
  const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0));
  return h('dl', { class: 'fields' }, shown.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', null, v)]));
}

const roundLog = (round) => (round.log.length ? h('div', { class: 'rlog', role: 'log', 'aria-label': 'Round log' }, round.log.map((line) => h('div', { text: line }))) : null);

/** A board item that has no card: a branch, a session, or a ledger row that is not in the round. */
function detailView(item, d) {
  const round = d.lightning;
  const roster = S.snap.roster.agents;
  const sessionID = item.lane === 'agents' ? item.id.slice('session:'.length) : null;
  const agent = sessionID ? roster.find((a) => a.sessionID === sessionID) : null;
  const openThread = (id) => act(() => api('POST', `/agents/${enc(id)}/select`));
  const joined = (item.sessionIDs || []).map((id) => {
    const a = roster.find((x) => x.sessionID === id);
    return a ? h('button', { class: 'link', text: a.name, title: `Open the thread with ${a.name}`, onclick: () => openThread(id) }) : h('span', { class: 'mono small', text: id.slice(0, 8) });
  });
  const rows = {
    triage: [['Repo', item.repo], ['Detail', item.detail], ['Ticket keys', item.refs.length ? item.refs.join(', ') : null], ['Last commit', item.at ? ago(item.at) : null], ['Sessions', joined.length ? h('span', { class: 'links' }, joined) : 'None on this branch'], ['From', item.sources.join(', ')]],
    agents: [['Repo', item.repo], ['Last scope', item.detail], ['Ticket keys', item.refs.length ? item.refs.join(', ') : null], ['Last activity', item.at ? ago(item.at) : null], ['Directory', agent && h('span', { class: 'mono', text: agent.cwd })], ['Session', sessionID && h('span', { class: 'mono', text: sessionID.slice(0, 8), title: sessionID })]],
    lightning: [['Repo', item.repo], ['Doubt', item.detail], ['Opened', item.at ? localDay(item.at) : null], ['Key', h('span', { class: 'mono', text: item.id })]],
  }[item.lane];
  const actions =
    item.lane === 'agents'
      ? h('button', { class: 'btn primary', text: 'Open thread', disabled: !agent, title: agent ? 'Back to the normal view with this session selected' : 'This session is not in the roster', onclick: () => openThread(sessionID) })
      : item.lane === 'lightning'
        ? h('button', { class: 'btn', text: 'Present this one', disabled: S.ui.busy.has('start'), title: 'Start a round with just this row. A round that is running is replaced', onclick: () => startLightning(d, [item.rowKey]) })
        : null;
  return h(
    'div',
    { class: 'cardview', 'data-scroll': `item:${item.id}`, 'data-top': '' },
    h(
      'div',
      { class: 'lcard' },
      h('div', { class: 'tags' }, h('span', { class: 'badge ' + boardTint(item.tint), text: sentence(item.state) })),
      h('div', { class: 'ltitle', text: item.title }),
      fieldList(rows),
      actions
    ),
    roundStarted(round) ? roundLog(round) : null
  );
}

const pickStamp = (p) => `${p.source}:${p.presentedBy}`;

/** The letter picked on this card, if it is still one of the options of the presentation that is on screen. */
function pickedLetter(item) {
  const rec = S.ui.picks.get(item.key);
  const p = item.presentation;
  return rec && p && rec.stamp === pickStamp(p) && p.options.some((o) => o.letter === rec.letter) ? rec.letter : null;
}

function choose(item, letter) {
  S.ui.picks.set(item.key, { letter, stamp: pickStamp(item.presentation) });
  redraw();
}

/** The card for the round's current item; null means the queue is empty. */
function cardView(round, item) {
  const c = round.counts;
  const body = item
    ? lightningCard(round, item)
    : h('div', { class: 'lcard' }, h('div', { class: 'ltitle', text: 'Nothing left to settle.' }), h('div', { class: 'muted small', text: `${c.decided} decided, ${c.deferred} deferred.` }));
  return h('div', { class: 'cardview', 'data-scroll': `card:${item ? item.key : ''}`, 'data-top': '' }, body, roundLog(round));
}

function tagPills(p) {
  const tag = (text, tint) => h('span', { class: 'pill' + (tint ? ` ${tint}` : ''), text });
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return [p.needs ? tag(`Needs${cap(p.needs)}`, p.needs === 'human' ? 'amber' : '') : null, p.nature ? tag(p.nature) : null, p.checkable ? tag(`checkable ${p.checkable}`, p.checkable === 'now' ? 'green' : '') : null];
}

/** `path:lines`, and `@sha` when the agent pinned one: the cite without its quote. */
const citeText = (c) => `${c.path}:${c.startLine === c.endLine ? c.startLine : `${c.startLine}-${c.endLine}`}${c.sha ? `@${c.sha}` : ''}`;

function evidenceRow(e) {
  const g = e.grounding;
  const grounded = g.status === 'grounded';
  return h(
    'li',
    { class: 'ev', 'data-evidence': String(e.n) },
    h('span', { class: 'n muted', text: String(e.n) }),
    h('span', { class: 'pill ' + (grounded ? 'green' : 'red'), text: grounded ? `grounded${g.sha ? ` @${g.sha}` : ''}` : 'UNGROUNDED', title: grounded ? null : g.reason }),
    h('span', { class: 'cite mono', text: e.cite ? citeText(e.cite) : e.raw }),
    e.cite && e.cite.quote ? h('span', { class: 'quote muted', text: `“${e.cite.quote}”` }) : null
  );
}

function optionRow(item, o, picked, enabled) {
  const grounded = o.grounding === 'grounded';
  const chosen = picked === o.letter || (item.decision && item.decision.option === o.letter);
  return h(
    'li',
    { class: 'opt' + (chosen ? ' on' : '') + (enabled ? ' live' : ''), 'data-option': o.letter, onclick: enabled ? () => choose(item, o.letter) : null },
    h('button', { class: 'letter', text: o.letter, disabled: !enabled, 'aria-pressed': picked === o.letter ? 'true' : 'false', 'aria-label': `Option ${o.letter}: ${verbOf(o.verb)}, ${o.title}` }),
    h(
      'div',
      { class: 'obody' },
      h('div', { class: 'ohead', text: `${verbOf(o.verb)}: ${o.title}` }),
      h(
        'div',
        { class: 'owhy' },
        h('span', { class: 'pill ' + (grounded ? 'green' : 'red'), text: grounded ? 'grounded' : 'UNGROUNDED', title: grounded ? `Cites ${o.cites.join(', ')}` : o.cites.length ? 'None of the cites this option references is grounded' : 'This option cites no evidence of its own' }),
        ' ',
        o.why,
        o.cites.length ? h('span', { class: 'muted', text: ` (cites ${o.cites.join(', ')})` }) : null
      )
    )
  );
}

/** The collapsible Votes row. Its open state is S.ui.votesOpen, so a repaint keeps it. */
function votesRow(round, item, open) {
  const v = item.votes;
  const t = v.tally;
  const busy = S.ui.busy.has(`skeptics:${item.key}`);
  const entry = (e) =>
    h(
      'li',
      { class: 'vote', 'data-vote': e.sessionID },
      h('span', { class: 'vname', text: e.name }),
      h('span', { class: 'pill ' + (VOTE_TINT[e.vote] || ''), text: e.vote || 'silent' }),
      e.vote ? h('span', { class: 'muted small', text: e.prefers ? `prefers ${e.prefers}` : 'no preference' }) : null,
      e.reason ? h('span', { class: 'vreason', text: e.reason }) : null
    );
  return h(
    'div',
    { class: 'votes' },
    h(
      'details',
      { open: S.ui.votesOpen.has(item.key), ontoggle: (e) => (e.target.open ? S.ui.votesOpen.add(item.key) : S.ui.votesOpen.delete(item.key)) },
      h('summary', { text: v.asked ? `Votes: ${t.concur} concur, ${t.concern} concern, ${t.refuted} refuted, ${t.silent} silent` : 'Votes: not asked' }),
      v.asked ? h('ul', { class: 'vlist' }, v.entries.map(entry)) : h('div', { class: 'muted small', text: `Nobody has been asked. Ask skeptics sends this card to up to ${round.panelSize} other agents and asks them to vote.` })
    ),
    !v.asked && open ? h('button', { class: 'btn small', text: 'Ask skeptics', disabled: busy, title: `Send this card to up to ${round.panelSize} other agents and ask them to vote`, onclick: () => guarded(`skeptics:${item.key}`, () => api('POST', '/lightning/skeptics', { key: item.key })) }) : null
  );
}

/** The next card still to settle after this one, in queue order, wrapping round. */
function nextLiveKey(round, item) {
  const at = round.items.findIndex((i) => i.key === item.key);
  for (let k = 1; k < round.items.length; k++) {
    const other = round.items[(at + k) % round.items.length];
    if (!isSettled(other.phase)) return other.key;
  }
  return null;
}

/** Approve one option. A relay that failed is not a thrown error: the engine logged why, and that line is the toast. */
function approve(item, letter) {
  const p = item.presentation;
  const option = p.options.find((o) => o.letter === letter);
  const before = S.right.data.lightning.log;
  return guarded(item.key, async () => {
    const r = await api('POST', '/lightning/approve', { key: item.key, option: letter });
    if (!r.decided) {
      const last = r.view.log[r.view.log.length - 1];
      toast(last && last !== before[before.length - 1] ? last : 'The decision was not recorded.', 'err');
    } else if (r.delivered) toast(`Sent option ${letter} (${verbOf(option.verb)}) to ${p.source === 'agent' ? p.presentedBy : `an agent in ${item.repo}`}.`);
  });
}

function lightningCard(round, item) {
  const p = item.presentation;
  const open = isOpenPhase(item.phase);
  const busy = S.ui.busy.has(item.key);
  const picked = pickedLetter(item);
  const post = (path) => () => guarded(item.key, () => api('POST', path, { key: item.key }));
  const head = [h('div', { class: 'tags' }, p ? tagPills(p) : null), h('div', { class: 'ltitle', text: item.title, title: item.title }), h('div', { class: 'lsummary', text: item.summary, title: item.summary })];
  const deferBtn = h('button', { class: 'btn', text: 'Defer', disabled: busy, title: 'Hide this row until tomorrow', onclick: post('/lightning/defer') });
  const next = nextLiveKey(round, item);
  const nextBtn = next ? h('button', { class: 'btn', text: 'Next', title: 'Go to the next card still to settle', onclick: () => act(() => api('POST', '/lightning/select', { key: next })) }) : null;

  if (!p) {
    const live = round.active && !isSettled(item.phase);
    const waiting = item.phase === 'deferred' ? 'Deferred until tomorrow.' : !round.active ? 'This round was stopped before the card was presented.' : item.phase === 'presenting' ? `Asking an agent in ${item.repo}…` : 'Waiting for its turn…';
    const row = item.row;
    const rowFields = fieldList([['Opened', row.date], ['Raised by', row.raisedBy], ['Status', row.status], ['Claim', row.claim], ['Doubt', row.doubt], ['Settles it', row.settlesIt], ['Superseded by', row.supersededBy]]);
    return h('div', { class: 'lcard', 'data-phase': item.phase }, head, h('div', { class: 'lhint' }, live ? h('span', { class: 'spin' }) : null, ' ', waiting), rowFields, isSettled(item.phase) ? h('div', { class: 'lactions' }, nextBtn) : live ? h('div', { class: 'lactions' }, deferBtn) : null);
  }

  const optionsLive = open && !busy;
  const chosen = picked && p.options.find((o) => o.letter === picked);
  const relay = (o) => (o.verb === 'no_change' ? `Approve records option ${o.letter} and sends nothing.` : `Approve sends option ${o.letter} (${verbOf(o.verb)}) to ${p.source === 'agent' ? p.presentedBy : `an agent in ${item.repo}`}.`);
  let foot;
  if (item.phase === 'decided') foot = [h('div', { class: 'lhint strong', text: `Decided: option ${item.decision.option} (${verbOf(item.decision.verb)})` }), h('div', { class: 'lactions' }, nextBtn)];
  else if (item.phase === 'deferred') foot = [h('div', { class: 'lhint strong', text: 'Deferred until tomorrow.' }), h('div', { class: 'lactions' }, nextBtn)];
  else if (!open) foot = [h('div', { class: 'lactions' }, deferBtn)];
  else
    foot = [
      h('div', { class: 'lhint', text: chosen ? relay(chosen) : `Pick ${orList(p.options.map((o) => o.letter))} to approve.` }),
      h(
        'div',
        { class: 'lactions' },
        h('button', { class: 'btn primary', text: 'Approve', disabled: !picked || busy, title: picked ? 'Relay the picked option to the agent' : 'Pick an option first', onclick: () => approve(item, picked) }),
        h('button', { class: 'btn', text: 'Reject', disabled: busy, title: 'None of these: ask again later with a different presenter', onclick: post('/lightning/reject') }),
        deferBtn
      ),
    ];

  return h(
    'div',
    { class: 'lcard', 'data-phase': item.phase },
    head,
    h('div', { class: 'lby muted', text: p.source === 'ledger' ? (p.presentedBy ? `Presented by ${p.presentedBy} (from the ledger row)` : 'Presented from the ledger row') : `Presented by ${p.presentedBy}` }),
    p.claim ? h('div', { class: 'lclaim', text: p.claim }) : null,
    p.assessment ? h('div', { class: 'lassess', text: p.assessment }) : null,
    p.evidence.length ? h('ul', { class: 'evidence', 'aria-label': 'Evidence' }, p.evidence.map(evidenceRow)) : null,
    h('ul', { class: 'options', 'aria-label': 'Options' }, p.options.map((o) => optionRow(item, o, picked, optionsLive))),
    votesRow(round, item, open),
    foot
  );
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

/** The Lightning card that is on screen and open for a decision, or null. */
function openCard() {
  const d = S.right && S.right.kind === 'standup' ? S.right.data : null;
  if (!d || laneOf(d) !== 'lightning') return null;
  const focus = lightningFocus(d);
  return focus.kind === 'card' && focus.item && focus.item.presentation && isOpenPhase(focus.item.phase) ? focus.item : null;
}

// A-D pick an option and Enter approves it. A field, a button or a modifier key means the person is doing something else.
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat || e.defaultPrevented) return;
  const focus = document.activeElement;
  if (focus && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SUMMARY'].includes(focus.tagName)) return;
  if (document.querySelector('dialog[open]')) return;
  const item = openCard();
  if (!item) return;
  const letter = (e.key || '').length === 1 ? e.key.toUpperCase() : '';
  if (item.presentation.options.some((o) => o.letter === letter)) {
    e.preventDefault();
    if (!S.ui.busy.has(item.key)) choose(item, letter);
  } else if (e.key === 'Enter') {
    const picked = pickedLetter(item);
    if (picked && !S.ui.busy.has(item.key)) {
      e.preventDefault();
      approve(item, picked);
    }
  }
});

let timer = null;
const schedule = () => {
  clearTimeout(timer);
  timer = setTimeout(load, 120);
};
try {
  const es = new EventSource('/events');
  for (const type of ['roster', 'selection', 'conversation', 'group', 'volunteer', 'toast', 'claim', 'canary', 'standup', 'lightning']) es.addEventListener(type, schedule);
} catch {
  /* polling below still works */
}
setInterval(load, 3000);
load();
