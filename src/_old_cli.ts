#!/usr/bin/env node
/**
 * agentim — the command line.
 *
 *   agentim serve [--port N] [--claude-dir DIR] [--socket-dir DIR] [--name NAME] [--capture FILE] [--repo PATH[:base]]...
 *   agentim probe [--claude-dir DIR] [--socket-dir DIR] [--name NAME]   register as a peer and print every frame received
 *   agentim agents                      the roster
 *   agentim send <agent> <text...>      a message from the user, under the user heading
 *   agentim transcript <agent> [--tail N]
 *   agentim volunteer <title> --description <text> [--agent NAME]...
 *   agentim status
 *   agentim ack <canary-id>             the acknowledgment an agent's first tool call makes
 *   agentim hook session-start | pre-tool-use     Claude Code hook entry points (JSON on stdin)
 *
 * Every command but serve/probe/ack talks to the daemon at $AGENTIM_URL
 * (default http://127.0.0.1:7433).
 */

import { readFileSync } from 'node:fs';
import { Hub } from './hub.js';
import { serve, DEFAULT_PORT } from './daemon.js';
import { PeerInbox } from './transport.js';
import { CLAUDE_DIR } from './discovery.js';
import { DEFAULT_SOCKET_DIR, DEFAULT_PEER_NAME } from './hub.js';

const BASE = process.env.AGENTIM_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`;

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string[]> } {
  const positional: string[] = [];
  const flags: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        (flags[key] ??= []).push(next);
        i++;
      } else (flags[key] ??= []).push('true');
    } else positional.push(a);
  }
  return { positional, flags };
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `${res.status} from ${path}`);
  return json;
}

const print = (v: unknown): void => {
  process.stdout.write(JSON.stringify(v, null, 2) + '\n');
};

async function hook(kind: string): Promise<void> {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}') as { session_id?: string; tool_name?: string; tool_input?: Record<string, unknown> };
  if (!input.session_id) return;
  if (kind === 'session-start') {
    const { promptLine } = (await api('POST', '/canary/issue', { sessionId: input.session_id })) as { promptLine: string };
    print({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: promptLine } });
    return;
  }
  if (kind === 'pre-tool-use') {
    const verdict = (await api('POST', '/canary/gate', { sessionId: input.session_id, tool_name: input.tool_name, tool_input: input.tool_input })) as { allow: boolean; reason?: string };
    if (verdict.allow) return;
    print({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `agentIM canary: ${verdict.reason}. Acknowledge the session canary first (agentim ack <id>).` } });
    return;
  }
  throw new Error(`unknown hook ${kind}`);
}

async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const [cmd, ...rest] = positional;
  const one = (k: string) => flags[k]?.[0];
  switch (cmd) {
    case 'serve': {
      const hub = new Hub({
        claudeDir: one('claude-dir') ?? CLAUDE_DIR,
        socketDir: one('socket-dir') ?? DEFAULT_SOCKET_DIR,
        name: one('name') ?? DEFAULT_PEER_NAME,
        captureLog: one('capture'),
        repos: (flags.repo ?? []).map((r) => {
          const [path, baseBranch] = r.split(':');
          return { path, baseBranch };
        }),
      });
      const d = await serve(hub, { port: Number(one('port') ?? DEFAULT_PORT) });
      process.stderr.write(`agentim ${hub.name} listening on ${d.url}; peer socket ${hub.inbox.socketPath}\n`);
      const stop = () => void d.close().then(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    case 'probe': {
      const inbox = new PeerInbox({
        claudeDir: one('claude-dir') ?? CLAUDE_DIR,
        socketDir: one('socket-dir') ?? DEFAULT_SOCKET_DIR,
        name: one('name') ?? `${DEFAULT_PEER_NAME}-probe`,
        cwd: process.cwd(),
        captureLog: one('capture'),
        onFrame: (frame, captured) => {
          print({ at: new Date(captured.at).toISOString(), frame });
          return { ok: true };
        },
      });
      await inbox.start();
      process.stderr.write(`probe registered as peer "${inbox.opts.name}" on ${inbox.socketPath}. From a Claude Code session: SendMessage to "${inbox.opts.name}". Ctrl-C to stop.\n`);
      const stop = () => void inbox.stop().then(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    case 'agents':
      return print(await api('GET', '/agents'));
    case 'send':
      if (rest.length < 2) throw new Error('usage: agentim send <agent> <text...>');
      return print(await api('POST', `/agents/${encodeURIComponent(rest[0])}/message`, { text: rest.slice(1).join(' ') }));
    case 'transcript':
      if (!rest[0]) throw new Error('usage: agentim transcript <agent> [--tail N]');
      return print(await api('GET', `/agents/${encodeURIComponent(rest[0])}/transcript?tail=${Number(one('tail') ?? 20)}`));
    case 'volunteer':
      if (!rest[0] || !one('description')) throw new Error('usage: agentim volunteer <title> --description <text> [--agent NAME]...');
      return print(await api('POST', '/volunteer', { title: rest.join(' '), description: one('description'), roster: flags.agent }));
    case 'status':
      return print(await api('GET', '/status'));
    case 'ack':
      // The acknowledgment itself is observed by the PreToolUse hook (the command line is the signal); the command only has to exist.
      if (!rest[0]) throw new Error('usage: agentim ack <canary-id>');
      process.stdout.write(`acknowledged ${rest[0]}\n`);
      return;
    case 'hook':
      return hook(rest[0] ?? '');
    default:
      process.stderr.write('usage: agentim serve | probe | agents | send | transcript | volunteer | status | ack | hook\n');
      process.exit(cmd ? 1 : 0);
  }
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`agentim: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
