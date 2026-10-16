/**
 * The daemon: the hub behind a loopback HTTP API with a server-sent event
 * stream, which a panel, the CLI and the Claude Code hooks all talk to.
 * Loopback only; nothing here listens on a routable address.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hub, type HubEvent } from './hub.js';
import { parseStatusReport } from './status-report.js';
import { terminalTooltip } from './spawner.js';

export const DEFAULT_PORT = 7433;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const raise = (status: number, message: string): never => {
  throw new HttpError(status, message);
};

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

const strList = (body: Record<string, unknown>, key: string): string[] | undefined => (Array.isArray(body[key]) ? (body[key] as unknown[]).map(String) : undefined);

const report = (body: Record<string, unknown>): ReturnType<typeof parseStatusReport> => {
  const r = parseStatusReport(str(body, 'turnText'));
  if (!r) throw new HttpError(400, 'turnText is not a cim-status report');
  return r;
};

type Ctx = { params: string[]; query: URLSearchParams; body: Record<string, unknown> };
type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const dec = (s: string): string => decodeURIComponent(s);

/** Every pane action, as a URL. */
export function routes(hub: Hub): Route[] {
  const r = (method: string, path: string, handler: Handler): Route => ({ method, pattern: new RegExp('^' + path.replace(/:[a-z]+/gi, '([^/]+)') + '/?$'), handler });
  const conv = (id: string) => {
    const c = hub.conversations.existing(id);
    if (!c) return null;
    return { agent: c.agent, turns: c.turns, draft: c.draft, isLoading: c.isLoading, isAwaitingReply: c.isAwaitingReply, isResuming: c.isResuming, errorMessage: c.errorMessage, selectedModel: c.selectedModel, canSend: c.canSend, canResume: c.canResume, offersSendAsUser: c.offersSendAsUser, canSendAsUser: c.canSendAsUser };
  };
  const groupView = (key: string) => {
    const g = hub.group(key);
    const review = hub.review(key);
    return { key, participants: g.participants, turns: g.turns, draft: g.draft, isLoading: g.isLoading, isAwaitingReply: g.isAwaitingReply, awaiting: [...g.awaitingSessionIDs], errorMessage: g.errorMessage, isReviewing: g.isReviewing, reviewDrafts: Object.fromEntries(g.reviewDrafts), canSend: g.canSend, ...review };
  };
  const volunteerView = (id: string) => {
    const v = hub.volunteer(id);
    return { id, requester: v.requester, title: v.title, description: v.description, phase: v.phase, recipients: v.recipients, reached: [...v.reached], answers: Object.fromEntries(v.answers), silent: Object.fromEntries(v.silent), assignee: v.assignee, assigneeAgent: hub.assigneeAgent(id), isListening: v.isListening, isAssigning: v.isAssigning, errorMessage: v.errorMessage, summary: v.summary(), volunteers: v.volunteers, declined: v.declined, unanswered: v.unanswered };
  };
  return [
    r('GET', '/health', () => ({ ok: true, at: hub.clock() })),
    r('GET', '/state', () => hub.snapshot()),
    r('POST', '/refresh', async () => {
      await hub.refresh();
      return hub.snapshot().roster;
    }),
    r('GET', '/agents', () => hub.visibleAgents),
    r('GET', '/agents/:id', ({ params }) => hub.agent(dec(params[0])) ?? raise(404, 'no such agent')),
    r('POST', '/agents/:id/select', async ({ params }) => {
      await hub.selectAgent(dec(params[0]));
      return conv(dec(params[0]));
    }),
    r('GET', '/agents/:id/thread', ({ params }) => conv(dec(params[0])) ?? raise(404, 'no thread; select the agent first')),
    r('POST', '/agents/:id/draft', ({ params, body }) => {
      const c = hub.conversation(dec(params[0]));
      c.draft = typeof body.text === 'string' ? body.text : '';
      return conv(dec(params[0]));
    }),
    r('POST', '/agents/:id/message', async ({ params, body }) => ({ delivered: await hub.send(dec(params[0]), str(body, 'text')), thread: conv(dec(params[0])) })),
    r('POST', '/agents/:id/send-as-me', async ({ params, body }) => ({ delivered: await hub.sendAsUser(dec(params[0]), str(body, 'text')), thread: conv(dec(params[0])) })),
    r('POST', '/agents/:id/instruction', async ({ params, body }) => ({ delivered: await hub.conversation(dec(params[0])).sendInstruction(str(body, 'text')) })),
    r('POST', '/agents/:id/model', async ({ params, body }) => ({ switched: await hub.changeModel(dec(params[0]), str(body, 'model')) })),
    r('POST', '/agents/:id/terminal', ({ params }) => hub.openInTerminal(dec(params[0]))),
    r('GET', '/agents/:id/terminal', ({ params }) => ({ tooltip: terminalTooltip(hub.agent(dec(params[0])) ?? raise(404, 'no such agent')) })),
    r('POST', '/agents/:id/done', async ({ params }) => {
      await hub.done(dec(params[0]));
      return hub.snapshot();
    }),
    r('POST', '/agents/:id/rename', ({ params, body }) => hub.rename(dec(params[0]), typeof body.name === 'string' ? body.name : '')),
    r('POST', '/agents/:id/chore/wiki', ({ params, body }) => hub.wikiChore({ sessionID: dec(params[0]), groupKey: str(body, 'groupKey', false) || undefined }, dec(params[0]), report(body)!, body.confirmed === true)),
    r('POST', '/agents/:id/chore/worktrees', ({ params, body }) => hub.worktreeChore({ sessionID: dec(params[0]), groupKey: str(body, 'groupKey', false) || undefined }, dec(params[0]), report(body)!, body.confirmed === true)),
    r('POST', '/agents/:id/chore/tbuv', ({ params, body }) => hub.tbuvChore({ sessionID: dec(params[0]), groupKey: str(body, 'groupKey', false) || undefined }, dec(params[0]), report(body)!)),
    r('POST', '/agents/:id/tbuv-review', async ({ params, body }) => ({ sent: await hub.tbuvReview({ sessionID: dec(params[0]), groupKey: str(body, 'groupKey', false) || undefined }, dec(params[0]), str(body, 'id'), body.looksRight === true) })),
    r('POST', '/chip', ({ body }) => hub.chip(str(body, 'turnText')) ?? { report: null }),
    r('POST', '/message-all', async () => groupView((await hub.messageAll()).key)),
    r('POST', '/status-check', async ({ body }) => groupView((await hub.statusCheck(strList(body, 'sessionIDs'))).key)),
    r('GET', '/groups', () => hub.snapshot().groups),
    r('POST', '/groups', async ({ body }) => groupView((await hub.newGroup(strList(body, 'sessionIDs') ?? [])).key)),
    r('GET', '/groups/:key', ({ params }) => groupView(dec(params[0]))),
    r('POST', '/groups/:key/select', async ({ params }) => {
      await hub.selectGroup(dec(params[0]));
      return groupView(dec(params[0]));
    }),
    r('POST', '/groups/:key/draft', ({ params, body }) => {
      hub.group(dec(params[0])).draft = typeof body.text === 'string' ? body.text : '';
      return groupView(dec(params[0]));
    }),
    r('POST', '/groups/:key/message', async ({ params, body }) => {
      const g = hub.group(dec(params[0]));
      g.draft = str(body, 'text');
      return { delivered: await g.send(), group: groupView(dec(params[0])) };
    }),
    r('POST', '/groups/:key/instruction', async ({ params, body }) => {
      const g = hub.group(dec(params[0]));
      const to = g.participants.find((p) => p.sessionID === str(body, 'sessionID')) ?? raise(404, 'not a participant');
      return { delivered: await g.sendInstruction(str(body, 'text'), to) };
    }),
    r('POST', '/groups/:key/status-check', async ({ params }) => ({ delivered: await hub.group(dec(params[0])).sendStatusCheck(), group: groupView(dec(params[0])) })),
    r('POST', '/groups/:key/review', ({ params, body }) => {
      const g = hub.group(dec(params[0]));
      if (typeof body.isReviewing === 'boolean') g.isReviewing = body.isReviewing;
      if (typeof body.selection === 'string') g.reviewSelection = body.selection;
      return groupView(dec(params[0]));
    }),
    r('POST', '/groups/:key/review/:sid/draft', ({ params, body }) => {
      hub.group(dec(params[0])).reviewDrafts.set(dec(params[1]), typeof body.text === 'string' ? body.text : '');
      return groupView(dec(params[0]));
    }),
    r('POST', '/groups/:key/review/:sid/reply', async ({ params, body }) => {
      const g = hub.group(dec(params[0]));
      const to = g.participants.find((p) => p.sessionID === dec(params[1])) ?? raise(404, 'not a participant');
      if (typeof body.text === 'string') g.reviewDrafts.set(to.sessionID, body.text);
      return { delivered: await g.sendReviewReply(to), group: groupView(dec(params[0])) };
    }),
    r('POST', '/groups/:key/review/:sid/mark-reviewed', ({ params }) => {
      hub.markReviewed(dec(params[0]), dec(params[1]));
      return hub.review(dec(params[0]));
    }),
    r('POST', '/groups/:key/tbuv', async ({ params, body }) => {
      const g = hub.group(dec(params[0]));
      const ids = new Set(strList(body, 'sessionIDs') ?? []);
      return { delivered: await g.sendTBUVResolution(g.participants.filter((p) => ids.has(p.sessionID))) };
    }),
    r('DELETE', '/groups/:key', ({ params }) => {
      hub.closeGroup(dec(params[0]));
      return { ok: true };
    }),
    r('GET', '/volunteer', () => hub.snapshot().volunteers),
    r('POST', '/volunteer', async ({ body }) => volunteerView((await hub.findVolunteer({ requester: str(body, 'requester', false) || undefined, title: str(body, 'title'), description: str(body, 'description'), sessionIDs: strList(body, 'sessionIDs') })).id)),
    r('GET', '/volunteer/:id', ({ params }) => volunteerView(params[0])),
    r('POST', '/volunteer/:id/select', ({ params }) => {
      hub.selectVolunteer(params[0]);
      return volunteerView(params[0]);
    }),
    r('POST', '/volunteer/:id/assign', async ({ params, body }) => ({ assigned: await hub.volunteer(params[0]).assign(hub.agent(str(body, 'sessionID')) ?? raise(404, 'no such agent')), request: volunteerView(params[0]) })),
    r('POST', '/volunteer/:id/spawn', async ({ params, body }) => ({ started: await hub.volunteer(params[0]).spawn({ name: str(body, 'name'), model: str(body, 'model', false) || undefined, cwd: str(body, 'cwd') }), request: volunteerView(params[0]) })),
    r('POST', '/volunteer/:id/listen', ({ params }) => {
      hub.volunteer(params[0]).listenAgain();
      return volunteerView(params[0]);
    }),
    r('DELETE', '/volunteer/:id', ({ params }) => {
      hub.closeVolunteer(params[0]);
      return { ok: true };
    }),
    r('GET', '/spawn-defaults', ({ query }) => hub.spawnDefaults(query.get('title') ?? '')),
    r('POST', '/spawn', async ({ body }) => ({ jobID: await hub.spawnAgent({ name: str(body, 'name'), model: str(body, 'model', false) || undefined, cwd: str(body, 'cwd'), prompt: str(body, 'prompt') }) })),
    r('POST', '/pause', async () => {
      await hub.pauseAgents();
      return hub.snapshot();
    }),
    r('POST', '/resume', async () => {
      await hub.resumeAgents();
      return hub.snapshot();
    }),
    r('POST', '/resume/dismiss', () => {
      hub.dismissResumeSet();
      return hub.snapshot();
    }),
    r('GET', '/archive', () => hub.archive.entries),
    r('POST', '/archive/:id/restore', ({ params }) => {
      hub.restoreArchived(dec(params[0]));
      return hub.archive.entries;
    }),
    r('POST', '/selection/clear', () => {
      hub.setSelection(null);
      return { selection: null };
    }),
    r('GET', '/claims', () => hub.claims.live(hub.clock())),
    r('POST', '/claims', ({ body }) => hub.claim({ agent: str(body, 'agent'), resource: str(body, 'resource'), verb: str(body, 'verb'), confidence: typeof body.confidence === 'number' ? body.confidence : 1, ttlMs: typeof body.ttlMs === 'number' ? body.ttlMs : 30 * 60 * 1000 })),
    r('POST', '/claims/:id/complete', ({ params }) => ({ completed: hub.claims.complete(params[0], hub.clock()) })),
    r('POST', '/canary/issue', ({ body }) => hub.canaryIssue(str(body, 'sessionId'))),
    r('POST', '/canary/gate', ({ body }) => hub.canaryGate(str(body, 'sessionId'), { tool_name: str(body, 'tool_name', false), tool_input: (body.tool_input as Record<string, unknown>) ?? {} })),
    r('POST', '/canary/:id/clear', ({ params }) => {
      hub.canaryClear(params[0]);
      return { ok: true };
    }),
    r('GET', '/fleet', () => hub.fleet()),
  ];
}

