/**
 * A demo hub: fake agents, fake transcripts and canned replies, so the panel
 * can be clicked through (and tested in a browser) with no Claude Code
 * running. `agentim serve --demo`. Nothing here touches the disk, the
 * network or a real `claude`.
 */

import { Hub } from './hub.js';
import { MemoryKV } from './store.js';
import { transcriptPath } from './transcript.js';
import { STATUS_ASK_MARKER } from './prompts.js';
import type { Agent, Turn } from './agent.js';

const CLAUDE_DIR = '/demo/claude';
const MIN = 60_000;

const statusBlock = (lines: string[]): string => '```cim-status\n' + lines.join('\n') + '\n```';

export function demoHub(): Hub {
  const t0 = Date.now();
  const agents: Agent[] = [
    { sessionID: 'a1b2c3d4-0001', pid: 4101, name: 'instrument-62', cwd: '/Users/you/Repos/instrument', kind: 'interactive', status: 'busy', startedAt: t0 - 185 * MIN, inboxSocketPath: '/demo/4101.sock' },
    { sessionID: 'b2c3d4e5-0002', pid: 4102, jobID: 'b2c3d4e5', name: 'MR !1267 merge conflicts', cwd: '/Users/you/Repos/instrument', kind: 'background', status: 'idle', startedAt: t0 - 95 * MIN, inboxSocketPath: '/demo/4102.sock' },
    { sessionID: 'c3d4e5f6-0003', pid: 4103, name: 'docs sweep', cwd: '/Users/you/Repos/wiki', kind: 'interactive', status: 'idle', startedAt: t0 - 40 * MIN, inboxSocketPath: '/demo/4103.sock' },
    { sessionID: 'd4e5f6a7-0004', jobID: 'd4e5f6a7', name: 'flaky test fixer', cwd: '/Users/you/Repos/instrument', kind: 'background', startedAt: t0 - 600 * MIN },
    { sessionID: 'e5f6a7b8-0005', pid: 4105, name: 'scratch', cwd: '/Users/you/Scratch', kind: 'interactive', status: 'idle', startedAt: t0 - 5 * MIN },
  ];
  const files = new Map<string, Turn[]>();
  const path = (a: Agent) => transcriptPath(a.cwd, a.sessionID, CLAUDE_DIR);
  let seq = 0;
  const say = (a: Agent, role: 'user' | 'assistant', text: string) => {
    const list = files.get(path(a)) ?? [];
    list.push({ id: `demo-${++seq}`, role, text, timestamp: Date.now() });
    files.set(path(a), list);
  };
  const byName = (n: string) => agents.find((a) => a.name === n)!;

  say(byName('instrument-62'), 'user', 'The QP-27110 swift split: where are we?');
  say(byName('instrument-62'), 'assistant', 'Two modules extracted, tests green on both. Next is the shared fixtures target. One thing to watch in a log line I saw: <script>alert("not a script")</script> and <img src=x onerror=alert(1)>, both shown as plain text.');
  say(byName('MR !1267 merge conflicts'), 'assistant', 'Resolved 4 of 5 conflicts. Package.swift needs a decision about the minimum deployment target.');
  say(byName('docs sweep'), 'assistant', 'The API reference pages are rewritten. Journal entry written to the wiki.');
  say(byName('flaky test fixer'), 'assistant', 'Stopped for the day. Two retries left in the CI log.');

  const respond = (a: Agent, text: string) => {
    const delay = 500 + Math.random() * 800;
    setTimeout(() => {
      if (text.includes(STATUS_ASK_MARKER)) {
        if (a.name === 'instrument-62') say(a, 'assistant', statusBlock(['scope: QP-27110 swift split', 'status: working', 'remaining:', '- extract the shared fixtures target', '- update the CI matrix']));
        else if (a.name === 'MR !1267 merge conflicts') say(a, 'assistant', statusBlock(['scope: MR !1267', 'status: waiting_for_human', 'remaining:', '- Package.swift: pick the minimum deployment target', 'wiki_journaled: false', 'worktrees_cleaned: false']));
        else if (a.name === 'docs sweep') say(a, 'assistant', statusBlock(['scope: API reference rewrite', 'status: done', 'remaining: nothing', 'wiki_journaled: true', 'worktrees_cleaned: false', 'tb_uv_cleared: true', 'wiki_entry: journal/2026-10-24-docs-sweep.md', 'tb_uv_refs:', '- TB-0042', '- UV-0007']));
        else say(a, 'assistant', 'Nothing in flight here, just a scratch shell.');
      } else if (text.includes('cim-volunteer')) {
        if (a.name === 'instrument-62') say(a, 'assistant', '```cim-volunteer\nvolunteer: yes\ncontext: I touched that module yesterday\n```');
        else if (a.name === 'MR !1267 merge conflicts') say(a, 'assistant', '```cim-volunteer\nvolunteer: no\ncontext: mid-merge on MR !1267\n```');
        // docs sweep and scratch stay silent, to show the busy/offline marks
      } else if (text.includes('pausing every running agent')) say(a, 'assistant', 'Stopped at the next safe point: nothing half-done.');
      else if (text.includes('Journal this session') || text.includes('Clean up')) say(a, 'assistant', 'On it.');
      else say(a, 'assistant', `Got it. (${a.name} is a demo agent, so this is a canned reply.)`);
    }, delay);
  };

  const run = async (cmd: string, args: string[]) => {
    if (cmd === 'git' && args.includes('show') && args.some((x) => x.endsWith('tombstones.jsonl'))) return { code: 0, stdout: '{"id":"TB-0042","date":"2026-10-01","claim":"the v1 export endpoint is removed","superseded_by":"TB-0051"}\n', stderr: '' };
    if (cmd === 'git' && args.includes('show') && args.some((x) => x.endsWith('unverified.jsonl'))) return { code: 0, stdout: '{"id":"UV-0007","date":"2026-10-12","claim":"CI cache key includes the lockfile","doubt":"never checked against a cold run"}\n', stderr: '' };
    if (args[0] === '--bg' && args.includes('--resume')) {
      const sid = args[args.indexOf('--resume') + 1];
      const a = agents.find((x) => x.sessionID === sid);
      if (a) setTimeout(() => ((a.pid = 4200 + seq), (a.inboxSocketPath = `/demo/${a.pid}.sock`), (a.status = 'idle')), 1200);
      return { code: 0, stdout: 'resumed', stderr: '' };
    }
    if (args[0] === '--bg') {
      const name = args[args.indexOf('--name') + 1] ?? 'new agent';
      const jobID = (0xcafe00 + seq++).toString(16);
      setTimeout(() => agents.push({ sessionID: `${jobID}-demo`, pid: 4300 + seq, jobID, name, cwd: '/Users/you/Repos/instrument', kind: 'background', status: 'busy', startedAt: Date.now(), inboxSocketPath: `/demo/${4300 + seq}.sock` }), 1500);
      return { code: 0, stdout: `backgrounded · ${jobID} · ${name}`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  return new Hub({
    kv: new MemoryKV(),
    run,
    alive: () => true,
    listAgents: async () => agents.map((a) => ({ ...a })),
    sendInbox: async (a, text) => {
      say(a, 'user', `Another Claude session sent a message... ${text}`);
      respond(a, text);
    },
    readTail: async (p) => {
      const turns = files.get(p) ?? [];
      return { turns: turns.slice(-40), endOffset: turns.length, latestModel: 'claude-opus-5-5' };
    },
    readSince: async (p, offset) => {
      const turns = files.get(p) ?? [];
      return { turns: turns.slice(offset), endOffset: turns.length, latestModel: null };
    },
    gitChecks: async () => ({ dirty: true, unpushed: 2 }),
    osUserName: 'you',
    settings: { claudePath: process.execPath, claudeDir: CLAUDE_DIR, repoPath: '/Users/you/Repos/wiki' },
  });
}
