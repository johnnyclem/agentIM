/**
 * Subprocesses (spec §2.5, "all subprocess helpers"). One injected runner so
 * tests see the exact argv and nothing shells out through a string.
 */

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** Milliseconds before the child is killed; 0 or absent means none. */
  timeoutMs?: number;
}

export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

/** Run a command: stdin is the null device, stdout and stderr are drained concurrently, a bad cwd is an error before launch. */
export const runCommand: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    if (opts.cwd) {
      try {
        if (!statSync(opts.cwd).isDirectory()) throw new Error('not a directory');
      } catch {
        reject(new Error(`${opts.cwd} is not an existing directory`));
        return;
      }
    }
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill(), opts.timeoutMs) : null;
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

/** The merged output of a failed run, or "exit N" when it printed nothing. */
export function failureText(r: RunResult): string {
  const out = (r.stdout + r.stderr).trim();
  return out || `exit ${r.code}`;
}

/** Strip ANSI SGR and other CSI sequences: the CLI colors some lines even when piped. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}
