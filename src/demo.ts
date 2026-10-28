/**
 * A demo hub: fake agents, fake transcripts and canned replies, so the panel
 * can be clicked through (and tested in a browser) with no Claude Code
 * running. `agentim serve --demo`. Nothing here touches the disk, the
 * network or a real `claude`; git is a table of canned answers for one
 * invented repo, "instrument", so the Morning Standup and the Lightning Round
 * (ledger rows, branches, grounded and ungrounded cites, a silent panel) can
 * be clicked through too.
 */

import { Hub } from './hub.js';
import { MemoryKV } from './store.js';
import { transcriptPath } from './transcript.js';
import { LIGHTNING_FENCE, STATUS_ASK_MARKER, VOTE_FENCE } from './prompts.js';
import { standupWindow } from './standup.js';
import type { RunResult } from './runner.js';
import type { Agent, Turn } from './agent.js';

const CLAUDE_DIR = '/demo/claude';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const statusBlock = (lines: string[]): string => '```cim-status\n' + lines.join('\n') + '\n```';

// ---- the invented repo ---------------------------------------------------------------------------------------------------

const REPO = '/Users/you/Repos/instrument';
const SHA = '75c7b13e4a9d0c2f6b1a83d5e7f09c4a2b6d8e10';
const SESSION_PATH = 'src/upload/session.ts';
/** 40 lines: the cites in the canned presentations name lines of it, one of them past the end and one of them in a file that is not there. */
const SESSION_TS =
  [
    "import { randomUUID } from 'node:crypto';",
    '',
    '/** One upload session: minted while online, then handed to every retry of the same upload. */',
    'export interface UploadSession {',
    '  id: string;',
    '  createdAt: number;',
    '  online: boolean;',
    '}',
    '',
    'const queue = new Map<string, UploadSession>();',
    '',
    'export function mintSession(online: boolean): UploadSession {',
    '  const session = { id: randomUUID(), createdAt: Date.now(), online };',
    '  queue.set(session.id, session);',
    '  return session;',
    '}',
    '',
    '/** An offline upload reuses the id that was minted while online. */',
    'export function reuseSession(id: string): UploadSession | undefined {',
    '  return queue.get(id);',
    '}',
    '',
    'export function nextFor(upload: { sessionId?: string }, online: boolean): UploadSession {',
    '  if (online || !upload.sessionId) return mintSession(online);',
    '  const queued = reuseSession(upload.sessionId);',
    '  if (!queued) return mintSession(online);',
    '  return queued;',
    '}',
    '',
    'export function drain(uploads: Array<{ sessionId?: string }>): UploadSession[] {',
    '  return uploads.map((u) => nextFor(u, true));',
    '}',
    '',
    'export function forget(id: string): boolean {',
    '  return queue.delete(id);',
    '}',
    '',
    'export function pending(): number {',
    '  return queue.size;',
    '}',
  ].join('\n') + '\n';

