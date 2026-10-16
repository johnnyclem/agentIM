import { describe, it, expect } from 'vitest';
import { spawnInteractive, spawnBackground, openInTerminal, listWorktrees, tmuxSessionName, type Runner } from '../src/spawn.js';

function fakeRunner(responses: Record<string, { code?: number; stdout?: string; stderr?: string; pid?: number }> = {}) {
  const calls: Array<{ cmd: string; args: string[]; opts: { cwd?: string; detached?: boolean } }> = [];
  const run: Runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const r = responses[cmd + ' ' + args.slice(0, 3).join(' ')] ?? responses[cmd] ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', pid: r.pid };
  };
  return { run, calls };
}

describe('starting agents', () => {
  it('starts an interactive agent in a detached tmux session named after it, with the prompt as the first argument', async () => {
    const { run, calls } = fakeRunner();
    const r = await spawnInteractive({ agent: 'instrument 67', cwd: '/Repos/instrument', prompt: 'fix CI' }, run);
    expect(r.tmuxSession).toBe('agentim-instrument-67');
    expect(calls).toEqual([{ cmd: 'tmux', args: ['new-session', '-d', '-s', 'agentim-instrument-67', '-c', '/Repos/instrument', 'claude', 'fix CI'], opts: {} }]);
  });

  it('reports a tmux refusal', async () => {
    const { run } = fakeRunner({ tmux: { code: 1, stderr: 'duplicate session' } });
    await expect(spawnInteractive({ agent: 'a', cwd: '/r' }, run)).rejects.toThrow(/duplicate session/);
  });

  it('opens a Terminal.app window attached to the tmux session', async () => {
    const { run, calls } = fakeRunner();
    await openInTerminal('instrument-62', run);
    expect(calls[0].cmd).toBe('osascript');
    expect(calls[0].args[1]).toContain(`tmux attach -t ${tmuxSessionName('instrument-62')}`);
  });

  it('starts a background agent in a worktree of its own, then claude -p detached there', async () => {
    const { run, calls } = fakeRunner({ claude: { pid: 4242 } });
    const r = await spawnBackground({ agent: 'MR 1267', repo: '/Repos/instrument', briefing: 'resolve the conflicts', worktreesDir: '/wt' }, run);
    expect(r).toEqual({ worktree: '/wt/MR-1267', branch: 'agentim/MR-1267', pid: 4242 });
    expect(calls[0]).toEqual({ cmd: 'git', args: ['-C', '/Repos/instrument', 'worktree', 'add', '-b', 'agentim/MR-1267', '/wt/MR-1267'], opts: {} });
    expect(calls[1].cmd).toBe('claude');
    expect(calls[1].args.slice(0, 2)).toEqual(['-p', 'resolve the conflicts']);
    expect(calls[1].opts).toEqual({ cwd: '/wt/MR-1267', detached: true });
  });

  it('lists worktrees with merged and dirty state, leaving the main checkout out', async () => {
    const { run } = fakeRunner({
      'git -C /repo worktree': { stdout: 'worktree /repo\nbranch refs/heads/main\n\nworktree /wt/a\nbranch refs/heads/done\n\nworktree /wt/b\nbranch refs/heads/wip\n' },
      'git -C /repo branch': { stdout: 'main\ndone\n' },
      'git -C /wt/b status': { stdout: ' M file.ts\n' },
    });
    const wts = await listWorktrees('/repo', 'main', run);
    expect(wts).toEqual([
      { path: '/wt/a', branch: 'done', merged: true, dirty: false },
      { path: '/wt/b', branch: 'wip', merged: false, dirty: true },
    ]);
  });
});
