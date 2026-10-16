/**
 * Starting agents. Interactive agents run `claude` inside a tmux session the
 * panel can "open in terminal"; background agents run `claude -p` headless
 * in a git worktree of their own, one per task. Every command is built here
 * and run through an injected runner, so tests see the exact argv and the
 * daemon never shells out through a string.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { join } from 'node:path';

export type Runner = (cmd: string, args: string[], opts: { cwd?: string; detached?: boolean }) => Promise<{ code: number; stdout: string; stderr: string; pid?: number }>;

export const runCommand: Runner = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = nodeSpawn(cmd, args, { cwd: opts.cwd, detached: opts.detached ?? false, stdio: opts.detached ? 'ignore' : ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    if (opts.detached) {
      child.unref();
      resolve({ code: 0, stdout: '', stderr: '', pid: child.pid });
      return;
    }
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr, pid: child.pid }));
  });

export const tmuxSessionName = (agent: string) => `agentim-${agent.replace(/[^A-Za-z0-9_-]+/g, '-')}`;

/** Start an interactive agent: `claude` in a detached tmux session, in `cwd`, with an optional first prompt. */
export async function spawnInteractive(input: { agent: string; cwd: string; prompt?: string; claudeBin?: string }, run: Runner = runCommand): Promise<{ tmuxSession: string }> {
  const session = tmuxSessionName(input.agent);
  const claude = [input.claudeBin ?? 'claude', ...(input.prompt ? [input.prompt] : [])];
  const r = await run('tmux', ['new-session', '-d', '-s', session, '-c', input.cwd, ...claude], {});
  if (r.code !== 0) throw new Error(`tmux refused to start ${session}: ${r.stderr.trim() || `exit ${r.code}`}`);
  return { tmuxSession: session };
}

/** The "open in terminal" button on macOS: a Terminal.app window attached to the agent's tmux session. */
export async function openInTerminal(agent: string, run: Runner = runCommand): Promise<void> {
  const session = tmuxSessionName(agent);
  const script = `tell application "Terminal" to do script "tmux attach -t ${session}"`;
  const r = await run('osascript', ['-e', script, '-e', 'tell application "Terminal" to activate'], {});
  if (r.code !== 0) throw new Error(`could not open a terminal for ${session}: ${r.stderr.trim() || `exit ${r.code}`}`);
}

/** Start a background agent: a worktree of its own, then `claude -p <briefing>` headless there. */
export async function spawnBackground(
  input: { agent: string; repo: string; briefing: string; worktreesDir: string; branch?: string; claudeBin?: string },
  run: Runner = runCommand
): Promise<{ worktree: string; branch: string; pid?: number }> {
  const branch = input.branch ?? `agentim/${input.agent.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
  const worktree = join(input.worktreesDir, input.agent.replace(/[^A-Za-z0-9_-]+/g, '-'));
  const wt = await run('git', ['-C', input.repo, 'worktree', 'add', '-b', branch, worktree], {});
  if (wt.code !== 0) throw new Error(`git worktree add failed: ${wt.stderr.trim() || `exit ${wt.code}`}`);
  const r = await run(input.claudeBin ?? 'claude', ['-p', input.briefing, '--output-format', 'stream-json', '--verbose'], { cwd: worktree, detached: true });
  return { worktree, branch, pid: r.pid };
}

/** Worktrees of a repository with their merge and cleanliness state: the status report's "left behind" list. */
export async function listWorktrees(repo: string, baseBranch: string, run: Runner = runCommand): Promise<Array<{ path: string; branch: string; merged: boolean; dirty: boolean }>> {
  const list = await run('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {});
  if (list.code !== 0) return [];
  const out: Array<{ path: string; branch: string; merged: boolean; dirty: boolean }> = [];
  let current: { path?: string; branch?: string } = {};
  const flush = async () => {
    if (!current.path) return;
    const branch = (current.branch ?? '').replace(/^refs\/heads\//, '');
    const merged = branch ? (await run('git', ['-C', repo, 'branch', '--merged', baseBranch, '--format=%(refname:short)'], {})).stdout.split('\n').map((s) => s.trim()).includes(branch) : true;
    const dirty = (await run('git', ['-C', current.path, 'status', '--porcelain'], {})).stdout.trim().length > 0;
    out.push({ path: current.path, branch, merged, dirty });
    current = {};
  };
  for (const line of list.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      await flush();
      current.path = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).trim();
  }
  await flush();
  return out.filter((w) => w.path !== repo);
}