/** The ledger and the branches of the demo repo, dated against the standup window so the first standup of any day finds them inside it. */
function repoFixtures(now: number): { refs: string; tombstones: string; unverified: string } {
  const win = standupWindow(now);
  const at = (hoursBeforeEnd: number): number => Math.floor((win.end - hoursBeforeEnd * HOUR) / 1000);
  const daysBefore = (n: number): string => standupWindow(win.start - n * DAY + 12 * HOUR).run;
  const ref = (name: string, hoursBeforeEnd: number, subject: string, remote = false): string =>
    [`refs/${remote ? 'remotes/origin' : 'heads'}/${name}`, at(hoursBeforeEnd), SHA.slice(0, 7), subject].join('\t');
  const refs = [
    ref('main', 1, 'Merge pull request #96'),
    ref('wiki', 2, 'Journal: upload queue notes'),
    ref('SHOP-123-offline-upload-queue', 3, 'SHOP-123: queue offline uploads until a session exists'),
    ref('SHOP-123-offline-upload-queue', 5, 'SHOP-123: queue offline uploads', true),
    ref('feature/QP-27110-swift-split', 4, 'Extract the shared fixtures target'),
    ref('SHOP-123-retry-backoff', 6, 'Back off retries while the queue drains'),
    ref('fix/UP-481-upload-timeout', 8, 'UP-481: raise the upload timeout to 60s'),
    ref('chore/ci-cache-key', 10, 'Key the CI cache on the lockfile hash'),
    ref('docs/api-reference-rewrite', 12, 'Rewrite the API reference pages'),
    ['refs/remotes/origin/HEAD', at(1), SHA.slice(0, 7), 'Merge pull request #96'].join('\t'),
    ['refs/heads/spike/offline-queue', Math.floor((win.start - 20 * DAY) / 1000), SHA.slice(0, 7), 'Spike: an offline queue'].join('\t'),
  ].join('\n');
  const lines = (rows: Array<Record<string, string>>): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const tombstones = lines([
    { id: 'TB-0042', date: '2026-10-01', claim: 'the v1 export endpoint is removed', superseded_by: 'TB-0051' },
    { id: 'TB-0051', date: daysBefore(5), claim: 'the v1 and v1.1 export endpoints are removed', doubt: 'v1.1 still routes in the gateway config', settles_it: 'grep the gateway routes for /v1.1/export', raised_by: 'gateway tracing' },
  ]);
  const unverified = lines([
    { id: 'UV-0036', date: win.covering, claim: 'Offline uploads reuse the session id minted online', doubt: 'the retry path may mint a fresh id when the queue drains', settles_it: 'trace the id through nextFor() and drain() in src/upload/session.ts', raised_by: 'instrument-62' },
    { id: 'UV-0021', date: win.covering, claim: 'Upload retries never exceed three attempts', doubt: 'the limit is read from config in one place and hard-coded in another', settles_it: 'grep for the retry limit and compare the two', raised_by: 'nightly-audit' },
    { id: 'UV-0044', date: win.through, claim: 'The export job is idempotent when it runs twice in one day', doubt: 'the second run appends instead of replacing', settles_it: 'run the job twice against a scratch bucket' },
    { id: 'UV-0007', date: '2026-10-12', claim: 'CI cache key includes the lockfile', doubt: 'never checked against a cold run', settles_it: 'run the pipeline from a cold cache and compare the keys' },
    { id: 'UV-0015', date: daysBefore(9), claim: 'Rate limiting is applied before authentication', doubt: 'the middleware order differs between the two entry points' },
    { id: 'UV-0028', date: daysBefore(14), claim: 'The gateway strips the X-Debug header', doubt: 'no test covers a request that carries it', settles_it: 'send a request with the header to a staging build' },
    { id: 'UV-0009', date: daysBefore(20), claim: 'Thumbnails are generated once per upload', status: 'confirmed' },
  ]);
  return { refs, tombstones, unverified };
}

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const missing = (): RunResult => ({ code: 128, stdout: '', stderr: 'fatal: not found' });

/**
 * What `git -C <dir> <sub> ...rest` answers. The ledger files are shown whatever the directory, as a repo's `wiki` branch is (the docs
 * sweep session works in the wiki folder, which is not a repo here); everything else only for the demo repo itself.
 */
function demoGit(dir: string, sub: string, rest: string[], fixtures: ReturnType<typeof repoFixtures>): RunResult {
  if (sub === 'show' && rest[0] === 'wiki:tombstones.jsonl') return ok(fixtures.tombstones);
  if (sub === 'show' && rest[0] === 'wiki:unverified.jsonl') return ok(fixtures.unverified);
  if (dir !== REPO) return missing();
  if (sub === 'for-each-ref') return ok(fixtures.refs + '\n');
  if (sub === 'rev-parse' && rest[0] === '--git-common-dir') return ok('.git\n');
  if (sub === 'rev-parse' && rest[0] === '--abbrev-ref') return ok('feature/QP-27110-swift-split\n');
  if (sub === 'rev-parse' && rest[0] === '--verify') {
    const name = (rest[2] ?? '').replace(/\^\{commit\}$/, '');
    return name === 'HEAD' || (name.length >= 7 && SHA.startsWith(name)) ? ok(SHA + '\n') : missing();
  }
  const object = (sub === 'cat-file' ? rest[1] : rest[0]) ?? '';
  if (object !== `${SHA}:${SESSION_PATH}`) return missing();
  if (sub === 'show') return ok(SESSION_TS);
  if (sub === 'cat-file') return ok(rest[0] === '-t' ? 'blob\n' : `${Buffer.byteLength(SESSION_TS)}\n`);
  return missing();
}

