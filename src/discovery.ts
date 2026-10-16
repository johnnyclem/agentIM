/**
 * Discovery — who is running, from what Claude Code already writes.
 *
 * Two sources, joined by session id:
 * - `~/.claude/sessions/<pid>.json`: one record per live Claude Code
 *   process (pid, sessionId, cwd, kind, name, status, the messaging
 *   socket). A record whose pid is gone is a stopped agent.
 * - `~/.claude/projects/<slug>/<sessionId>.jsonl`: the transcript. The
 *   roster reads the assistant turns (what the terminal shows), the last
 *   activity, the title and the branch from it.
 *
 * Nothing here writes: discovery is a read of the disk against the clock
 * the caller passes, and every age it reports says what reading it used.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type PeerKind = 'interactive' | 'bg' | 'daemon' | 'daemon-worker' | string;

/** One record of the sessions registry, as Claude Code 2.1 writes it. Unknown fields are kept. */
export interface PeerRecord {
  pid: number;
  sessionId: string;
  cwd?: string;
  startedAt?: number;
  version?: string;
  kind?: PeerKind;
  name?: string;
  status?: string;
  messagingSocketPath?: string;
  peerProtocol?: number;
  peerFeatures?: string[];
  updatedAt?: number;
  [extra: string]: unknown;
}

export interface TranscriptTurn {
  uuid: string;
  role: 'assistant' | 'user';
  text: string;
  timestamp: string;
  /** The assistant turn called a tool (it is mid-work). */
  toolUse?: boolean;
}

export interface TranscriptSummary {
  sessionId: string;
  cwd: string | null;
  gitBranch: string | null;
  title: string | null;
  lastPrompt: string | null;
  lastActivityAt: number | null;
  /** The newest conversational entry: what it was, for busy/idle. */
  tail: 'assistant-text' | 'assistant-tool' | 'user-prompt' | 'user-tool-result' | null;
  turns: TranscriptTurn[];
}

export type AgentState = 'busy' | 'idle' | 'stopped';

export interface Agent {
  /** The peer name Claude Code registered (what SendMessage addresses), else the session id. */
  name: string;
  sessionId: string;
  pid: number;
  cwd: string;
  mode: 'interactive' | 'background';
  state: AgentState;
  /** Elapsed ms since the last activity, measured at `asOf`; null when unknown. */
  sinceActivityMs: number | null;
  lastActivityAt: number | null;
  title: string | null;
  branch: string | null;
  socket: string | null;
  transcriptPath: string | null;
}

export interface Roster {
  asOf: number;
  agents: Agent[];
}

export const CLAUDE_DIR = join(homedir(), '.claude');

/** The project slug Claude Code derives from a working directory: every non-alphanumeric run becomes `-`. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]+/g, '-');
}

export function transcriptPath(cwd: string, sessionId: string, claudeDir: string = CLAUDE_DIR): string {
  return join(claudeDir, 'projects', projectSlug(cwd), `${sessionId}.jsonl`);
}

/** Every record in the sessions registry; unreadable files are skipped. */
export function readSessionRegistry(claudeDir: string = CLAUDE_DIR): PeerRecord[] {
  const dir = join(claudeDir, 'sessions');
  if (!existsSync(dir)) return [];
  const out: PeerRecord[] = [];
  for (const file of readdirSync(dir)) {
    if (!/^\d+\.json$/.test(file)) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, file), 'utf8')) as PeerRecord;
      if (typeof rec.pid === 'number' && typeof rec.sessionId === 'string') out.push(rec);
    } catch {
      // a half-written record: skip it this pass
    }
  }
  return out.sort((a, b) => a.pid - b.pid);
}

/** Whether a pid is alive, by signal 0. Injected in tests. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function textOf(content: unknown): { text: string; toolUse: boolean; toolResult: boolean } {
  if (typeof content === 'string') return { text: content, toolUse: false, toolResult: false };
  if (!Array.isArray(content)) return { text: '', toolUse: false, toolResult: false };
  const texts: string[] = [];
  let toolUse = false;
  let toolResult = false;
  for (const block of content as Array<{ type?: string; text?: string }>) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    if (block?.type === 'tool_use') toolUse = true;
    if (block?.type === 'tool_result') toolResult = true;
  }
  return { text: texts.join('\n').trim(), toolUse, toolResult };
}

/**
 * Read a transcript: the assistant turns in order (the stream the panel
 * shows), the newest activity, the title and the branch. `tail` keeps the
 * last N turns. A line that is not JSON is skipped.
 */
