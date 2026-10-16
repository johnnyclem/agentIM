/**
 * The daemon: the hub behind a loopback HTTP API with a server-sent event
 * stream, which the panel, the CLI and the Claude Code hooks all talk to.
 * Loopback only; nothing here listens on a routable address.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hub, type HubEvent } from './hub.js';

export const DEFAULT_PORT = 7433;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch (err) {
    throw new HttpError(400, `body is not a JSON object: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function str(body: Record<string, unknown>, key: string, required = true): string {
  const v = body[key];
  if (typeof v === 'string' && v.trim()) return v;
  if (required) throw new HttpError(400, `${key} is a non-empty string`);
  return '';
}

function num(body: Record<string, unknown>, key: string, fallback?: number): number {
  const v = body[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (fallback !== undefined) return fallback;
  throw new HttpError(400, `${key} is a number`);
}

type Handler = (ctx: { params: string[]; query: URLSearchParams; body: Record<string, unknown> }) => Promise<unknown> | unknown;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

/** The route table: every panel action, as a URL. */
export function routes(hub: Hub): Route[] {
  const r = (method: string, path: string, handler: Handler): Route => ({
    method,
    pattern: new RegExp('^' + path.replace(/:[a-z]+/gi, '([^/]+)') + '/?$'),
    handler,
  });
  return [
    r('GET', '/health', () => ({ ok: true, name: hub.name, at: hub.clock() })),
    r('GET', '/agents', () => hub.agents()),
    r('GET', '/agents/:id', ({ params }) => hub.agent(decodeURIComponent(params[0])) ?? raise(404, 'no such agent')),
    r('GET', '/agents/:id/transcript', ({ params, query }) => hub.transcript(decodeURIComponent(params[0]), Number(query.get('tail') ?? 50)) ?? raise(404, 'no transcript')),
    r('POST', '/agents/:id/message', ({ params, body }) => hub.send(decodeURIComponent(params[0]), str(body, 'text'), { fromUser: body.fromUser !== false })),
    r('POST', '/agents/:id/terminal', async ({ params }) => {
      await hub.openInTerminal(decodeURIComponent(params[0]));
      return { ok: true };
    }),
    r('GET', '/deliveries', () => hub.deliveriesList()),
    r('GET', '/deliveries/:id', ({ params }) => {
      hub.refreshDeliveries();
      return hub.delivery(params[0]) ?? raise(404, 'no such delivery');
    }),
    r('POST', '/spawn', ({ body }) => {
      const mode = str(body, 'mode');
      if (mode !== 'interactive' && mode !== 'background') throw new HttpError(400, 'mode is interactive or background');
      return hub.spawn({ mode, agent: str(body, 'agent'), repo: str(body, 'repo'), prompt: str(body, 'prompt', false) || undefined }).then((where) => ({ mode, agent: body.agent, where }));
    }),
    r('GET', '/volunteer', () => hub.volunteers()),
    r('POST', '/volunteer', ({ body }) =>
      hub.volunteer({
        title: str(body, 'title'),
        description: str(body, 'description'),
        roster: Array.isArray(body.roster) ? (body.roster as unknown[]).map(String) : undefined,
        windowMs: typeof body.windowMs === 'number' ? body.windowMs : undefined,
      })
    ),
    r('GET', '/volunteer/:id', ({ params }) => hub.view(params[0]) ?? raise(404, 'no such request')),
    r('POST', '/volunteer/:id/reply', ({ params, body }) => hub.volunteerReply(params[0], str(body, 'agent'), str(body, 'text'))),
    r('POST', '/volunteer/:id/pick', ({ params, body }) => hub.volunteerPick(params[0], str(body, 'agent'))),
    r('POST', '/volunteer/:id/settle', ({ params }) => hub.settle(params[0])),
    r('POST', '/volunteer/:id/spawn', ({ params, body }) => {
      const mode = str(body, 'mode', false) || 'background';
      if (mode !== 'interactive' && mode !== 'background') throw new HttpError(400, 'mode is interactive or background');
      return hub.volunteerSpawn(params[0], { mode, repo: str(body, 'repo'), agent: str(body, 'agent', false) || undefined });
    }),
    r('GET', '/claims', () => hub.liveClaims()),
    r('POST', '/claims', ({ body }) => hub.claim({ agent: str(body, 'agent'), resource: str(body, 'resource'), verb: str(body, 'verb'), confidence: num(body, 'confidence', 1), ttlMs: num(body, 'ttlMs', 30 * 60 * 1000) })),
    r('POST', '/claims/:id/complete', ({ params }) => ({ completed: hub.complete(params[0]) })),
    r('POST', '/canary/issue', ({ body }) => hub.canaryIssue(str(body, 'sessionId'))),
    r('POST', '/canary/gate', ({ body }) => hub.canaryGate(str(body, 'sessionId'), { tool_name: str(body, 'tool_name', false), tool_input: (body.tool_input as Record<string, unknown>) ?? {} })),
    r('POST', '/canary/:id/clear', ({ params }) => {
      hub.canaryClear(params[0]);
      return { ok: true };
    }),
    r('GET', '/status', () => hub.status()),
  ];
}

function raise(status: number, message: string): never {
  throw new HttpError(status, message);
}

function sse(hub: Hub, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(`: agentim ${hub.name}\n\n`);
  const unsubscribe = hub.subscribe((e: HubEvent) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
  const beat = setInterval(() => res.write(`: beat ${hub.clock()}\n\n`), 15_000);
  res.on('close', () => {
    clearInterval(beat);
    unsubscribe();
  });
}

export function handler(hub: Hub): (req: IncomingMessage, res: ServerResponse) => void {
  const table = routes(hub);
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/events') return sse(hub, res);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      for (const route of table) {
        if (route.method !== req.method) continue;
        const m = route.pattern.exec(url.pathname);
        if (!m) continue;
        const body = req.method === 'POST' ? await readJson(req) : {};
        return send(200, await route.handler({ params: m.slice(1), query: url.searchParams, body }));
      }
      return send(404, { error: `no route ${req.method} ${url.pathname}` });
    } catch (err) {
      if (err instanceof HttpError) return send(err.status, { error: err.message });
      return send(500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}

export interface Daemon {
  hub: Hub;
  server: Server;
  url: string;
  close(): Promise<void>;
}

/** Start the hub and its loopback server. `port: 0` picks a free one; `tickMs` is how often picked rounds are settled (0 disables). */
export async function serve(hub: Hub, opts: { port?: number; host?: string; tickMs?: number } = {}): Promise<Daemon> {
  await hub.start();
  const server = createServer(handler(hub));
  await new Promise<void>((resolve, reject) => server.listen(opts.port ?? DEFAULT_PORT, opts.host ?? '127.0.0.1', () => resolve()).once('error', reject));
  const addr = server.address() as AddressInfo;
  const tick = opts.tickMs === 0 ? null : setInterval(() => void hub.settleAll().catch(() => undefined), opts.tickMs ?? 1000);
  return {
    hub,
    server,
    url: `http://${addr.address}:${addr.port}`,
    close: async () => {
      if (tick) clearInterval(tick);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await hub.stop();
    },
  };
}
