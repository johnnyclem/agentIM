#!/usr/bin/env node
/**
 * agentim — the command line over the daemon.
 *
 *   agentim serve [--demo] [--port N] [--claude PATH] [--repo PATH] [--permission-mode MODE] [--claude-dir DIR] [--state FILE]
 *                 [--ledger-ref REF] [--ticket-prefix PFX]...
 *   agentim state | agents
 *   agentim send <agent> <text...>            a message from you, under the human tag
 *   agentim send-as-me <agent> <text...>      restart an idle background job with your text as a real user turn
 *   agentim thread <agent>                    the 1:1 thread as the panel shows it
 *   agentim status-check [agent...]           ask everyone (or these) for a cim-status block; opens review mode
 *   agentim review <group-key>                the review entries
 *   agentim volunteer <title> --description <text> [--requester NAME]
 *   agentim standup [--date YYYY-MM-DD] [--json]   the morning standup: what moved since the last working day
 *   agentim lightning start [--repo NAME] [--panel N] | show | abort
 *   agentim lightning approve <key> <A-D> | reject <key> | defer <key> | skeptics <key>
 *   agentim pause | resume | done <agent> | rename <agent> <name> | terminal <agent> | model <agent> <id>
 *   agentim spawn <name> --cwd DIR --prompt TEXT [--model ID]
 *   agentim ack <canary-id>                   the acknowledgment an agent's first tool call makes
 *   agentim hook session-start | pre-tool-use Claude Code hook entry points (JSON on stdin)
 *
 * <agent> is a session id, its 8-character prefix, or a name. Every command
 * but serve/ack talks to the daemon at $AGENTIM_URL (default http://127.0.0.1:7433).
 */

import { readFileSync } from 'node:fs';
import { Hub } from './hub.js';
import { demoHub } from './demo.js';
import { serve, DEFAULT_PORT } from './daemon.js';
import { renderStandupText, type Standup } from './standup.js';
import type { Agent } from './agent.js';
import type { PermissionMode } from './spawner.js';

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

/** A session id, its prefix, or a name, resolved against the roster. */
async function resolveAgent(ref: string): Promise<Agent> {
  const agents = (await api('GET', '/agents')) as Agent[];
  const hit = agents.find((a) => a.sessionID === ref) ?? agents.find((a) => a.sessionID.startsWith(ref)) ?? agents.filter((a) => a.name === ref)[0];
  if (!hit) throw new Error(`no agent matches "${ref}"; agentim agents lists them`);
  return hit;
}