export function readTranscript(path: string, opts: { tail?: number } = {}): TranscriptSummary | null {
  if (!existsSync(path)) return null;
  const summary: TranscriptSummary = { sessionId: '', cwd: null, gitBranch: null, title: null, lastPrompt: null, lastActivityAt: null, tail: null, turns: [] };
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof o.sessionId === 'string' && !summary.sessionId) summary.sessionId = o.sessionId;
    if (typeof o.cwd === 'string') summary.cwd = o.cwd;
    if (typeof o.gitBranch === 'string') summary.gitBranch = o.gitBranch;
    if (o.type === 'ai-title' && typeof o.aiTitle === 'string') summary.title = o.aiTitle;
    if (o.type === 'last-prompt' && typeof o.lastPrompt === 'string') summary.lastPrompt = o.lastPrompt;
    if (typeof o.timestamp === 'string') {
      const t = Date.parse(o.timestamp);
      if (Number.isFinite(t) && (summary.lastActivityAt === null || t > summary.lastActivityAt)) summary.lastActivityAt = t;
    }
    const message = o.message as { role?: string; content?: unknown } | undefined;
    if ((o.type === 'assistant' || o.type === 'user') && message && o.isSidechain !== true) {
      const { text, toolUse, toolResult } = textOf(message.content);
      if (o.type === 'assistant') {
        summary.tail = toolUse ? 'assistant-tool' : 'assistant-text';
        if (text || toolUse) summary.turns.push({ uuid: String(o.uuid ?? ''), role: 'assistant', text, timestamp: String(o.timestamp ?? ''), toolUse });
      } else {
        summary.tail = toolResult ? 'user-tool-result' : 'user-prompt';
        if (!toolResult && text) summary.turns.push({ uuid: String(o.uuid ?? ''), role: 'user', text, timestamp: String(o.timestamp ?? '') });
      }
    }
  }
  if (opts.tail !== undefined && summary.turns.length > opts.tail) summary.turns = summary.turns.slice(-opts.tail);
  return summary;
}

export const IDLE_AFTER_MS = 5 * 60 * 1000;

/**
 * Busy, idle or stopped: a dead process is stopped; a live one is busy while
 * its newest entry is a tool call or a tool result, or an assistant text
 * written in the last few seconds; a turn that ended at the prompt is idle,
 * and so is a transcript quiet for `idleAfterMs`.
 */
export function inferState(input: { alive: boolean; registryStatus?: string; tail: TranscriptSummary['tail']; lastActivityAt: number | null }, now: number, idleAfterMs: number = IDLE_AFTER_MS): AgentState {
  if (!input.alive) return 'stopped';
  const since = input.lastActivityAt === null ? Number.POSITIVE_INFINITY : now - input.lastActivityAt;
  if (since >= idleAfterMs) return 'idle';
  if (input.tail === 'assistant-tool' || input.tail === 'user-tool-result' || input.tail === 'user-prompt') return 'busy';
  if (input.tail === 'assistant-text') return since < 5_000 ? 'busy' : 'idle';
  return input.registryStatus === 'busy' ? 'busy' : 'idle';
}

/** The roster at `now`: the registry joined with each session's transcript. */
export function roster(
  now: number,
  opts: { claudeDir?: string; alive?: (pid: number) => boolean; records?: PeerRecord[]; idleAfterMs?: number; selfPid?: number } = {}
): Roster {
  const claudeDir = opts.claudeDir ?? CLAUDE_DIR;
  const alive = opts.alive ?? processAlive;
  const records = opts.records ?? readSessionRegistry(claudeDir);
  const agents: Agent[] = [];
  for (const rec of records) {
    if (rec.kind === 'daemon' || rec.kind === 'daemon-worker' || rec.pid === opts.selfPid) continue;
    const cwd = rec.cwd ?? '';
    const path = cwd ? transcriptPath(cwd, rec.sessionId, claudeDir) : null;
    const transcript = path ? readTranscript(path, { tail: 0 }) : null;
    const lastActivityAt = transcript?.lastActivityAt ?? (path && existsSync(path) ? statSync(path).mtimeMs : null) ?? rec.updatedAt ?? null;
    const isAlive = alive(rec.pid);
    agents.push({
      name: rec.name ?? rec.sessionId,
      sessionId: rec.sessionId,
      pid: rec.pid,
      cwd,
      mode: rec.kind === 'bg' ? 'background' : 'interactive',
      state: inferState({ alive: isAlive, registryStatus: rec.status, tail: transcript?.tail ?? null, lastActivityAt }, now, opts.idleAfterMs),
      sinceActivityMs: lastActivityAt === null ? null : Math.max(0, now - lastActivityAt),
      lastActivityAt,
      title: transcript?.title ?? null,
      branch: transcript?.gitBranch ?? null,
      socket: rec.messagingSocketPath ?? null,
      transcriptPath: path,
    });
  }
  agents.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.name.localeCompare(b.name));
  return { asOf: now, agents };
}
