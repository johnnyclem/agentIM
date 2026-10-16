import { describe, it, expect } from 'vitest';
import { parseRoster, listAgents, RosterPoller } from '../src/roster.js';
import { isMessageable, isStopped, canTakeUserTurn, shortID, projectName } from '../src/agent.js';
import type { Runner } from '../src/runner.js';

const T0 = Date.parse('2026-10-16T12:00:00.000Z');

const rows = [
  { sessionId: 'aaaaaaaa-1', cwd: '/Repos/instrument', pid: 101, kind: 'interactive', name: 'instrument-62', status: 'busy', startedAt: T0 - 60_000 },
  { sessionId: 'bbbbbbbb-2', cwd: '/Repos/instrument', kind: 'background', name: 'MR 1267', startedAt: T0 - 120_000, id: 'bbbbbbbb' },
  { sessionId: 'bbbbbbbb-2', cwd: '/Repos/instrument', pid: 202, kind: 'background', name: 'MR 1267', status: 'idle', startedAt: T0 - 10_000, id: 'bbbbbbbb' },
  { sessionId: 'cccccccc-3', cwd: '/Repos/other', pid: 303, kind: 'interactive', startedAt: T0 - 5_000 },
];

describe('the roster', () => {
  it('dedupes by session id with the live row winning, sorts newest first, joins descriptors, falls back to the short id', () => {
    const agents = parseRoster(JSON.stringify(rows), (pid) => (pid === 101 ? '/tmp/cc-socks/101.sock' : undefined), T0);
    expect(agents.map((a) => a.sessionID)).toEqual(['cccccccc-3', 'bbbbbbbb-2', 'aaaaaaaa-1']);
    const [c, b, a] = agents;
    expect(c.name).toBe('cccccccc');
    expect(isMessageable(c)).toBe(false);
    expect(b).toMatchObject({ pid: 202, jobID: 'bbbbbbbb', status: 'idle', kind: 'background' });
    expect(canTakeUserTurn(b)).toBe(true);
    expect(isStopped(b)).toBe(false);
    expect(a.inboxSocketPath).toBe('/tmp/cc-socks/101.sock');
    expect(isMessageable(a)).toBe(true);
    expect(shortID(a)).toBe('aaaaaaaa');
    expect(projectName(a)).toBe('instrument');
  });
  it('a stopped job with no live row stays stopped and is not messageable', () => {
    const agents = parseRoster(JSON.stringify([rows[1]]), () => '/should/not/be/asked', T0);
    expect(agents).toHaveLength(1);
    expect(isStopped(agents[0])).toBe(true);
    expect(isMessageable(agents[0])).toBe(false);
    expect(canTakeUserTurn(agents[0])).toBe(false);
  });
  it('a non-zero exit or non-JSON output is an error, never an empty list', async () => {
    const failing: Runner = async () => ({ code: 1, stdout: '', stderr: 'boom' });
    await expect(listAgents({ run: failing, claudeBin: 'claude' })).rejects.toThrow(/boom/);
    const garbage: Runner = async () => ({ code: 0, stdout: 'not json', stderr: '' });
    await expect(listAgents({ run: garbage, claudeBin: 'claude' })).rejects.toThrow(/not JSON/);
    expect(() => parseRoster('{}', () => undefined, T0)).toThrow(/array/);
  });
  it('passes the exact argv', async () => {
    const calls: string[][] = [];
    const run: Runner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: '[]', stderr: '' };
    };
    expect(await listAgents({ run, claudeBin: '/opt/bin/claude', sessionsDir: '/nowhere' })).toEqual([]);
    expect(calls).toEqual([['/opt/bin/claude', 'agents', '--json', '--all']]);
  });
});

describe('the roster poller', () => {
  it('keeps the previous agents on a failed read, clears them when the CLI is missing, and reports clean reads only', async () => {
    let fail = false;
    let cli: string | null = 'claude';
    const list = async () => {
      if (fail) throw new Error('transient');
      return parseRoster(JSON.stringify([rows[0]]), () => undefined, T0);
    };
    const poller = new RosterPoller({ list, resolveCli: () => cli, sleep: async () => undefined });
    const clean: number[] = [];
    poller.onClean((a) => clean.push(a.length));
    expect(poller.hasLoaded).toBe(false);
    await poller.refresh();
    expect(poller.agents).toHaveLength(1);
    expect(poller.hasLoaded).toBe(true);
    fail = true;
    await poller.refresh();
    expect(poller.agents).toHaveLength(1);
    expect(poller.lastError).toBe('transient');
    expect(clean).toEqual([1]);
    cli = null;
    await poller.refresh();
    expect(poller.agents).toEqual([]);
    expect(poller.lastError).toMatch(/Couldn.t find the `claude` CLI/);
  });
  it('polls until aborted', async () => {
    let n = 0;
    const ctrl = new AbortController();
    const poller = new RosterPoller({
      list: async () => {
        n++;
        if (n === 3) ctrl.abort();
        return [];
      },
      resolveCli: () => 'claude',
      sleep: async () => undefined,
    });
    await poller.poll(ctrl.signal, 0);
    expect(n).toBe(3);
  });
});