function sse(hub: Hub, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(': agentim\n\n');
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
      res.end(JSON.stringify(body, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v instanceof Set ? [...v] : v)));
    };
    try {
      for (const route of table) {
        if (route.method !== req.method) continue;
        const m = route.pattern.exec(url.pathname);
        if (!m) continue;
        const body = req.method === 'POST' ? await readJson(req) : {};
        return send(200, (await route.handler({ params: m.slice(1), query: url.searchParams, body })) ?? { ok: true });
      }
      return send(404, { error: `no route ${req.method} ${url.pathname}` });
    } catch (err) {
      if (err instanceof HttpError) return send(err.status, { error: err.message });
      return send(err instanceof Error && /^No |no such|not a participant/.test(err.message) ? 404 : 500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}

export interface Daemon {
  hub: Hub;
  server: Server;
  url: string;
  close(): Promise<void>;
}

/** Start the roster poll and the loopback server. `port: 0` picks a free one. */
export async function serve(hub: Hub, opts: { port?: number; host?: string; pollMs?: number } = {}): Promise<Daemon> {
  hub.start(opts.pollMs);
  const server = createServer(handler(hub));
  await new Promise<void>((resolve, reject) => server.listen(opts.port ?? DEFAULT_PORT, opts.host ?? '127.0.0.1', () => resolve()).once('error', reject));
  const addr = server.address() as AddressInfo;
  return {
    hub,
    server,
    url: `http://${addr.address}:${addr.port}`,
    close: async () => {
      hub.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
