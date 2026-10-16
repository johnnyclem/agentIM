import { describe, it, expect, afterEach } from 'vitest';
import { projectSlug, transcriptPath, readTranscript, inferState, roster, readSessionRegistry } from '../src/discovery.js';
import { world, writeRegistry, T0, type World } from './fixture.js';

let w: World;
afterEach(async () => w && (await w.dispose()));

describe('discovery', () => {
  it('derives the project slug the way Claude Code does', () => {
    expect(projectSlug('/Users/johnny/Repos/instrument')).toBe('-Users-johnny-Repos-instrument');
    expect(transcriptPath('/a/b', 'sid', '/claude')).toBe('/claude/projects/-a-b/sid.jsonl');
  });

  it('reads a transcript: assistant turns only, title, branch, last activity and the tail kind', async () => {
    w = await world();
    const cwd = '/Repos/x';
    const t = (s: number) => new Date(T0 + s * 1000).toISOString();
    w.transcriptLine(cwd, 's1', { type: 'user', sessionId: 's1', cwd, gitBranch: 'feat', timestamp: t(0), uuid: 'u1', message: { role: 'user', content: 'fix the tests' } });
    w.transcriptLine(cwd, 's1', { type: 'assistant', sessionId: 's1', cwd, timestamp: t(1), uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Bash' }] } });
    w.transcriptLine(cwd, 's1', { type: 'user', sessionId: 's1', cwd, timestamp: t(2), uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
    w.transcriptLine(cwd, 's1', { type: 'assistant', sessionId: 's1', cwd, timestamp: t(3), uuid: 'a2', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent noise' }] } });
    w.transcriptLine(cwd, 's1', { type: 'ai-title', sessionId: 's1', aiTitle: 'Fix tests' });
    w.transcriptLine(cwd, 's1', { type: 'assistant', sessionId: 's1', cwd, timestamp: t(4), uuid: 'a3', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
    const s = readTranscript(transcriptPath(cwd, 's1', w.claudeDir))!;
    expect(s.title).toBe('Fix tests');
    expect(s.gitBranch).toBe('feat');
    expect(s.lastActivityAt).toBe(T0 + 4000);
    expect(s.tail).toBe('assistant-text');
    expect(s.turns.map((x) => [x.role, x.text, x.toolUse ?? false])).toEqual([
      ['user', 'fix the tests', false],
      ['assistant', 'Looking.', true],
      ['assistant', 'Done.', false],
    ]);
    expect(readTranscript(transcriptPath(cwd, 's1', w.claudeDir), { tail: 1 })!.turns).toHaveLength(1);
    expect(readTranscript('/nowhere.jsonl')).toBeNull();
  });

  it('infers busy, idle and stopped from liveness, the tail and the clock', () => {
    const base = { alive: true, lastActivityAt: T0 };
    expect(inferState({ ...base, alive: false, tail: 'assistant-tool' }, T0 + 1)).toBe('stopped');
    expect(inferState({ ...base, tail: 'assistant-tool' }, T0 + 60_000)).toBe('busy');
    expect(inferState({ ...base, tail: 'user-tool-result' }, T0 + 60_000)).toBe('busy');
    expect(inferState({ ...base, tail: 'user-prompt' }, T0 + 60_000)).toBe('busy');
    expect(inferState({ ...base, tail: 'assistant-text' }, T0 + 2_000)).toBe('busy');
    expect(inferState({ ...base, tail: 'assistant-text' }, T0 + 20_000)).toBe('idle');
    expect(inferState({ ...base, tail: 'assistant-tool' }, T0 + 6 * 60_000)).toBe('idle');
    expect(inferState({ ...base, tail: null, registryStatus: 'busy' }, T0 + 1000)).toBe('busy');
    expect(inferState({ alive: true, tail: null, lastActivityAt: null }, T0)).toBe('idle');
  });

  it('joins the registry with the transcripts into a roster and leaves daemons and itself out', async () => {
    w = await world();
    const a = await w.agent('instrument-62');
    const b = await w.agent('instrument-66', { kind: 'bg' });
    writeRegistry(w.claudeDir, { pid: 1, sessionId: 'dead', cwd: '/gone', kind: 'interactive', name: 'ghost' });
    writeRegistry(w.claudeDir, { pid: 2, sessionId: 'd', cwd: '/d', kind: 'daemon', name: 'agentim' });
    writeRegistry(w.claudeDir, { pid: 3, sessionId: 'me', cwd: '/me', kind: 'interactive', name: 'self' });
    expect(readSessionRegistry(w.claudeDir).map((r) => r.pid)).toEqual([1, 2, 3, a.pid, b.pid]);
    const r = roster(T0 + 1000, { claudeDir: w.claudeDir, alive: (pid) => pid !== 1, selfPid: 3 });
    expect(r.asOf).toBe(T0 + 1000);
    expect(r.agents.map((x) => [x.name, x.mode, x.state, x.branch])).toEqual([
      ['instrument-62', 'interactive', 'busy', 'main'],
      ['instrument-66', 'background', 'busy', 'main'],
      ['ghost', 'interactive', 'stopped', null],
    ]);
    expect(r.agents[0].socket).toBe(a.inbox.socketPath);
    expect(r.agents[0].sinceActivityMs).toBe(1000);
  });
});