// ---- the canned Lightning Round replies ----------------------------------------------------------------------------------

/** A message that starts with this is a decision relayed to an agent. */
const DECISION_PREFIX = '[cIM Lightning Round]';
const MR_AGENT = 'MR !1267 merge conflicts';

const fenced = (info: string, lines: string[]): string => ['```' + info, ...lines, '```'].join('\n');

/** The one row with a real story: three cites that check out, one in a file that is not there; options that rest on each. */
const UV_0036 = fenced(LIGHTNING_FENCE, [
  'id: UV-0036',
  'needs: human',
  'nature: decision',
  'checkable: now',
  'title: Offline uploads reuse the session id only until the queue drains',
  'claim: Offline uploads reuse the session id minted online.',
  'assessment: nextFor() hands back the queued session while the device is offline (lines 23-27), but drain() passes online=true for every upload (line 31), so the first retry after reconnecting mints a fresh id. The claim holds offline and fails on reconnect.',
  'evidence:',
  `- ${SESSION_PATH}:23-27@${SHA.slice(0, 7)}`,
  `- ${SESSION_PATH}:12-15@${SHA.slice(0, 7)}`,
  `- src/upload/retry.ts:8@${SHA.slice(0, 7)}`,
  `- ${SESSION_PATH}:31@${SHA.slice(0, 7)} "nextFor(u, true)"`,
  'options:',
  '- A | challenge | Holds offline, not after reconnecting | 1,4 | Qualify the claim: the id is reused until drain() runs, then a new one is minted.',
  '- B | deny | The claim is wrong | 3 | The retry module mints its own id, so the claim does not hold at all.',
  '- C | no_change | Leave the row open | | Nobody has run an offline upload against a staging build yet.',
]);

/** Any other row: a plausible card with a good cite, a line past the end of the file, and a quote that is on its line. */
const genericPresentation = (id: string, claim: string): string =>
  fenced(LIGHTNING_FENCE, [
    `id: ${id}`,
    'needs: human',
    'nature: fact',
    'checkable: now',
    `title: ${claim.slice(0, 80)}`,
    `claim: ${claim}`,
    'assessment: The lines I could read support the claim on the common path. One citation points past the end of the file, so part of the evidence could not be confirmed.',
    'evidence:',
    `- ${SESSION_PATH}:3-5@${SHA.slice(0, 7)}`,
    `- ${SESSION_PATH}:52@${SHA.slice(0, 7)}`,
    `- ${SESSION_PATH}:20@${SHA.slice(0, 7)} "return queue.get(id)"`,
    'options:',
    '- A | confirm | The claim holds | 1,3 | The checked lines agree with it.',
    '- B | deny | The claim is wrong | 2 | The second citation points past the end of the file, so the claim may rest on stale code.',
    '- C | no_change | Leave the row open | | There is not enough evidence either way yet.',
  ]);

/** A block that closes but offers one option, which is not usable (a card needs at least two). */
const unusablePresentation = (id: string): string =>
  fenced(LIGHTNING_FENCE, [`id: ${id}`, 'needs: agent', 'nature: fact', 'checkable: now', 'title: Retries', 'claim: Upload retries never exceed three attempts.', 'assessment: I could not tell from the code.', 'evidence:', 'options:', '- A | confirm | The claim holds | | Looks fine.']);

