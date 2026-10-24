/**
 * Spawning and controlling sessions through the CLI (spec §2.5, §4.6):
 * background spawn with the job id parsed from the "backgrounded" line,
 * resume, stop, send-as-me (stop, wait, resume with the text as the prompt,
 * after re-checking the roster), the Terminal opener, and the git checks
 * behind the worktree chore button.
 */

import { chmod, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { randomUUID } from 'node:crypto';
import { type Agent, isStopped, shortID, projectName } from './agent.js';
import { failureText, stripAnsi, type Runner } from './runner.js';
import type { WorktreeFinding } from './status-report.js';
import type { Clock } from './clock.js';

export type SpawnerErrorKind = 'claude-not-found' | 'bad-directory' | 'launch-failed' | 'no-job-id' | 'still-running' | 'not-idle';

export class SpawnerError extends Error {
  constructor(
    readonly kind: SpawnerErrorKind,
    message: string
  ) {
    super(message);
  }
}

export const CLAUDE_NOT_FOUND = 'Couldn’t find the `claude` CLI. Set its path in Settings.';

/** The CLI path: a Settings value, else the first `claude` on PATH or in the usual places; null when none. */
export function resolveClaude(settingsPath?: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (settingsPath && existsSync(settingsPath)) return settingsPath;
  const candidates = [...(env.PATH ?? '').split(delimiter).filter(Boolean).map((d) => join(d, 'claude')), join(homedir(), '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export type PermissionMode = 'bypassPermissions' | 'acceptEdits' | 'dontAsk';

export interface SpawnInput {
  name: string;
  cwd: string;
  permissionMode: PermissionMode;
  model?: string;
  prompt: string;
}

/** `claude --bg --name <name> --permission-mode <mode> [--model <id>] <prompt>`. `--session-id` is ignored with `--bg` (CLI 2.1.285). */
export function spawnArgs(input: SpawnInput): string[] {
  return ['--bg', '--name', input.name, '--permission-mode', input.permissionMode, ...(input.model ? ['--model', input.model] : []), input.prompt];
}

/** The hex job id from the "backgrounded" line, fields separated by a middle dot; null when absent. */
export function parseJobID(output: string): string | null {
  for (const raw of stripAnsi(output).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.toLowerCase().startsWith('backgrounded')) continue;
    const fields = line.split('·').map((f) => f.trim());
    const id = fields[1];
    if (id && /^[0-9a-f]+$/i.test(id)) return id;
  }
  return null;
}

/** `claude --bg --resume <sessionId> [--name <name>] -- <prompt>`. `--name` only for an interactive session: a flag forks a background job into a copy. */
export function resumeArgs(agent: Agent, prompt: string): string[] {
  return ['--bg', '--resume', agent.sessionID, ...(agent.kind === 'interactive' ? ['--name', agent.name] : []), '--', prompt];
}

/** Single-quote for a POSIX shell with the standard '\'' escape. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command "Open in Terminal" runs; null for a live interactive session, which has a terminal already. */
export function terminalCommand(agent: Agent): string | null {
  if (!isStopped(agent) && agent.kind === 'interactive') return null;
  if (!isStopped(agent) && agent.jobID) return `cd ${shellQuote(agent.cwd)} && claude attach ${shellQuote(agent.jobID)}`;
  return `cd ${shellQuote(agent.cwd)} && claude --resume ${shellQuote(agent.sessionID)}`;
}

/** The tooltip text for the Terminal button. */
export function terminalTooltip(agent: Agent): string {
  if (!isStopped(agent) && agent.kind === 'interactive') return `This session is running in a terminal already (pid ${agent.pid})`;
  if (!isStopped(agent) && agent.jobID) return `Opens a terminal and runs claude attach ${agent.jobID}`;
  return `Opens a terminal and runs claude --resume ${shortID(agent)} in ${projectName(agent)}`;
}

export interface SpawnerDeps {
  run: Runner;
  claudeBin: () => string | null;
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  alive: (pid: number) => boolean;
  /** The current roster, re-read before a send-as-me. */
  listAgents: () => Promise<Agent[]>;
  /** Writes an executable script and returns its path. */
  writeScript?: (content: string) => Promise<string>;
  /** Opens a file with the OS default handler. */
  openFile?: (path: string) => Promise<void>;
}

export const STOP_WAIT_MS = 15_000;
export const STOP_POLL_MS = 250;

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function defaultWriteScript(content: string): Promise<string> {
  const path = join(tmpdir(), `agentim-${randomUUID()}.command`);
  await writeFile(path, content, 'utf8');
  await chmod(path, 0o755);
  return path;
}

export class Spawner {
  constructor(private readonly deps: SpawnerDeps) {}

  private bin(): string {
    const b = this.deps.claudeBin();
    if (!b) throw new SpawnerError('claude-not-found', CLAUDE_NOT_FOUND);
    return b;
  }

  private async runClaude(args: string[], cwd: string): Promise<string> {
    const bin = this.bin();
    let r;
    try {
      r = await this.deps.run(bin, args, { cwd, timeoutMs: 60_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not an existing directory/.test(msg)) throw new SpawnerError('bad-directory', `${cwd} is not an existing directory.`);
      throw new SpawnerError('launch-failed', `Couldn’t launch claude: ${msg}`);
    }
    if (r.code !== 0) throw new SpawnerError('launch-failed', `claude ${args[0]} failed: ${failureText(r)}`);
    return r.stdout + r.stderr;
  }

  /** Start a background session; the new session is found later by job id. */
  async spawnBackground(input: SpawnInput): Promise<{ jobID: string; output: string }> {
    const output = await this.runClaude(spawnArgs(input), input.cwd);
    const jobID = parseJobID(output);
    if (!jobID) throw new SpawnerError('no-job-id', `claude did not report a job id. Output: ${output.trim() || '(none)'}`);
    return { jobID, output };
  }

  /** Resume a stopped session in the background with a prompt. */
  async resume(agent: Agent, prompt: string): Promise<void> {
    await this.runClaude(resumeArgs(agent, prompt), agent.cwd);
  }

  /** `claude stop <jobId>`: returns before the process exits. */
  async stop(jobID: string, cwd: string): Promise<void> {
    await this.runClaude(['stop', jobID], cwd);
  }

  /**
   * "Send as me": re-list the roster and confirm the session is still there,
   * idle, the same pid, a background job with a job id; stop it; wait for the
   * pid to disappear; resume it with the text as the prompt, which the
   * transcript records as a human-origin turn.
   */
  async sendAsUserTurn(agent: Agent, prompt: string): Promise<void> {
    const roster = await this.deps.listAgents();
    const fresh = roster.find((a) => a.sessionID === agent.sessionID);
    if (!fresh || isStopped(fresh) || fresh.pid !== agent.pid || fresh.kind !== 'background' || !fresh.jobID || fresh.status !== 'idle') {
      throw new SpawnerError('not-idle', `${agent.name} isn’t idle any more, so nothing was sent.`);
    }
    await this.stop(fresh.jobID, fresh.cwd);
    const deadline = this.deps.clock() + STOP_WAIT_MS;
    while (this.deps.alive(fresh.pid!)) {
      if (this.deps.clock() >= deadline) throw new SpawnerError('still-running', `${agent.name} didn’t stop in time, so nothing was sent.`);
      await this.deps.sleep(STOP_POLL_MS);
    }
    await this.resume(fresh, prompt);
  }

  /** Write a one-line login-shell script and open it with the OS handler: no Automation permission needed. */
  async openInTerminal(agent: Agent): Promise<boolean> {
    const command = terminalCommand(agent);
    if (!command) return false;
    const write = this.deps.writeScript ?? defaultWriteScript;
    const open = this.deps.openFile ?? (async (path: string) => {
      const r = await this.deps.run(process.platform === 'darwin' ? 'open' : 'xdg-open', [path]);
      if (r.code !== 0) throw new SpawnerError('launch-failed', `Couldn’t open a terminal: ${failureText(r)}`);
    });
    const path = await write(`#!/bin/zsh -l\n${command}\n`);
    await open(path);
    return true;
  }
}

/** Dirty working tree and unpushed commits in a directory; null where a check could not run (a missing upstream is unknown, not zero). */
export async function gitWorktreeChecks(cwd: string, run: Runner): Promise<WorktreeFinding> {
  let dirty: boolean | null = null;
  let unpushed: number | null = null;
  try {
    const s = await run('git', ['-C', cwd, 'status', '--porcelain'], { timeoutMs: 20_000 });
    if (s.code === 0) dirty = s.stdout.trim().length > 0;
  } catch {
    dirty = null;
  }
  try {
    const c = await run('git', ['-C', cwd, 'rev-list', '--count', '@{upstream}..HEAD'], { timeoutMs: 20_000 });
    if (c.code === 0 && /^\d+$/.test(c.stdout.trim())) unpushed = Number(c.stdout.trim());
  } catch {
    unpushed = null;
  }
  return { dirty, unpushed };
}
