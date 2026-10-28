import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { request } from 'node:http';
import { Hub } from '../src/hub.js';
import { serve, PANEL_CSP, type Daemon } from '../src/daemon.js';
import { demoHub } from '../src/demo.js';
import { MemoryKV } from '../src/store.js';

let d: Daemon | null = null;
afterEach(async () => {
  if (d) await d.close();
  d = null;
});

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'GET', path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function start(): Promise<number> {
  const hub = new Hub({ kv: new MemoryKV(), clock: () => 1, sleep: () => new Promise((r) => setTimeout(r, 5)), listAgents: async () => [], settings: { claudePath: process.execPath, claudeDir: '/claude' } });
  d = await serve(hub, { port: 0, pollMs: 60_000 });
  return Number(new URL(d.url).port);
}

describe('the panel is served by the daemon', () => {
  it('serves its three files with a strict CSP and no sniffing, caching or referrer leak', async () => {
    const port = await start();
    const html = await get(port, '/');
    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toMatch(/^text\/html/);
    expect(html.headers['content-security-policy']).toBe(PANEL_CSP);
    expect(html.headers['x-content-type-options']).toBe('nosniff');
    expect(html.headers['cache-control']).toBe('no-store');
    expect(html.body).toContain('<script src="/panel.js" defer></script>');
    expect((await get(port, '/panel.js')).headers['content-type']).toMatch(/javascript/);
    expect((await get(port, '/panel.css')).headers['content-type']).toMatch(/^text\/css/);
  });

  it('the CSP forbids inline script, foreign loads and framing', () => {
    expect(PANEL_CSP).toContain("default-src 'none'");
    expect(PANEL_CSP).toContain("script-src 'self'");
    expect(PANEL_CSP).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(PANEL_CSP).toContain("frame-ancestors 'none'");
    expect(readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8')).not.toMatch(/<script(?![^>]*\bsrc=)/); // no inline script block
    expect(readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8')).not.toMatch(/\sstyle=/); // no inline style attribute
  });

  it('serves nothing else from disk: no traversal, no other files', async () => {
    const port = await start();
    for (const path of ['/package.json', '/../package.json', '/panel/index.html', '/index.html', '/panel.js/../../package.json', '/%2e%2e/package.json', '/src/daemon.ts']) {
      const r = await get(port, path);
      expect([404, 403]).toContain(r.status);
      expect(r.body).not.toContain('"name": "agentim"');
    }
  });

  it('the guard applies to the panel too: a foreign Host or Origin gets no HTML', async () => {
    const port = await start();
    expect((await get(port, '/', { host: `attacker.example:${port}` })).status).toBe(403);
    expect((await get(port, '/panel.js', { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('is included in the published package, and the demo hub builds without touching the disk or a real claude', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.files).toContain('panel');
    for (const f of ['index.html', 'panel.css', 'panel.js']) expect(existsSync(new URL(`../panel/${f}`, import.meta.url))).toBe(true);
    expect(demoHub().settings.claudeDir).toBe('/demo/claude');
  });
});

describe('the panel script never lets agent text reach an HTML parser', () => {
  const full = readFileSync(new URL('../panel/panel.js', import.meta.url), 'utf8');
  // Code only: the header comment names innerHTML to say it is never used.
  const source = full.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  it('uses no HTML-parsing or code-evaluating API', () => {
    for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'createContextualFragment', 'eval(', 'new Function', 'setTimeout("', "setTimeout('", 'srcdoc']) expect(source).not.toContain(banned);
  });
  it('builds nodes with h() and sets text through textContent', () => {
    expect(source).toContain('el.textContent = v');
    expect(source).toContain('el.append(kid.nodeType ? kid : String(kid))');
  });
  it('sets no inline style: the CSP forbids the attribute, so every look comes from panel.css', () => {
    expect(source).not.toMatch(/setAttribute\(\s*['"`]style['"`]/); // the attribute by name
    expect(source).not.toMatch(/\bstyle\s*:/); // h(tag, { style: ... }) ends in setAttribute
    expect(source).not.toContain('.style.cssText');
  });
});

// ---- the standup and the Lightning card, run for real against a small fake DOM ---------------------------------------------------
// No browser in CI: panel.js is evaluated in a vm with just enough of `document` to build, find and click its nodes. The server is a table
// of canned answers, so what the page does with a card, a round or a 409 is the page's own code running.

const PANEL = new URL('../panel/', import.meta.url);
const panelSource = readFileSync(new URL('panel.js', PANEL), 'utf8');

class FakeEl {
  nodeType = 1;
  children: any[] = [];
  parent: FakeEl | null = null;
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  handlers: Record<string, Array<(e: any) => void>> = {};
  className = '';
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  disabled = false;
  open = false;
  focusVisible = false;
  intoView: unknown[] = [];
  constructor(readonly tagName: string, readonly doc: FakeDoc) {}
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c: string) => names().includes(c),
      toggle: (c: string, on?: boolean) => {
        const want = on ?? !names().includes(c);
        this.className = [...names().filter((x) => x !== c), ...(want ? [c] : [])].join(' ');
        return want;
      },
    };
  }
  get textContent(): string {
    return this.children.map((k) => (typeof k === 'string' ? k : k.textContent)).join('');
  }
  set textContent(v: string) {
    this.children = [String(v)];
  }
  get isConnected(): boolean {
    let el: FakeEl | null = this;
    while (el.parent) el = el.parent;
    return el === this.doc.root;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
    if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  append(...kids: any[]) {
    for (const k of kids) {
      if (typeof k !== 'string') {
        k.remove();
        k.parent = this;
      }
      this.children.push(k);
    }
  }
  replaceChildren(...kids: any[]) {
    for (const k of this.children) if (typeof k !== 'string') k.parent = null;
    this.children = [];
    this.append(...kids);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((k) => k !== this);
    this.parent = null;
  }
  addEventListener(type: string, fn: (e: any) => void) {
    (this.handlers[type] ||= []).push(fn);
  }
  descendants(): FakeEl[] {
    return this.children.flatMap((k) => (typeof k === 'string' ? [] : [k, ...k.descendants()]));
  }
  querySelectorAll(sel: string): FakeEl[] {
    return this.descendants().filter((el) => el.matches(sel));
  }
  querySelector(sel: string): FakeEl | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  /** A compound selector: `tag#id.class[attr]` or `[attr="value"]`, plus `:focus-visible`. */
  matches(sel: string): boolean {
    if (sel === ':focus-visible') return this.focusVisible;
    const m = /^([a-zA-Z][\w-]*)?((?:[#.][\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/.exec(sel);
    if (!m) throw new Error(`the fake DOM cannot match ${sel}`);
    if (m[1] && m[1].toUpperCase() !== this.tagName) return false;
    for (const part of m[2].match(/[#.][\w-]+|\[[^\]]+\]/g) ?? []) {
      if (part[0] === '#') {
        if (this.attrs.id !== part.slice(1)) return false;
      } else if (part[0] === '.') {
        if (!this.classList.contains(part.slice(1))) return false;
      } else {
        const [, name, value] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part)!;
        if (name === 'open' ? !this.open : this.attrs[name] === undefined || (value !== undefined && this.attrs[name] !== value)) return false;
      }
    }
    return true;
  }
  focus() {
    this.doc.active = this;
    this.focusVisible = this.doc.keyboard;
  }
  blur() {
    if (this.doc.active === this) this.doc.active = null;
  }
  scrollIntoView(o: unknown) {
    this.intoView.push(o);
  }
  setSelectionRange() {}
}

class FakeDoc {
  root = new FakeEl('HTML', this);
  body = new FakeEl('BODY', this);
  active: FakeEl | null = null;
  keyboard = false; // the next focus() is a keyboard focus (what :focus-visible tells a real browser apart)
  handlers: Record<string, Array<(e: any) => void>> = {};
  constructor() {
    this.root.append(this.body);
    for (const [tag, id] of [['header', 'header'], ['main', ''], ['div', 'toasts']] as const) {
      const el = this.createElement(tag);
      if (id) el.setAttribute('id', id);
      this.body.append(el);
    }
    for (const [tag, id] of [['div', 'standup-bar'], ['aside', 'left'], ['section', 'right']] as const) {
      const el = this.createElement(tag);
      el.setAttribute('id', id);
      this.querySelector('main')!.append(el);
    }
  }
  createElement(tag: string) {
    return new FakeEl(tag.toUpperCase(), this);
  }
  get activeElement(): FakeEl {
    return this.active && this.active.isConnected ? this.active : this.body;
  }
  addEventListener(type: string, fn: (e: any) => void) {
    (this.handlers[type] ||= []).push(fn);
  }
  querySelector(sel: string) {
    return this.root.querySelector(sel);
  }
  querySelectorAll(sel: string) {
    return this.root.querySelectorAll(sel);
  }
}

interface Call {
  method: string;
  path: string;
  body: any;
}

/** Fixtures in the shapes GET /standup and GET /lightning answer with. */
const rowOf = (id: string) => ({ key: `uv:shop:${id}`, id, kind: 'unverified', repo: 'shop', repoPath: '/w/shop', status: 'open', open: true, claim: `claim ${id}`, doubt: 'unsure' });
const optionOf = (letter: string, verb: string, title: string, grounding = 'grounded', cites: number[] = [1]) => ({ letter, verb, title, cites, why: `why ${letter}`, grounding });
const presentationOf = (over: any = {}) => ({
  source: 'agent',
  presentedBy: 'worker',
  needs: 'human',
  nature: 'decision',
  checkable: 'now',
  title: 'T',
  claim: 'The claim.',
  assessment: 'The assessment.',
  evidence: [
    { n: 1, raw: 'src/a.ts:1@abc1234', cite: { path: 'src/a.ts', startLine: 1, endLine: 1, sha: 'abc1234' }, grounding: { status: 'grounded', sha: 'abc1234' } },
    { n: 2, raw: 'src/b.ts:8@abc1234', cite: { path: 'src/b.ts', startLine: 8, endLine: 8, sha: 'abc1234' }, grounding: { status: 'ungrounded', reason: 'src/b.ts is not in abc1234' } },
  ],
  options: [optionOf('A', 'confirm', 'Confirm the claim'), optionOf('B', 'deny', 'Deny the claim', 'ungrounded', [2]), optionOf('C', 'no_change', 'Leave it', 'ungrounded', [])],
  ...over,
});
const none = { concur: 0, concern: 0, refuted: 0, silent: 0, asked: 0 };
const cardOf = (id: string, over: any = {}) => {
  const row = rowOf(id);
  return { key: row.key, id, kind: row.kind, repo: 'shop', title: `${id} claim ${id}`, summary: 'shop. Doubt: unsure', row, phase: 'presented', presentation: presentationOf(), rev: 1, votes: { asked: false, tally: { ...none }, entries: [] }, decision: null, ...over };
};
const roundOf = (items: any[], over: any = {}) => {
  const decided = items.filter((i) => i.phase === 'decided').length;
  const deferred = items.filter((i) => i.phase === 'deferred').length;
  return { active: true, current: items[0]?.key ?? null, panelSize: 4, items, counts: { total: items.length, remaining: items.length - decided - deferred, decided, deferred }, log: [], ...over };
};
const standupOf = (ids: string[], over: any = {}) => ({
  at: 1,
  covering: '2026-10-26',
  through: '2026-10-26',
  run: '2026-10-27',
  windowStart: 0,
  windowEnd: 1,
  sources: [{ id: 'git', label: 'Local git', count: 3 }, { id: 'ledger', label: 'Ledger', count: ids.length }],
  lanes: { triage: 0, agents: 0, lightning: ids.length },
  board: ids.map((id) => ({ id: `uv:shop:${id}`, lane: 'lightning', title: `${id} claim ${id}`, repo: 'shop', state: 'open', tint: 'green', refs: [], sources: ['ledger'], rowKey: `uv:shop:${id}`, detail: 'unsure' })),
  ...over,
});

interface Server {
  standup: any;
  lightning: any;
  on: Record<string, (body: any) => { status?: number; json?: any } | void>;
}

async function settle() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

/** panel.js, loaded into a fresh fake page whose server is `server`. */
async function openPanel(server: Server) {
  const doc = new FakeDoc();
  const calls: Call[] = [];
  const snap = { selection: { kind: 'standup' }, roster: { agents: [], liveCount: 0, hasLoaded: true, isRefreshing: false, lastError: null }, resumeSet: null, flags: { isPausing: false, isResuming: false, donePending: [] }, volunteers: [], groups: [], archived: [], toasts: [], settings: { modelPresets: [] }, volunteerRequesterName: '' };
  const fetchFake = async (path: string, init: { method: string; body?: string }) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ method: init.method, path, body });
    const custom = server.on[`${init.method} ${path}`]?.(body);
    const table: Record<string, unknown> = { 'GET /state': snap, 'GET /standup': server.standup, 'GET /lightning': server.lightning };
    const status = custom?.status ?? 200;
    const json = custom && 'json' in custom ? custom.json : (table[`${init.method} ${path}`] ?? { ok: true });
    return { ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(json)) };
  };
  const ctx = vm.createContext({ document: doc, fetch: fetchFake, navigator: {}, setTimeout: () => 0, clearTimeout: () => undefined, setInterval: () => 0, queueMicrotask, CSS: { escape: (s: string) => s }, console });
  vm.runInContext(panelSource, ctx);
  const page = {
    doc,
    calls,
    S: vm.runInContext('S', ctx) as any,
    right: doc.querySelector('#right')!,
    left: doc.querySelector('#left')!,
    bar: doc.querySelector('#standup-bar')!,
    toasts: doc.querySelector('#toasts')!,
    /** The buttons in `root` whose text is exactly `text`. */
    buttons: (text: string, root: FakeEl = doc.body) => root.querySelectorAll('button').filter((b) => b.textContent === text),
    button: (text: string, root: FakeEl = doc.body) => page.buttons(text, root)[0]!,
    reload: async () => {
      await vm.runInContext('load()', ctx);
      await settle();
    },
    fire(target: FakeEl | FakeDoc, type: string, init: any = {}) {
      const ev = { type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, ...init };
      if (target instanceof FakeEl) for (let el: FakeEl | null = target; el; el = el.parent) for (const fn of el.handlers[type] ?? []) fn(Object.assign(ev, { currentTarget: el }));
      if (type !== 'toggle') for (const fn of doc.handlers[type] ?? []) fn(ev);
      return ev;
    },
    async click(el: FakeEl) {
      if (el.disabled) return;
      page.fire(el, 'click');
      await settle();
    },
    async press(key: string, init: any = {}) {
      const ev = page.fire(doc, 'keydown', { key, ...init });
      await settle();
      return ev;
    },
  };
  await page.reload();
  return page;
}

const approvals = (page: { calls: Call[] }) => page.calls.filter((c) => c.path === '/lightning/approve');
const optionOn = (page: { right: FakeEl }) => page.right.querySelector('li.opt.on')?.dataset.option ?? null;
const hasText = (el: FakeEl, text: string) => el.textContent.includes(text);

describe('a stopped round', () => {
  it('does not offer Ask skeptics, Reject or Defer, and says why; Approve still works', async () => {
    const server: Server = { standup: standupOf(['UV-1']), lightning: roundOf([cardOf('UV-1')], { active: false }), on: {} };
    const page = await openPanel(server);
    for (const label of ['Ask skeptics', 'Reject', 'Defer']) expect(page.buttons(label, page.right), label).toHaveLength(0);
    expect(hasText(page.right, 'This round was stopped')).toBe(true);
    await page.click(page.button('B', page.right));
    const approve = page.button('Approve', page.right);
    expect(approve.disabled).toBe(false);
    await page.click(approve);
    expect(approvals(page)).toHaveLength(1);
  });

  it('while the round runs all of them are there', async () => {
    const page = await openPanel({ standup: standupOf(['UV-1']), lightning: roundOf([cardOf('UV-1')]), on: {} });
    for (const label of ['Ask skeptics', 'Reject', 'Defer']) expect(page.buttons(label, page.right), label).toHaveLength(1);
    expect(hasText(page.right, 'round was stopped')).toBe(false);
  });

  it('keeps the person on the lane and the card they were on after Abort, also one issued elsewhere', async () => {
    const server: Server = { standup: standupOf(['UV-1', 'UV-2']), lightning: roundOf([cardOf('UV-1'), cardOf('UV-2')], { log: ['Asked an agent.'] }), on: {} };
    server.on['POST /lightning/abort'] = () => {
      server.lightning = { ...server.lightning, active: false };
    };
    const page = await openPanel(server);
    expect(page.S.ui.lane).toBeNull(); // the person never picked a lane: the page opened on the round
    expect(page.left.querySelector('button.lane.on')!.textContent).toContain('Lightning');
    await page.click(page.button('Abort'));
    expect(page.left.querySelector('button.lane.on')!.textContent).toContain('Lightning');
    expect(hasText(page.right, 'UV-1 claim UV-1')).toBe(true);
    expect(hasText(page.right, 'Asked an agent.')).toBe(true);
    // The same when the round is stopped from the CLI or another tab.
    const other: Server = { standup: standupOf(['UV-1']), lightning: roundOf([cardOf('UV-1')]), on: {} };
    const second = await openPanel(other);
    other.lightning = { ...other.lightning, active: false };
    await second.reload();
    expect(second.left.querySelector('button.lane.on')!.textContent).toContain('Lightning');
    expect(second.left.querySelector('.pane-empty')).toBeNull();
  });
});

describe('the votes row', () => {
  const nobody = (key: string) => `No other agent can be messaged to vote on ${key}.`;

  it('says nobody could be asked, keeps the button, and never shows a tally of zero', async () => {
    const card = cardOf('UV-1');
    const page = await openPanel({ standup: standupOf(['UV-1']), lightning: roundOf([card], { log: [nobody(card.key)] }), on: {} });
    expect(hasText(page.right, 'Nobody could be asked.')).toBe(true);
    expect(hasText(page.right, '0 concur')).toBe(false);
    const ask = page.button('Ask skeptics', page.right);
    expect(ask.disabled).toBe(false);
    await page.click(ask);
    expect(page.calls.some((c) => c.path === '/lightning/skeptics' && c.body.key === card.key)).toBe(true);
  });

  it('does not read a panel of nobody as a vote, even if an engine marks it asked', async () => {
    const card = cardOf('UV-1', { votes: { asked: true, tally: { ...none }, entries: [] } });
    const page = await openPanel({ standup: standupOf(['UV-1']), lightning: roundOf([card]), on: {} });
    expect(hasText(page.right, '0 concur')).toBe(false);
    expect(page.buttons('Ask skeptics', page.right)).toHaveLength(1);
  });

  it('still shows a real tally', async () => {
    const entries = [{ sessionID: 's1', name: 'Ada', vote: 'concern', prefers: 'B', reason: 'no' }, { sessionID: 's2', name: 'Bo', vote: null, prefers: null, reason: '' }];
    const card = cardOf('UV-1', { votes: { asked: true, tally: { concur: 0, concern: 1, refuted: 0, silent: 1, asked: 2 }, entries } });
    const page = await openPanel({ standup: standupOf(['UV-1']), lightning: roundOf([card], { log: [nobody(card.key)] }), on: {} });
    expect(hasText(page.right, 'Votes: 0 concur, 1 concern, 0 refuted, 1 silent')).toBe(true);
    expect(hasText(page.right, 'Nobody could be asked.')).toBe(false);
    expect(page.buttons('Ask skeptics', page.right)).toHaveLength(0);
  });
});

describe('a board row that is not in the round', () => {
  it('is not presented over a running round: the pane says so and offers nothing destructive', async () => {
    const server: Server = { standup: standupOf(['UV-1', 'UV-2']), lightning: roundOf([cardOf('UV-1')]), on: {} };
    const page = await openPanel(server);
    await page.click(page.left.querySelector('[data-board="uv:shop:UV-2"]')!);
    expect(hasText(page.right, 'Not in the running round.')).toBe(true);
    expect(page.buttons('Present this one')).toHaveLength(0);
    expect(page.calls.some((c) => c.path === '/lightning/start')).toBe(false);
  });

  it('is offered Present this one when no round runs', async () => {
    const page = await openPanel({ standup: standupOf(['UV-1']), lightning: roundOf([], { active: false, current: null }), on: {} });
    await page.click(page.left.querySelectorAll('button.lane').find((b) => b.textContent.startsWith('Lightning'))!);
    await page.click(page.left.querySelector('[data-board="uv:shop:UV-1"]')!);
    await page.click(page.button('Present this one'));
    expect(page.calls.find((c) => c.path === '/lightning/start')!.body).toEqual({ keys: ['uv:shop:UV-1'] });
  });

  it('is shown settled once a round decided it, also in the next round, which leaves it out', async () => {
    const decided = cardOf('UV-1', { phase: 'decided', decision: { option: 'B', verb: 'deny', at: 1, delivered: true } });
    const server: Server = { standup: standupOf(['UV-1', 'UV-2']), lightning: roundOf([decided, cardOf('UV-2')]), on: {} };
    const page = await openPanel(server);
    expect(page.left.querySelector('[data-board="uv:shop:UV-1"]')!.classList.contains('done')).toBe(true);
    server.lightning = roundOf([cardOf('UV-2')]); // a new round: the decided row is no longer in it, the board is the old one
    await page.reload();
    const row = page.left.querySelector('[data-board="uv:shop:UV-1"]')!;
    expect(row.classList.contains('done')).toBe(true);
    await page.click(row);
    expect(hasText(page.right, 'Decided: option B (Deny)')).toBe(true);
    expect(page.buttons('Present this one')).toHaveLength(0);
    server.standup = standupOf(['UV-1', 'UV-2'], { at: 2, run: '2026-10-28' }); // Morning Standup again: the board is rebuilt, and a row on it is open
    await page.reload();
    expect(page.left.querySelector('[data-board="uv:shop:UV-1"]')!.classList.contains('done')).toBe(false);
  });
});

describe('the source chips', () => {
  it('print a note next to the count, in amber, and keep the tooltip', async () => {
    const sources = [{ id: 'git', label: 'Local git', count: 0, note: 'git unavailable' }, { id: 'ledger', label: 'Ledger', count: 2 }];
    const page = await openPanel({ standup: standupOf(['UV-1'], { sources }), lightning: roundOf([cardOf('UV-1')]), on: {} });
    const [git, ledger] = page.bar.querySelectorAll('.pill.src');
    expect(git.textContent).toContain('Local git 0');
    expect(git.textContent).toContain('git unavailable');
    expect(git.attrs.title).toBe('git unavailable');
    expect(git.classList.contains('amber')).toBe(true);
    expect(git.classList.contains('green')).toBe(false);
    expect(git.querySelector('.mark')).not.toBeNull();
    expect(ledger.classList.contains('green')).toBe(true);
    expect(ledger.textContent).toBe('Ledger 2');
  });
});

describe('the evidence and the options', () => {
  it('print why a cite or an option is UNGROUNDED, not only in a tooltip', async () => {
    const page = await openPanel({ standup: standupOf(['UV-1']), lightning: roundOf([cardOf('UV-1')]), on: {} });
    const ev = page.right.querySelector('li.ev[data-evidence="2"]')!;
    expect(ev.textContent).toContain('UNGROUNDED');
    expect(ev.querySelector('.reason')!.textContent).toBe('src/b.ts is not in abc1234');
    expect(page.right.querySelector('li.ev[data-evidence="1"]')!.querySelector('.reason')).toBeNull();
    const why = (letter: string) => page.right.querySelector(`li.opt[data-option="${letter}"]`)!.querySelector('.reason')?.textContent ?? null;
    expect(why('A')).toBeNull();
    expect(why('B')).toBe('cites no grounded evidence.');
    expect(why('C')).toBe('cites nothing.');
    expect(page.right.querySelector('li.opt[data-option="B"]')!.querySelector('.pill')!.attrs.title).toBeTruthy();
  });
});

describe('a pick belongs to the card it was made on', () => {
  const lightning = (rev: number, over: any = {}) => roundOf([cardOf('UV-1', { rev, ...over })]);

  it('Approve sends the rev of the card that was picked on', async () => {
    const page = await openPanel({ standup: standupOf(['UV-1']), lightning: lightning(3), on: {} });
    await page.click(page.button('B', page.right));
    expect(optionOn(page)).toBe('B');
    await page.click(page.button('Approve', page.right));
    expect(approvals(page)[0].body).toEqual({ key: 'uv:shop:UV-1', option: 'B', rev: 3 });
  });

  it('is gone when the card changes (a new rev), and Approve is off again', async () => {
    const server: Server = { standup: standupOf(['UV-1']), lightning: lightning(1), on: {} };
    const page = await openPanel(server);
    await page.click(page.button('B', page.right));
    server.lightning = lightning(2);
    await page.reload();
    expect(optionOn(page)).toBeNull();
    expect(page.button('Approve', page.right).disabled).toBe(true);
    expect(page.S.ui.picks.size).toBe(0);
    server.lightning = lightning(1); // and a rev that comes round again does not bring it back
    await page.reload();
    expect(optionOn(page)).toBeNull();
  });

  it('is not inherited by a new round whose card has the same rev but means something else by that letter', async () => {
    const server: Server = { standup: standupOf(['UV-1']), lightning: lightning(1), on: {} };
    const page = await openPanel(server);
    await page.click(page.button('B', page.right));
    server.lightning = roundOf([cardOf('UV-1', { presentation: presentationOf({ options: [optionOf('A', 'deny', 'Deny it'), optionOf('B', 'confirm', 'Confirm it')] }) })]);
    await page.reload();
    expect(optionOn(page)).toBeNull();
  });

  it('is dropped by Start Lightning', async () => {
    const page = await openPanel({ standup: standupOf(['UV-1']), lightning: lightning(1), on: {} });
    await page.click(page.button('B', page.right));
    expect(page.S.ui.picks.size).toBe(1);
    await page.click(page.button('Start Lightning'));
    expect(optionOn(page)).toBeNull();
  });

  it('on a 409 says the card changed and loads the round again', async () => {
    const server: Server = { standup: standupOf(['UV-1']), lightning: lightning(1), on: {} };
    server.on['POST /lightning/approve'] = () => ({ status: 409, json: { error: 'The card for uv:shop:UV-1 changed; look again.' } });
    const page = await openPanel(server);
    await page.click(page.button('B', page.right));
    const loads = () => page.calls.filter((c) => c.path === '/lightning').length;
    const before = loads();
    server.lightning = lightning(2); // what the engine did meanwhile
    await page.click(page.button('Approve', page.right));
    expect(page.toasts.textContent).toBe('The card changed; look again.');
    expect(loads()).toBeGreaterThan(before);
    expect(optionOn(page)).toBeNull();
  });
});

describe('the keys A-D and Enter', () => {
  const open = async (over: any = {}) => openPanel({ standup: standupOf(['UV-1']), lightning: roundOf([cardOf('UV-1', over)]), on: {} });

  it('A-D work with the Votes summary focused (a click on it leaves focus there until it lets go)', async () => {
    const page = await open();
    page.right.querySelector('summary')!.focus();
    await page.press('b');
    expect(optionOn(page)).toBe('B');
  });

  it('a click on the Votes row hands focus back to the page, so Enter approves; Enter and Space on it do not', async () => {
    const page = await open();
    await page.click(page.button('B', page.right));
    const summary = () => page.right.querySelector('summary')!;
    summary().focus();
    page.fire(summary(), 'click', { detail: 0 }); // Enter or Space on the focused summary
    expect(page.doc.activeElement.tagName).toBe('SUMMARY');
    expect((await page.press('Enter')).defaultPrevented).toBe(false); // the summary's own Enter: it toggles
    expect(approvals(page)).toHaveLength(0);
    page.fire(summary(), 'click', { detail: 1 }); // a mouse click
    expect(page.doc.activeElement === page.doc.body).toBe(true);
    expect((await page.press('Enter')).defaultPrevented).toBe(true);
    expect(approvals(page)).toHaveLength(1);
  });

  it('keeps what the Votes row shows open across a repaint', async () => {
    const server: Server = { standup: standupOf(['UV-1']), lightning: roundOf([cardOf('UV-1')]), on: {} };
    const page = await openPanel(server);
    const details = page.right.querySelector('details')!;
    details.open = true;
    page.fire(details, 'toggle');
    server.lightning = roundOf([cardOf('UV-1')], { log: ['something happened'] });
    await page.reload();
    expect(page.right.querySelector('details')!.open).toBe(true);
  });

  it('leave a focused real button, input or select alone: Enter activates that button', async () => {
    const page = await open();
    await page.click(page.button('B', page.right));
    const reject = page.button('Reject', page.right);
    reject.focus();
    const ev = await page.press('Enter');
    expect(ev.defaultPrevented).toBe(false);
    expect(approvals(page)).toHaveLength(0);
    for (const tag of ['input', 'select', 'textarea']) {
      const field = page.doc.createElement(tag);
      page.doc.body.append(field);
      field.focus();
      expect((await page.press('a')).defaultPrevented, tag).toBe(false);
      expect(optionOn(page), tag).toBe('B');
      field.remove();
    }
  });
});

describe('the board', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `UV-${1000 + i}`);
  const keyAt = (i: number) => `uv:shop:${ids[i]}`;
  const roundAt = (i: number, log: string[] = []) => roundOf(ids.map((id) => cardOf(id)), { current: keyAt(i), log });

  it('brings the highlighted row into view when the current card changes, and only then', async () => {
    const server: Server = { standup: standupOf(ids), lightning: roundAt(40), on: {} };
    const page = await openPanel(server);
    const onRow = () => page.left.querySelector('.board-row.on')!;
    expect(onRow().dataset.board).toBe(keyAt(40));
    expect(onRow().intoView).toEqual([{ block: 'nearest' }]);
    server.lightning = roundAt(40, ['a new log line']); // the page repaints, the current card is the same: the person's own scrolling stands
    await page.reload();
    expect(onRow().intoView).toEqual([]);
    server.lightning = roundAt(60, ['a new log line']);
    await page.reload();
    expect(onRow().dataset.board).toBe(keyAt(60));
    expect(onRow().intoView).toEqual([{ block: 'nearest' }]);
  });
});

describe('focus', () => {
  const open = async () => openPanel({ standup: standupOf(['UV-1']), lightning: roundOf([cardOf('UV-1')]), on: {} });

  it('stays on a control the person used with the keyboard, across the repaint', async () => {
    const page = await open();
    page.doc.keyboard = true;
    const letter = page.button('B', page.right);
    letter.focus();
    await page.click(letter);
    expect(optionOn(page)).toBe('B');
    expect(page.doc.activeElement.dataset.focus).toBe('letter:uv:shop:UV-1:B');
    expect(page.doc.activeElement === letter).toBe(false); // the control was rebuilt; its replacement has focus
  });

  it('never lands on the next card: Enter on Reject does not leave Reject focused on the card that replaces it', async () => {
    const server: Server = { standup: standupOf(['UV-1', 'UV-2']), lightning: roundOf([cardOf('UV-1'), cardOf('UV-2')]), on: {} };
    server.on['POST /lightning/reject'] = () => {
      server.lightning = roundOf([cardOf('UV-2'), cardOf('UV-1')]);
    };
    const page = await openPanel(server);
    page.doc.keyboard = true;
    page.button('Reject', page.right).focus();
    await page.click(page.button('Reject', page.right));
    expect(hasText(page.right, 'UV-2 claim UV-2')).toBe(true);
    expect(page.doc.activeElement === page.doc.body).toBe(true);
  });

  it('does not move after a click, so A-D and Enter keep working', async () => {
    const page = await open();
    page.doc.keyboard = false;
    const letter = page.button('B', page.right);
    letter.focus();
    await page.click(letter);
    expect(page.doc.activeElement === page.doc.body).toBe(true);
    await page.press('Enter');
    expect(approvals(page)).toHaveLength(1);
  });
});

describe('the colours of pills, chips and primary buttons', () => {
  const css = readFileSync(new URL('panel.css', PANEL), 'utf8');
  const parse = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const mix = (a: number[], b: number[], share: number) => a.map((v, i) => v * share + b[i] * (1 - share));
  const lum = (c: number[]) => {
    const [r, g, b] = c.map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: number[], b: number[]) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const block = (start: string) => {
    const from = css.indexOf(start);
    return css.slice(css.indexOf('{', from) + 1, css.indexOf('}', from));
  };
  const tokensOf = (body: string) => Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\s*;/g)].map((m) => [m[1], m[2]]));
  const light = tokensOf(block(':root {'));
  const dark = { ...light, ...tokensOf(block('@media (prefers-color-scheme: dark) {\n  :root {').replace(/^\s*:root \{/, '')) };
  const dec = (selector: string, prop: string) => {
    const at = css.indexOf(`\n${selector} {`);
    if (at < 0) throw new Error(`no rule for ${selector}`);
    const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
    const m = new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+);`).exec(body);
    if (!m) throw new Error(`${selector} has no ${prop}`);
    return m[1].trim();
  };
  /** The colour of a declaration over `surface`: a token, or `color-mix(in srgb, var(--x) N%, transparent)`. */
  const paint = (value: string, tokens: Record<string, string>, surface: number[]) => {
    const tint = /^color-mix\(in srgb, var\((--[\w-]+)\) (\d+)%, transparent\)$/.exec(value);
    if (tint) return mix(parse(tokens[tint[1]]), surface, Number(tint[2]) / 100);
    const v = /^var\((--[\w-]+)\)$/.exec(value);
    if (!v || !tokens[v[1]]) throw new Error(`cannot resolve ${value}`);
    return parse(tokens[v[1]]);
  };

  for (const [scheme, tokens] of [['light', light], ['dark', dark]] as const) {
    it(`reach 4.5:1 in the ${scheme} scheme`, () => {
      // Each is [selector whose colour and background are read, the property holding the background, the surfaces it can sit on].
      const surfaces = [parse(tokens['--panel']), mix(parse(tokens['--inset']), parse(tokens['--panel']), 0.45), parse(tokens['--inset'])];
      const checks: Array<[string, string, number[][]]> = [
        ['.pill', 'background', [parse(tokens['--inset'])]], // the neutral tag, its own background over anything
        ['.pill.green', 'background', surfaces], // grounded, checkable now, the source chips
        ['.pill.amber', 'background', surfaces], // NeedsHuman, a source chip with a note
        ['.pill.red', 'background', surfaces], // UNGROUNDED
        ['.btn.primary', 'background', [parse(tokens['--accent'])]], // Approve, Start Lightning
        ['.opt .letter', 'background', [parse(tokens['--muted'])]],
        ['.opt.on .letter', 'background', [parse(tokens['--accent'])]],
        ['.pill.src .mark', 'background', [parse(tokens['--amber-ink'])]],
      ];
      for (const [selector, bg, over] of checks) {
        const fg = paint(dec(selector, 'color'), tokens, over[0]);
        for (const surface of over) {
          const r = ratio(fg, paint(dec(selector, bg), tokens, surface));
          expect(r, `${selector} on ${surface.map(Math.round)} in ${scheme}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
});
