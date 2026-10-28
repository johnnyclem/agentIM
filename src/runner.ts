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
  /** True when stdout passed `maxOutputBytes`: the child was killed, `code` is 1 and `stdout` is what was collected up to the cap. Absent otherwise. */
  truncated?: boolean;
  /** True when `timeoutMs` elapsed and the child was killed. Absent otherwise. */
  timedOut?: boolean;
}

export interface RunOptions {
  cwd?: string;
  /** Milliseconds before the child is killed; 0 or absent means none. */
  timeoutMs?: number;
  /** Bytes of stdout kept; 0 or absent means no cap. One byte more and the child is killed, nothing further is buffered and the result is `truncated`. */
  maxOutputBytes?: number;
}

export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

/** Run a command: stdin is the null device, stdout and stderr are drained concurrently, a bad cwd is an error before launch. A timeout or an output cap kills the child and says so on the result. */
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
    let kept = 0;
    let truncated = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // First, before anything can throw: a failed spawn (EMFILE, ENOENT) hands back a child with no stdio and emits 'error' later; with no listener that kills the process.
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    const cap = opts.maxOutputBytes !== undefined && opts.maxOutputBytes > 0 ? opts.maxOutputBytes : 0;
    child.stdout?.on('data', (d) => {
      if (truncated) return; // killed: whatever is still in the pipe is dropped, not buffered
      if (cap > 0 && kept + d.length > cap) {
        truncated = true;
        stdout += d.subarray(0, cap - kept).toString();
        child.kill();
        return;
      }
      kept += d.length;
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, opts.timeoutMs);
    }
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: truncated ? 1 : (code ?? 1), stdout, stderr, ...(truncated && { truncated }), ...(timedOut && { timedOut }) });
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
