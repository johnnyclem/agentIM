import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
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
});
