import { describe, it, expect } from 'vitest';
import { Spawner, spawnArgs, parseJobID, resumeArgs, shellQuote, terminalCommand, gitWorktreeChecks, resolveClaude, STOP_WAIT_MS } from '../src/spawner.js';
import type { Agent } from '../src/agent.js';
import type { Runner } from '../src/runner.js';

const T0 = Date.parse('2026-10-16T12:00:00.000Z');
const agent = (over: Partial<Agent> = {}): Agent => ({ sessionID: 'abcdef12-3456', pid: 500, jobID: 'abcdef12', name: 'MR 1364', cwd: '/Repos/instrument', kind: 'background', status: 'idle', startedAt: T0, inboxSocketPath: '/tmp/500.sock', ...over });

function fake(responses: Record<string, Partial<{ code: number; stdout: string; stderr: string }>> = {}) {
  const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
  const run: Runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    const key = Object.keys(responses).find((k) => `${cmd} ${args.join(' ')}`.startsWith(k));
    const r = key ? responses[key] : {};
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { run, calls };
}

describe('the spawner', () => {
  it('builds the spawn, resume and terminal commands exactly', () => {
    expect(spawnArgs({ name: 'docs sweep', cwd: '/r', permissionMode: 'acceptEdits', model: 'claude-sonnet-5-5', prompt: 'go' })).toEqual(['--bg', '--name', 'docs sweep', '--permission-mode', 'acceptEdits', '--model', 'claude-sonnet-5-5', 'go']);
    expect(spawnArgs({ name: 'n', cwd: '/r', permissionMode: 'dontAsk', prompt: 'p' })).toEqual(['--bg', '--name', 'n', '--permission-mode', 'dontAsk', 'p']);
    expect(resumeArgs(agent({ kind: 'interactive', pid: undefined }), 'wake')).toEqual(['--bg', '--resume', 'abcdef12-3456', '--name', 'MR 1364', '--', 'wake']);
    expect(resumeArgs(agent({ pid: undefined }), 'wake')).toEqual(['--bg', '--resume', 'abcdef12-3456', '--', 'wake']); // a flag would fork a background job
    expect(shellQuote(`it's a "test"`)).toBe(`'it'\\''s a "test"'`);
    expect(terminalCommand(agent())).toBe(`cd '/Repos/instrument' && claude attach 'abcdef12'`);
    expect(terminalCommand(agent({ pid: undefined, jobID: undefined }))).toBe(`cd '/Repos/instrument' && claude --resume 'abcdef12-3456'`);
    expect(terminalCommand(agent({ kind: 'interactive', jobID: undefined }))).toBeNull();
  });

  it('parses the job id from the colored "backgrounded" line and fails without one', async () => {
    expect(parseJobID('\x1b[32mbackgrounded\x1b[0m · \x1b[1m3fa9c1\x1b[0m · MR 1364\n')).toBe('3fa9c1');
    expect(parseJobID('Backgrounded · ABC123 · x')).toBe('ABC123');
    expect(parseJobID('backgrounded · not-hex · x')).toBeNull();
    expect(parseJobID('nothing here')).toBeNull();
    const { run, calls } = fake({ 'claude --bg': { stdout: 'backgrounded · 3fa9c1 · docs' } });
    const s = new Spawner({ run, claudeBin: () => 'claude', clock: () => T0, sleep: async () => undefined, alive: () => false, listAgents: async () => [] });
    expect(await s.spawnBackground({ name: 'docs', cwd: '/r', permissionMode: 'bypassPermissions', prompt: 'write them' })).toMatchObject({ jobID: '3fa9c1' });
    expect(calls[0]).toEqual({ cmd: 'claude', args: ['--bg', '--name', 'docs', '--permission-mode', 'bypassPermissions', 'write them'], cwd: '/r' });
    const none = new Spawner({ run: fake({ 'claude --bg': { stdout: 'started something' } }).run, claudeBin: () => 'claude', clock: () => T0, sleep: async () => undefined, alive: () => false, listAgents: async () => [] });
    await expect(none.spawnBackground({ name: 'n', cwd: '/r', permissionMode: 'dontAsk', prompt: 'p' })).rejects.toMatchObject({ kind: 'no-job-id' });
    const missing = new Spawner({ run, claudeBin: () => null, clock: () => T0, sleep: async () => undefined, alive: () => false, listAgents: async () => [] });
    await expect(missing.resume(agent(), 'x')).rejects.toMatchObject({ kind: 'claude-not-found' });
  });

  it('send-as-me: re-lists the roster, aborts when the session is no longer idle or has a new pid, else stops, waits and resumes', async () => {
    const a = agent();
    let now = T0;
    let alive = true;
    let roster: Agent[] = [a];
    const { run, calls } = fake();
    const s = new Spawner({
      run,
      claudeBin: () => 'claude',
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
        if (now - T0 > 1000) alive = false;
      },
      alive: () => alive,
      listAgents: async () => roster,
    });
    await s.sendAsUserTurn(a, 'as me');
    expect(calls.map((c) => c.args.slice(0, 3))).toEqual([
      ['stop', 'abcdef12'],
      ['--bg', '--resume', 'abcdef12-3456'],
    ]);
    expect(calls[1].args).not.toContain('--name');
    expect(calls[1].args.at(-1)).toBe('as me');
    roster = [{ ...a, status: 'busy' }];
    await expect(s.sendAsUserTurn(a, 'x')).rejects.toMatchObject({ kind: 'not-idle' });
    roster = [{ ...a, pid: 501 }];
    await expect(s.sendAsUserTurn(a, 'x')).rejects.toMatchObject({ kind: 'not-idle' });
    roster = [{ ...a, kind: 'interactive' }];
    await expect(s.sendAsUserTurn(a, 'x')).rejects.toMatchObject({ kind: 'not-idle' });
    roster = [];
    await expect(s.sendAsUserTurn(a, 'x')).rejects.toMatchObject({ kind: 'not-idle' });
    // Never exits: still-running after the 15 s wait, nothing resumed
    roster = [a];
    alive = true;
    now = T0;
    const stuck = new Spawner({ run, claudeBin: () => 'claude', clock: () => now, sleep: async (ms) => void (now += ms), alive: () => true, listAgents: async () => roster });
    const before = calls.length;
    await expect(stuck.sendAsUserTurn(a, 'x')).rejects.toMatchObject({ kind: 'still-running' });
    expect(now - T0).toBeGreaterThanOrEqual(STOP_WAIT_MS);
    expect(calls.slice(before).map((c) => c.args[0])).toEqual(['stop']);
  });

  it('opens a terminal by writing a login-shell script and opening it; a live interactive session needs none', async () => {
    const written: string[] = [];
    const opened: string[] = [];
    const s = new Spawner({ run: fake().run, claudeBin: () => 'claude', clock: () => T0, sleep: async () => undefined, alive: () => false, listAgents: async () => [], writeScript: async (c) => (written.push(c), '/tmp/x.command'), openFile: async (p) => void opened.push(p) });
    expect(await s.openInTerminal(agent())).toBe(true);
    expect(written).toEqual([`#!/bin/zsh -l\ncd '/Repos/instrument' && claude attach 'abcdef12'\n`]);
    expect(opened).toEqual(['/tmp/x.command']);
    expect(await s.openInTerminal(agent({ kind: 'interactive', jobID: undefined }))).toBe(false);
  });

  it('git checks: dirty from porcelain, unpushed from the upstream count, unknown when a check cannot run', async () => {
    expect(await gitWorktreeChecks('/w', fake({ 'git -C /w status': { stdout: ' M a.ts\n' }, 'git -C /w rev-list': { stdout: '2\n' } }).run)).toEqual({ dirty: true, unpushed: 2 });
    expect(await gitWorktreeChecks('/w', fake({ 'git -C /w rev-list': { code: 128, stderr: 'no upstream' } }).run)).toEqual({ dirty: false, unpushed: null });
    expect(await gitWorktreeChecks('/w', fake({ 'git -C /w status': { code: 128 }, 'git -C /w rev-list': { stdout: '0' } }).run)).toEqual({ dirty: null, unpushed: 0 });
    const throwing: Runner = async () => {
      throw new Error('no git');
    };
    expect(await gitWorktreeChecks('/w', throwing)).toEqual({ dirty: null, unpushed: null });
  });

  it('resolves the CLI from Settings first, then PATH, else null', () => {
    expect(resolveClaude('/definitely/not/here', { PATH: '/nope' })).toBeNull();
    expect(resolveClaude(process.execPath, { PATH: '' })).toBe(process.execPath);
  });
});