const enc = (s: string) => encodeURIComponent(s);

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
      const hub = flags.demo ? demoHub() : new Hub({
        settings: {
          ...(one('claude') ? { claudePath: one('claude') } : {}),
          ...(one('repo') ? { repoPath: one('repo') } : {}),
          ...(one('permission-mode') ? { permissionMode: one('permission-mode') as PermissionMode } : {}),
          ...(one('claude-dir') ? { claudeDir: one('claude-dir') } : {}),
          ...(one('state') ? { statePath: one('state') } : {}),
          ...(one('ledger-ref') ? { ledgerRef: one('ledger-ref') } : {}),
          ...(flags['ticket-prefix'] ? { ticketPrefixes: flags['ticket-prefix'] } : {}),
        },
      });
      const d = await serve(hub, { port: Number(one('port') ?? DEFAULT_PORT) });
      process.stderr.write(`agentim listening on ${d.url}\n`);
      const stop = () => void d.close().then(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    case 'state':
      return print(await api('GET', '/state'));
    case 'agents':
      return print(await api('GET', '/agents'));
    case 'send':
    case 'send-as-me': {
      if (rest.length < 2) throw new Error(`usage: agentim ${cmd} <agent> <text...>`);
      const a = await resolveAgent(rest[0]);
      await api('POST', `/agents/${enc(a.sessionID)}/select`);
      return print(await api('POST', `/agents/${enc(a.sessionID)}/${cmd === 'send' ? 'message' : 'send-as-me'}`, { text: rest.slice(1).join(' ') }));
    }
    case 'thread': {
      const a = await resolveAgent(rest[0] ?? '');
      return print(await api('POST', `/agents/${enc(a.sessionID)}/select`));
    }
    case 'status-check': {
      const ids = await Promise.all(rest.map((r) => resolveAgent(r).then((a) => a.sessionID)));
      return print(await api('POST', '/status-check', ids.length ? { sessionIDs: ids } : {}));
    }
    case 'review':
      if (!rest[0]) throw new Error('usage: agentim review <group-key>');
      return print(await api('GET', `/groups/${enc(rest[0])}`));
    case 'volunteer':
      if (!rest[0] || !one('description')) throw new Error('usage: agentim volunteer <title> --description <text> [--requester NAME]');
      return print(await api('POST', '/volunteer', { title: rest.join(' '), description: one('description'), requester: one('requester') }));
    case 'standup': {
      const standup = (await api('POST', '/standup', one('date') ? { covering: one('date') } : {})) as Standup;
      return flags.json ? print(standup) : void process.stdout.write(renderStandupText(standup) + '\n');
    }
    case 'lightning': {
      const [sub, key, letter] = rest;
      if (sub === 'start') return print(await api('POST', '/lightning/start', { ...(one('repo') ? { repo: one('repo') } : {}), ...(one('panel') ? { panelSize: Number(one('panel')) } : {}) }));
      if (sub === 'show') return print(await api('GET', '/lightning'));
      if (sub === 'abort') return print(await api('POST', '/lightning/abort'));
      if (sub === 'approve' && key && /^[A-D]$/.test(letter ?? '')) return print(await api('POST', '/lightning/approve', { key, option: letter }));
      if ((sub === 'reject' || sub === 'defer' || sub === 'skeptics') && key) return print(await api('POST', `/lightning/${sub}`, { key }));
      throw new Error('usage: agentim lightning start [--repo NAME] [--panel N] | show | abort | approve <key> <A-D> | reject <key> | defer <key> | skeptics <key>');
    }
    case 'pause':
      return print(await api('POST', '/pause'));
    case 'resume':
      return print(await api('POST', '/resume'));
    case 'done': {
      const a = await resolveAgent(rest[0] ?? '');
      return print(await api('POST', `/agents/${enc(a.sessionID)}/done`));
    }
    case 'rename': {
      const a = await resolveAgent(rest[0] ?? '');
      return print(await api('POST', `/agents/${enc(a.sessionID)}/rename`, { name: rest.slice(1).join(' ') }));
    }
    case 'terminal': {
      const a = await resolveAgent(rest[0] ?? '');
      return print(await api('POST', `/agents/${enc(a.sessionID)}/terminal`));
    }
    case 'model': {
      const a = await resolveAgent(rest[0] ?? '');
      return print(await api('POST', `/agents/${enc(a.sessionID)}/model`, { model: rest[1] }));
    }
    case 'spawn':
      if (!rest[0] || !one('cwd') || !one('prompt')) throw new Error('usage: agentim spawn <name> --cwd DIR --prompt TEXT [--model ID]');
      return print(await api('POST', '/spawn', { name: rest.join(' '), cwd: one('cwd'), prompt: one('prompt'), model: one('model') }));
    case 'ack':
      // The acknowledgment itself is observed by the PreToolUse hook (the command line is the signal); the command only has to exist.
      if (!rest[0]) throw new Error('usage: agentim ack <canary-id>');
      process.stdout.write(`acknowledged ${rest[0]}\n`);
      return;
    case 'hook':
      return hook(rest[0] ?? '');
    default:
      process.stderr.write('usage: agentim serve | state | agents | send | send-as-me | thread | status-check | review | volunteer | standup | lightning | pause | resume | done | rename | terminal | model | spawn | ack | hook\n');
      process.exit(cmd ? 1 : 0);
  }
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`agentim: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