/** The vote each demo agent gives; an agent not in the table stays silent, so a panel shows silent seats. */
const VOTES: Record<string, { vote: string; prefers: string; reason: string }> = {
  'instrument-62': { vote: 'concur', prefers: 'A', reason: 'The cited lines match what I changed there last week.' },
  'MR !1267 merge conflicts': { vote: 'concern', prefers: 'C', reason: 'I am mid-merge on that module and have not run the offline path myself.' },
  'gateway tracing': { vote: 'concern', prefers: 'C', reason: 'One of the citations does not check out, so I would not settle it yet.' },
  'infra cleanup': { vote: 'refuted', prefers: 'B', reason: 'The retry path mints its own id in our staging traces.' },
};

const isLightningMessage = (text: string): boolean => text.startsWith(DECISION_PREFIX) || text.includes('```' + VOTE_FENCE) || text.includes('```' + LIGHTNING_FENCE);

/**
 * What a demo agent answers to a Lightning Round message; null stays silent. The first presenter of UV-0021 answers with a block that
 * cannot be used and the second never answers, so that card falls back to the ledger row with both status lines.
 */
function lightningReply(name: string, text: string): string | null {
  if (text.startsWith(DECISION_PREFIX)) return 'On it.';
  const id = /^id: (\S+)$/m.exec(text)?.[1] ?? '';
  if (text.includes('```' + VOTE_FENCE)) {
    const v = Object.hasOwn(VOTES, name) ? VOTES[name] : undefined;
    return v ? fenced(VOTE_FENCE, [`id: ${id}`, `vote: ${v.vote}`, `prefers: ${v.prefers}`, `reason: ${v.reason}`]) : null;
  }
  if (id === 'UV-0021') return name === MR_AGENT ? unusablePresentation(id) : null;
  return id === 'UV-0036' ? UV_0036 : genericPresentation(id, /^- claim: “(.*)”$/m.exec(text)?.[1] ?? id);
}

