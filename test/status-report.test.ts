import { describe, it, expect } from 'vitest';
import { parseStatusReport, choreStates, rollup, worktreeDecision, isSessionComplete, fencedBlock } from '../src/status-report.js';
import { STATUS_CHECK, STATUS_ASK_MARKER, compose, RELAY_PREAMBLE, HUMAN_TAG } from '../src/prompts.js';

const block = (body: string) => 'Here you go:\n```cim-status\n' + body + '\n```\nthanks';

describe('the status report parser', () => {
  it('parses the fields, lists and booleans', () => {
    const r = parseStatusReport(block(['scope: MR !1364', 'status: working', 'remaining:', '- fix the test', '- push', 'wiki_journaled: false', 'worktrees_cleaned: no', 'tb_uv_cleared: 1', 'wiki_entry: <path>', 'tb_uv_refs:', '- TB-0042', '- UV-0007'].join('\n')))!;
    expect(r).toMatchObject({ status: 'working', scope: 'MR !1364', remaining: ['fix the test', 'push'], remainingFile: null, wikiJournaled: false, worktreesCleaned: false, tbUvCleared: true, wikiEntry: null, tbUvRefs: ['TB-0042', 'UV-0007'] });
  });
  it('rejects prose, a missing status, a missing closing fence and the echoed template', () => {
    expect(parseStatusReport('I am working on the status: of things')).toBeNull();
    expect(parseStatusReport(block('scope: x\nremaining:\n- y'))).toBeNull();
    expect(parseStatusReport('```cim-status\nstatus: done\n')).toBeNull();
    expect(parseStatusReport(STATUS_CHECK)).toBeNull();
    expect(STATUS_CHECK.startsWith(STATUS_ASK_MARKER)).toBe(true);
  });
  it('accepts flexible status spellings and keeps an unknown one as raw', () => {
    expect(parseStatusReport(block('status: Waiting-For-Human'))!.status).toBe('waiting_for_human');
    expect(parseStatusReport(block('status: gave up'))!.status).toBe('gave_up');
    const odd = parseStatusReport(block('status: napping'))!;
    expect(odd.status).toBeNull();
    expect(odd.statusRaw).toBe('napping');
  });
  it('inline plus bullets keeps the bullets; a stray bullet after a scalar is dropped; a path becomes the remaining file', () => {
    const r = parseStatusReport(block('status: working\nremaining: first\n- second\nscope: z\n- stray'))!;
    expect(r.remaining).toEqual(['first', 'second']);
    expect(r.scope).toBe('z');
    const f = parseStatusReport(block('status: working\nremaining: ~/notes/mr1364.md\n- ignored?'))!;
    expect(f.remainingFile).toBe('~/notes/mr1364.md');
    expect(f.remaining).toEqual([]);
    expect(parseStatusReport(block('status: working\nremaining: /abs/path'))!.remainingFile).toBe('/abs/path');
  });
  it('booleans are tri-state and wiki_entry placeholders are absent', () => {
    const r = parseStatusReport(block('status: done\nwiki_journaled: maybe\nwiki_entry: wiki/journal/2026-10-16.md'))!;
    expect(r.wikiJournaled).toBeNull();
    expect(r.worktreesCleaned).toBeNull();
    expect(r.wikiEntry).toBe('wiki/journal/2026-10-16.md');
    expect(fencedBlock('```other\nx\n```', 'cim-status')).toBeNull();
  });
  it('derives chore states: done, needs attention only when the session is complete, else pending', () => {
    const done = parseStatusReport(block('status: done\nwiki_journaled: true\nworktrees_cleaned: false'))!;
    expect(isSessionComplete(done)).toBe(true);
    expect(choreStates(done)).toEqual({ wiki: 'done', worktrees: 'needs-attention', tbUv: 'needs-attention', anyReported: true });
    const waiting = parseStatusReport(block('status: waiting_for_human\nworktrees_cleaned: false'))!;
    expect(isSessionComplete(waiting)).toBe(false);
    expect(choreStates(waiting)).toMatchObject({ worktrees: 'pending', wiki: 'pending' });
    expect(choreStates(parseStatusReport(block('status: working'))!).anyReported).toBe(false);
  });
  it('rolls up in declaration order', () => {
    const reports = ['done', 'working', 'blocked', 'working', null].map((s) => (s ? parseStatusReport(block(`status: ${s}`)) : null));
    expect(rollup(reports)).toEqual([
      { status: 'working', count: 2 },
      { status: 'blocked', count: 1 },
      { status: 'done', count: 1 },
    ]);
  });
  it('worktree cleanup: unknown is concerning, never safe', () => {
    const done = parseStatusReport(block('status: done'))!;
    expect(worktreeDecision(done, { dirty: false, unpushed: 0 })).toEqual({ reasons: [], concerning: false });
    expect(worktreeDecision(done, { dirty: true, unpushed: 0 }).reasons).toEqual(['there’s uncommitted work in the worktree']);
    expect(worktreeDecision(done, { dirty: false, unpushed: 2 }).reasons).toEqual(['there are commits not yet pushed/merged']);
    const unknown = worktreeDecision(done, { dirty: null, unpushed: null });
    expect(unknown.concerning).toBe(true);
    expect(unknown.reasons).toHaveLength(2);
    const working = worktreeDecision(parseStatusReport(block('status: working'))!, { dirty: false, unpushed: 0 });
    expect(working.reasons).toEqual(['the session hasn’t completed its assigned task(s)']);
    expect(working.concerning).toBe(false);
  });
});

describe('the composer', () => {
  it('orders preamble, human tag and message, each only when asked', () => {
    expect(compose('hi', { includePreamble: true, userGenerated: true })).toBe(`${RELAY_PREAMBLE}\n\n${HUMAN_TAG}\n\nhi`);
    expect(compose(' hi ', { includePreamble: false, userGenerated: false })).toBe('hi');
    expect(compose('x', { includePreamble: false, userGenerated: true })).toBe(`${HUMAN_TAG}\n\nx`);
  });
});
