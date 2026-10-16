import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionLedger } from '../src/ledger.js';
import { Archive, ARCHIVE_CAP } from '../src/archive.js';
import { MemoryKV, JsonFileKV, KEYS } from '../src/store.js';
import type { Agent } from '../src/agent.js';

const T0 = Date.parse('2026-10-16T12:00:00.000Z');
const agent = (id: string, over: Partial<Agent> = {}): Agent => ({ sessionID: id, pid: 1, name: `cli-${id}`, cwd: `/r/${id}`, kind: 'interactive', status: 'idle', startedAt: T0, inboxSocketPath: `/tmp/${id}`, ...over });

describe('the session ledger', () => {
  it('applies cIM names, clears an empty rename, and adds stopped stand-ins for sessions the CLI no longer lists', () => {
    const kv = new MemoryKV();
    const ledger = new SessionLedger(kv, () => T0);
    const a = agent('A');
    ledger.rename('A', '  Reviewer  ');
    expect(ledger.displayName(a)).toBe('Reviewer');
    expect(ledger.decorate([a])[0].name).toBe('Reviewer');
    ledger.rename('A', '');
    expect(ledger.displayName(a)).toBe('cli-A');
    ledger.recordPause([a, agent('B', { kind: 'background', jobID: 'B' }), agent('C', { pid: undefined })]);
    expect(ledger.resumeSet?.entries.map((e) => e.sessionID)).toEqual(['A', 'B']);
    const decorated = ledger.decorate([a]);
    expect(decorated.map((x) => [x.sessionID, x.pid, x.kind])).toEqual([
      ['A', 1, 'interactive'],
      ['B', undefined, 'background'],
    ]);
    expect(decorated[1].inboxSocketPath).toBeUndefined();
  });

  it('a paused set keeps live sessions; an inferred set drops what is alive again; observe persists the running list', () => {
    const kv = new MemoryKV();
    const ledger = new SessionLedger(kv, () => T0);
    const [a, b] = [agent('A'), agent('B')];
    ledger.recordPause([a, b]);
    ledger.observe([a, b]);
    expect(ledger.resumeSet?.entries).toHaveLength(2); // paused: live sessions still need the resume message
    expect(kv.get(KEYS.lastRunning)).toHaveLength(2);
    // Relaunch with no resume set but a last-running list: inferred set
    kv.set(KEYS.resumeSet, null);
    const relaunched = new SessionLedger(kv, () => T0 + 1);
    expect(relaunched.resumeSet).toMatchObject({ paused: false });
    expect(relaunched.resumeSet?.entries.map((e) => e.sessionID)).toEqual(['A', 'B']);
    relaunched.observe([a]); // A survived, B died with the reboot
    expect(relaunched.resumeSet?.entries.map((e) => e.sessionID)).toEqual(['B']);
    relaunched.observe([a, b]);
    expect(relaunched.resumeSet).toBeNull();
    // A normal quit and relaunch: everything alive drops out at once
    const again = new SessionLedger(kv, () => T0 + 2);
    again.observe([a, b]);
    expect(again.resumeSet).toBeNull();
  });

  it('markResumed moves entries to in-flight until the roster lists them; forget and dismiss drop them', () => {
    const kv = new MemoryKV();
    const ledger = new SessionLedger(kv, () => T0);
    const [a, b] = [agent('A'), agent('B')];
    ledger.recordPause([a, b]);
    ledger.markResumed(['A']);
    expect(ledger.resumeSet?.entries.map((e) => e.sessionID)).toEqual(['B']);
    expect(ledger.inFlight.map((e) => e.sessionID)).toEqual(['A']);
    expect(ledger.decorate([]).map((x) => x.sessionID).sort()).toEqual(['A', 'B']);
    ledger.observe([a]);
    expect(ledger.inFlight).toEqual([]);
    ledger.forget(['B']);
    expect(ledger.resumeSet).toBeNull();
    ledger.recordPause([a]);
    ledger.dismissResumeSet();
    expect(ledger.resumeSet).toBeNull();
    expect(kv.get(KEYS.resumeSet)).toBeUndefined();
  });
});

describe('the archive', () => {
  it('filters the roster, caps at 100 newest first, and restores', () => {
    const kv = new MemoryKV();
    const archive = new Archive(kv, () => T0);
    for (let i = 0; i < ARCHIVE_CAP + 5; i++) archive.archive(agent(`S${i}`));
    expect(archive.entries).toHaveLength(ARCHIVE_CAP);
    expect(archive.entries[0].sessionID).toBe(`S${ARCHIVE_CAP + 4}`);
    expect(archive.has('S0')).toBe(false); // the oldest were dropped
    expect(archive.entries[0]).toMatchObject({ projectName: `S${ARCHIVE_CAP + 4}`, name: `cli-S${ARCHIVE_CAP + 4}` });
    const visible = archive.visible([agent('S104'), agent('fresh')]);
    expect(visible.map((a) => a.sessionID)).toEqual(['fresh']);
    archive.archive(agent('S104')); // no-op if present
    expect(archive.entries).toHaveLength(ARCHIVE_CAP);
    archive.restore('S104');
    expect(archive.has('S104')).toBe(false);
    expect(new Archive(kv, () => T0).entries).toHaveLength(ARCHIVE_CAP - 1);
  });
});

describe('the JSON file store', () => {
  it('round-trips values and tolerates a corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-'));
    try {
      const path = join(dir, 'state.json');
      const kv = new JsonFileKV(path);
      kv.set('a', { x: 1 });
      kv.set('b', [1, 2]);
      kv.set('b', null);
      const again = new JsonFileKV(path);
      expect(again.get('a')).toEqual({ x: 1 });
      expect(again.get('b')).toBeUndefined();
      const { writeFileSync } = require('node:fs') as typeof import('node:fs');
      writeFileSync(path, '{not json');
      expect(new JsonFileKV(path).get('a')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