export function demoHub(): Hub {
  const t0 = Date.now();
  const fixtures = repoFixtures(t0);
  const agents: Agent[] = [
    { sessionID: 'a1b2c3d4-0001', pid: 4101, name: 'instrument-62', cwd: REPO, kind: 'interactive', status: 'busy', startedAt: t0 - 185 * MIN, inboxSocketPath: '/demo/4101.sock' },
    { sessionID: 'b2c3d4e5-0002', pid: 4102, jobID: 'b2c3d4e5', name: MR_AGENT, cwd: REPO, kind: 'background', status: 'idle', startedAt: t0 - 95 * MIN, inboxSocketPath: '/demo/4102.sock' },
    { sessionID: 'c3d4e5f6-0003', pid: 4103, name: 'docs sweep', cwd: '/Users/you/Repos/wiki', kind: 'interactive', status: 'idle', startedAt: t0 - 40 * MIN, inboxSocketPath: '/demo/4103.sock' },
    { sessionID: 'd4e5f6a7-0004', jobID: 'd4e5f6a7', name: 'flaky test fixer', cwd: REPO, kind: 'background', startedAt: t0 - 600 * MIN },
    { sessionID: 'e5f6a7b8-0005', pid: 4105, name: 'scratch', cwd: '/Users/you/Scratch', kind: 'interactive', status: 'idle', startedAt: t0 - 5 * MIN },
    // Two more with an inbox but no repo of their own, so a Lightning panel has seats to fill (and one to leave silent).
    { sessionID: 'f6a7b8c9-0006', pid: 4106, name: 'gateway tracing', cwd: '/Users/you/Repos/gateway', kind: 'interactive', status: 'idle', startedAt: t0 - 70 * MIN, inboxSocketPath: '/demo/4106.sock' },
    { sessionID: 'a7b8c9d0-0007', pid: 4107, name: 'infra cleanup', cwd: '/Users/you/Repos/infra', kind: 'interactive', status: 'idle', startedAt: t0 - 25 * MIN, inboxSocketPath: '/demo/4107.sock' },
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
  say(byName(MR_AGENT), 'assistant', 'Resolved 4 of 5 conflicts. Package.swift needs a decision about the minimum deployment target.');
  say(byName(MR_AGENT), 'assistant', statusBlock(['scope: MR !1267', 'status: waiting_for_human', 'remaining:', '- Package.swift: pick the minimum deployment target']));
  say(byName('docs sweep'), 'assistant', 'The API reference pages are rewritten. Journal entry written to the wiki.');
  say(byName('flaky test fixer'), 'assistant', 'Stopped for the day. Two retries left in the CI log.');

  const respond = (a: Agent, text: string) => {
    const delay = 500 + Math.random() * 800;
    setTimeout(() => {
      if (isLightningMessage(text)) {
        const reply = lightningReply(a.name, text);
        if (reply) say(a, 'assistant', reply);
      } else if (text.includes(STATUS_ASK_MARKER)) {
        if (a.name === 'instrument-62') say(a, 'assistant', statusBlock(['scope: QP-27110 swift split', 'status: working', 'remaining:', '- extract the shared fixtures target', '- update the CI matrix']));
        else if (a.name === MR_AGENT) say(a, 'assistant', statusBlock(['scope: MR !1267', 'status: waiting_for_human', 'remaining:', '- Package.swift: pick the minimum deployment target', 'wiki_journaled: false', 'worktrees_cleaned: false']));
        else if (a.name === 'docs sweep') say(a, 'assistant', statusBlock(['scope: API reference rewrite', 'status: done', 'remaining: nothing', 'wiki_journaled: true', 'worktrees_cleaned: false', 'tb_uv_cleared: true', 'wiki_entry: journal/2026-10-24-docs-sweep.md', 'tb_uv_refs:', '- TB-0042', '- UV-0007']));
        else if (a.name === 'gateway tracing') say(a, 'assistant', statusBlock(['scope: gateway request tracing', 'status: planning', 'remaining:', '- pick the sampling rate']));
        else if (a.name === 'infra cleanup') say(a, 'assistant', statusBlock(['scope: staging cluster cleanup', 'status: paused', 'remaining:', '- wait for the nightly job to finish']));
        else say(a, 'assistant', 'Nothing in flight here, just a scratch shell.');
      } else if (text.includes('cim-volunteer')) {
        if (a.name === 'instrument-62') say(a, 'assistant', '```cim-volunteer\nvolunteer: yes\ncontext: I touched that module yesterday\n```');
        else if (a.name === MR_AGENT) say(a, 'assistant', '```cim-volunteer\nvolunteer: no\ncontext: mid-merge on MR !1267\n```');
        // docs sweep and scratch stay silent, to show the busy/offline marks
      } else if (text.includes('pausing every running agent')) say(a, 'assistant', 'Stopped at the next safe point: nothing half-done.');
      else if (text.includes('Journal this session') || text.includes('Clean up')) say(a, 'assistant', 'On it.');
      else say(a, 'assistant', `Got it. (${a.name} is a demo agent, so this is a canned reply.)`);
    }, delay);
  };

  const run = async (cmd: string, args: string[]) => {
    if (cmd === 'git' && args[0] === '-C') return demoGit(args[1], args[2], args.slice(3), fixtures);
    if (args[0] === '--bg' && args.includes('--resume')) {
      const sid = args[args.indexOf('--resume') + 1];
      const a = agents.find((x) => x.sessionID === sid);
      if (a) setTimeout(() => ((a.pid = 4200 + seq), (a.inboxSocketPath = `/demo/${a.pid}.sock`), (a.status = 'idle')), 1200);
      return { code: 0, stdout: 'resumed', stderr: '' };
    }
    if (args[0] === '--bg') {
      const name = args[args.indexOf('--name') + 1] ?? 'new agent';
      const jobID = (0xcafe00 + seq++).toString(16);
      setTimeout(() => agents.push({ sessionID: `${jobID}-demo`, pid: 4300 + seq, jobID, name, cwd: REPO, kind: 'background', status: 'busy', startedAt: Date.now(), inboxSocketPath: `/demo/${4300 + seq}.sock` }), 1500);
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
    lightningTiming: { pollMs: 300, presentTimeoutMs: 4000, voteTimeoutMs: 6000 },
  });
}
