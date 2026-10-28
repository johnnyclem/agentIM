import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { DEFAULT_LEDGER_REF, MAX_LEDGER_BYTES, discoverRepos, isOpen, parseLedger, readLedger, type LedgerRow, type RepoRef } from '../src/tbuv-ledger.js';
import type { RunOptions, RunResult, Runner } from '../src/runner.js';

const repo: RepoRef = { name: 'shop-app', path: '/work/shop-app' };
const line = (o: unknown) => JSON.stringify(o);
const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

interface Call {
  cmd: string;
  args: string[];
  opts?: RunOptions;
}
const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const fail = (code = 128): RunResult => ({ code, stdout: '', stderr: 'fatal: invalid object name' });

/** A runner that records every call and answers through the handler: no sockets, no disk, no git. */
function fakeRun(handler: (call: Call) => RunResult | Promise<RunResult>) {
  const calls: Call[] = [];
  const run: Runner = async (cmd, args, opts) => {
    const call = { cmd, args, opts };
    calls.push(call);
    return handler(call);
  };
  return { run, calls };
}

/** A ledger keyed by `<ref>:<file>`: text is a file, null is a file that is not there, an Error is a runner failure. */
function ledgerRun(files: Record<string, string | null | Error>) {
  return fakeRun((call) => {
    const spec = call.args[3];
    const f = files[spec];
    if (f instanceof Error) throw f;
    if (f === undefined || f === null) return fail();
    return ok(f);
  });
}

describe('isOpen', () => {
  it.each(['settled', 'confirmed', 'denied', 'superseded', 'resolved', 'closed', 'done', 'wontfix', 'withdrawn'])('%s is closed, in any case and with padding', (s) => {
    expect(isOpen(s)).toBe(false);
    expect(isOpen(s.toUpperCase())).toBe(false);
    expect(isOpen(`  ${s[0].toUpperCase()}${s.slice(1)}\t`)).toBe(false);
  });

  it.each([undefined, '', '   ', 'open', 'OPEN', 'pending', 'unverified', 'parked', 'in progress', 'settled-ish', 'not done', 'wont-fix'])('%j is open: an unknown status never makes a row disappear', (s) => {
    expect(isOpen(s)).toBe(true);
  });

  it('a named superseder closes a row of any status; a blank one does not', () => {
    expect(isOpen(undefined, 'TB-0051')).toBe(false);
    expect(isOpen('open', 'TB-0051')).toBe(false);
    expect(isOpen('pending', ' UV-2 ')).toBe(false);
    expect(isOpen('open', '')).toBe(true);
    expect(isOpen('open', '   ')).toBe(true);
    expect(isOpen('open', undefined)).toBe(true);
    expect(isOpen('done', '')).toBe(false);
  });
});

describe('the ledger parser', () => {
  it('reads every known field into a keyed row and keeps the parsed object as raw', () => {
    const o = { id: 'uv-0036', date: '2026-10-12', claim: 'offline uploads reuse the session id minted online', doubt: 'never checked against a cold start', settles_it: 'replay the upload with the network off', raised_by: 'ana', status: 'Open', colour: 'teal', extra: { n: 1 } };
    expect(parseLedger(line(o) + '\n', 'unverified', repo)).toEqual([
      {
        key: 'uv:shop-app:UV-0036',
        id: 'UV-0036',
        kind: 'unverified',
        repo: 'shop-app',
        repoPath: '/work/shop-app',
        date: '2026-10-12',
        claim: 'offline uploads reuse the session id minted online',
        doubt: 'never checked against a cold start',
        settlesIt: 'replay the upload with the network off',
        raisedBy: 'ana',
        status: 'open',
        open: true,
        raw: o,
      },
    ]);
  });

  it('a tombstone is keyed tb, an unverified claim uv, and the same id is a different key in each kind', () => {
    const text = line({ id: 'x-1' });
    const [tb] = parseLedger(text, 'tombstone', repo);
    const [uv] = parseLedger(text, 'unverified', repo);
    expect(tb).toMatchObject({ key: 'tb:shop-app:X-1', kind: 'tombstone' });
    expect(uv).toMatchObject({ key: 'uv:shop-app:X-1', kind: 'unverified' });
  });

  it('a row with only an id gets status open and no optional fields at all', () => {
    const [row] = parseLedger(line({ id: 'TB-1' }), 'tombstone', repo);
    expect(row.status).toBe('open');
    expect(row.open).toBe(true);
    expect(Object.keys(row).sort()).toEqual(['id', 'key', 'kind', 'open', 'raw', 'repo', 'repoPath', 'status']);
  });

  it('the id is trimmed and uppercased; a missing, blank, null, boolean or composite id skips the row, a finite number is read as text', () => {
    const rows = parseLedger(
      [line({ id: '  uv-0007 ' }), line({ claim: 'no id' }), line({ id: '' }), line({ id: '  ' }), line({ id: null }), line({ id: true }), line({ id: { n: 1 } }), line({ id: ['A'] }), line({ id: 42 })].join('\n'),
      'unverified',
      repo
    );
    expect(rows.map((r) => r.id)).toEqual(['UV-0007', '42']);
    expect(parseLedger('{"id":1e21}', 'unverified', repo)[0].id).toBe('1E+21'); // uppercase even when the text came from a number
  });

  it.each([
    ['raised_by', 'ana'],
    ['raisedBy', 'ben'],
    ['skeptic', 'cy'],
    ['by', 'dee'],
  ])('raisedBy reads the %s field', (field, who) => {
    expect(parseLedger(line({ id: 'UV-1', [field]: who }), 'unverified', repo)[0].raisedBy).toBe(who);
  });

  it('raisedBy prefers raised_by, then raisedBy, then skeptic, then by, and skips an alias that holds no text', () => {
    const all = { id: 'UV-1', by: 'dee', skeptic: 'cy', raisedBy: 'ben', raised_by: 'ana' };
    expect(parseLedger(line(all), 'unverified', repo)[0].raisedBy).toBe('ana');
    expect(parseLedger(line({ ...all, raised_by: undefined }), 'unverified', repo)[0].raisedBy).toBe('ben');
    expect(parseLedger(line({ ...all, raised_by: 7, raisedBy: '  ' }), 'unverified', repo)[0].raisedBy).toBe('cy');
    expect(parseLedger(line({ id: 'UV-1', raised_by: ['ana'], skeptic: null, by: 'dee' }), 'unverified', repo)[0].raisedBy).toBe('dee');
  });

  it('settles_it and settlesIt are the same field, and supersededBy reads both spellings and closes the row', () => {
    expect(parseLedger(line({ id: 'UV-1', settles_it: 'run it twice' }), 'unverified', repo)[0].settlesIt).toBe('run it twice');
    expect(parseLedger(line({ id: 'UV-1', settlesIt: 'run it thrice' }), 'unverified', repo)[0].settlesIt).toBe('run it thrice');
    expect(parseLedger(line({ id: 'UV-1', settles_it: 'snake', settlesIt: 'camel' }), 'unverified', repo)[0].settlesIt).toBe('snake');
    const snake = parseLedger(line({ id: 'TB-1', superseded_by: 'TB-9' }), 'tombstone', repo)[0];
    const camel = parseLedger(line({ id: 'TB-1', supersededBy: 'TB-8' }), 'tombstone', repo)[0];
    expect([snake.supersededBy, snake.status, snake.open]).toEqual(['TB-9', 'open', false]);
    expect([camel.supersededBy, camel.status, camel.open]).toEqual(['TB-8', 'open', false]);
    const blank = parseLedger(line({ id: 'TB-1', superseded_by: '  ' }), 'tombstone', repo)[0];
    expect([blank.supersededBy, blank.open]).toEqual([undefined, true]);
  });

  it('status is lower-cased and trimmed, blank or non-text reads as open, a closed word closes the row, an unknown word does not', () => {
    const status = (s: unknown) => {
      const [row] = parseLedger(line({ id: 'UV-1', status: s }), 'unverified', repo);
      return [row.status, row.open];
    };
    expect(status(' Settled ')).toEqual(['settled', false]);
    expect(status('WONTFIX')).toEqual(['wontfix', false]);
    expect(status('Parked')).toEqual(['parked', true]);
    expect(status('')).toEqual(['open', true]);
    expect(status('   ')).toEqual(['open', true]);
    expect(status(null)).toEqual(['open', true]);
    expect(status(5)).toEqual(['open', true]);
    expect(status(['done'])).toEqual(['open', true]);
  });

  it('date comes from date, else ts; a usable date beats ts and an unusable one falls through to it', () => {
    const date = (o: Record<string, unknown>) => parseLedger(line({ id: 'UV-1', ...o }), 'unverified', repo)[0].date;
    expect(date({ date: '2026-10-01', ts: '2026-09-01' })).toBe('2026-10-01');
    expect(date({ ts: '2026-09-01' })).toBe('2026-09-01');
    expect(date({ date: 'last tuesday', ts: '2026-09-01' })).toBe('2026-09-01');
    expect(date({ date: '', ts: '2026-09-01T08:00:00Z' })).toBe('2026-09-01');
    expect(date({ date: 'last tuesday', ts: 'also not a date' })).toBeUndefined();
    expect(date({})).toBeUndefined();
  });

  it('an ISO timestamp is cut to its date, whatever follows the day', () => {
    const date = (d: string) => parseLedger(line({ id: 'UV-1', date: d }), 'unverified', repo)[0].date;
    expect(date('2026-10-12')).toBe('2026-10-12');
    expect(date('2026-10-12T23:59:59Z')).toBe('2026-10-12');
    expect(date('2026-10-12T23:59:59.123-05:00')).toBe('2026-10-12');
    expect(date('2026-10-12 08:30:00')).toBe('2026-10-12');
    expect(date('  2026-10-12  ')).toBe('2026-10-12');
    expect(date('2024-02-29')).toBe('2024-02-29'); // a real leap day
  });

  it('a string that is not a real calendar date has no date', () => {
    const date = (d: unknown) => parseLedger(line({ id: 'UV-1', date: d }), 'unverified', repo)[0].date;
    for (const bad of ['2026-13-01', '2026-00-10', '2026-02-30', '2025-02-29', '2026-10-32', '2026-10-00', '20261012', '12/10/2026', 'Oct 12 2026', '2026-10-12x', '2026-10-1', 'x2026-10-12', '1761955200']) {
      expect(date(bad), bad).toBeUndefined();
    }
  });

  it('an epoch number below 1e11 is seconds, otherwise milliseconds, read as the local day', () => {
    const noon = new Date(2026, 9, 12, 12).getTime(); // 12 Oct 2026, local noon: the same day in any time zone
    const date = (n: unknown) => parseLedger(line({ id: 'UV-1', ts: n }), 'unverified', repo)[0].date;
    expect(date(Math.floor(noon / 1000))).toBe('2026-10-12');
    expect(date(noon)).toBe('2026-10-12');
    expect(date(noon / 1000 + 0.5)).toBe('2026-10-12'); // fractional seconds
    expect(date(99_999_999_999)).toMatch(/^5138-/); // the largest number still read as seconds
    expect(date(100_000_000_000)).toMatch(/^1973-/); // the smallest read as milliseconds
    expect(parseLedger(line({ id: 'UV-1', date: noon }), 'unverified', repo)[0].date).toBe('2026-10-12'); // a number under date works too
  });

  it('a number that is no instant has no date: zero, negative, out of range, text, boolean, null, array', () => {
    const date = (n: unknown) => parseLedger(line({ id: 'UV-1', ts: n }), 'unverified', repo)[0].date;
    for (const bad of [0, -5, -1_761_955_200, 1e20, 253_402_300_800_000, true, null, [1761955200], { s: 1 }]) {
      expect(date(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('text fields hold only text: a number, list, object, boolean or null is ignored, not coerced', () => {
    const [row] = parseLedger(line({ id: 'UV-1', claim: 12, doubt: ['x'], settles_it: { a: 1 }, raised_by: true, superseded_by: 9, status: 3 }), 'unverified', repo);
    expect(row.claim).toBeUndefined();
    expect(row.doubt).toBeUndefined();
    expect(row.settlesIt).toBeUndefined();
    expect(row.raisedBy).toBeUndefined();
    expect(row.supersededBy).toBeUndefined();
    expect(row.status).toBe('open');
    expect(row.open).toBe(true);
    expect(row.raw.claim).toBe(12); // raw keeps what was written
  });

  it('text fields are trimmed and a blank one is absent', () => {
    const [row] = parseLedger(line({ id: 'UV-1', claim: '  the export is gone \n', doubt: '   ', settles_it: '' }), 'unverified', repo);
    expect(row.claim).toBe('the export is gone');
    expect(row.doubt).toBeUndefined();
    expect(row.settlesIt).toBeUndefined();
  });

  it('blank lines, malformed JSON, and lines that are not objects are skipped without losing the good rows around them', () => {
    const rows = parseLedger(
      [
        line({ id: 'UV-1' }),
        '',
        '   \t',
        '{"id": "UV-2"',
        'not json at all',
        '[{"id":"UV-3"}]',
        '[]',
        '42',
        '"UV-4"',
        'null',
        'true',
        '{"id": "UV-5"} trailing words',
        '{}',
        line({ id: 'UV-6' }),
      ].join('\n'),
      'unverified',
      repo
    );
    expect(rows.map((r) => r.id)).toEqual(['UV-1', 'UV-6']);
  });

  it('CRLF line endings, a missing final newline and a byte order mark all read cleanly', () => {
    const text = '\uFEFF' + line({ id: 'UV-1' }) + '\r\n' + line({ id: 'UV-2' }) + '\r\n\r\n' + line({ id: 'UV-3' });
    expect(parseLedger(text, 'unverified', repo).map((r) => r.id)).toEqual(['UV-1', 'UV-2', 'UV-3']);
  });

  it('empty text is no rows', () => {
    expect(parseLedger('', 'unverified', repo)).toEqual([]);
    expect(parseLedger('\n\n', 'tombstone', repo)).toEqual([]);
  });

  it('the first row for an id wins, whatever its case, status or completeness, and row order is file order', () => {
    const rows = parseLedger(
      [line({ id: 'UV-7', claim: 'first', status: 'settled' }), line({ id: 'UV-8', claim: 'other' }), line({ id: 'uv-7', claim: 'second', status: 'open' }), line({ id: ' UV-7 ', claim: 'third' })].join('\n'),
      'unverified',
      repo
    );
    expect(rows.map((r) => [r.id, r.claim, r.open])).toEqual([
      ['UV-7', 'first', false],
      ['UV-8', 'other', true],
    ]);
  });

  it('a malformed duplicate does not displace the first row, and a malformed first line does not block a later row with the same id', () => {
    const rows = parseLedger(['{"id": "UV-9", "claim": ', line({ id: 'UV-9', claim: 'later but valid' }), line({ id: 'UV-9', claim: 'duplicate' })].join('\n'), 'unverified', repo);
    expect(rows.map((r) => r.claim)).toEqual(['later but valid']);
  });

  it('the repo name goes into the key and the path into repoPath, and a name with a colon is kept as given', () => {
    const [row] = parseLedger(line({ id: 'TB-3' }), 'tombstone', { name: 'my repo', path: '/home/user/my repo' });
    expect(row).toMatchObject({ key: 'tb:my repo:TB-3', repo: 'my repo', repoPath: '/home/user/my repo' });
  });

  it('is the same lookup the hub did: ids found case-insensitively, first row per id, malformed lines skipped', () => {
    const rows = parseLedger([line({ id: 'TB-0042', date: '2026-10-01', claim: 'the v1 export endpoint is removed', superseded_by: 'TB-0051' }), 'garbage', line({ id: 'tb-0042', claim: 'shadowed' })].join('\n'), 'tombstone', repo);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const found = byId.get('tb-0042'.toUpperCase());
    expect(rows).toHaveLength(1);
    expect(found).toMatchObject({ date: '2026-10-01', claim: 'the v1 export endpoint is removed', supersededBy: 'TB-0051' });
  });

  it('never throws, ids stay unique and uppercase, and every field has the type it declares, whatever the lines hold (property)', () => {
    const value = fc.jsonValue();
    const rowArb = fc.record({ id: value, date: value, ts: value, claim: value, doubt: value, settles_it: value, settlesIt: value, status: value, superseded_by: value, supersededBy: value, raised_by: value, raisedBy: value, skeptic: value, by: value }, { requiredKeys: [] });
    fc.assert(
      fc.property(fc.array(fc.oneof(rowArb.map((r) => JSON.stringify(r)), fc.string(), fc.jsonValue().map((v) => JSON.stringify(v))), { maxLength: 12 }), (lines) => {
        const rows = parseLedger(lines.join('\n'), 'tombstone', repo);
        expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
        for (const r of rows) {
          expect(r.id).not.toBe('');
          expect(r.id).toBe(r.id.trim().toUpperCase());
          expect(r.key).toBe(`tb:shop-app:${r.id}`);
          expect(r.status).not.toBe('');
          expect(r.status).toBe(r.status.toLowerCase());
          expect(r.open).toBe(isOpen(r.status, r.supersededBy));
          for (const f of [r.claim, r.doubt, r.settlesIt, r.raisedBy, r.supersededBy]) if (f !== undefined) expect(f).toBe(f.trim()), expect(f).not.toBe('');
          if (r.date !== undefined) expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
      })
    );
  });
});

describe('readLedger', () => {
  const tombstones = [line({ id: 'TB-0042', date: '2026-10-01', claim: 'the v1 export endpoint is removed' }), line({ id: 'TB-0043', status: 'settled' })].join('\n') + '\n';
  const unverified = [line({ id: 'UV-0007', claim: 'CI cache key includes the lockfile', doubt: 'never checked against a cold run' }), line({ id: 'UV-0008', superseded_by: 'UV-0009' })].join('\n') + '\n';
  const both = { 'wiki:tombstones.jsonl': tombstones, 'wiki:unverified.jsonl': unverified };

  const ids = (r: { rows: LedgerRow[] }) => r.rows.map((x) => x.key);

  it('runs git show for each ledger file with the exact argv and a 20 s timeout, and the default ref is wiki', async () => {
    const { run, calls } = ledgerRun(both);
    const out = await readLedger(run, repo);
    expect(DEFAULT_LEDGER_REF).toBe('wiki');
    expect(calls).toEqual([
      { cmd: 'git', args: ['-C', '/work/shop-app', 'show', 'wiki:tombstones.jsonl'], opts: { timeoutMs: 20_000 } },
      { cmd: 'git', args: ['-C', '/work/shop-app', 'show', 'wiki:unverified.jsonl'], opts: { timeoutMs: 20_000 } },
    ]);
    expect(out.unavailable).toBe(false);
  });

  it('returns the tombstones, then the unverified rows, each with its kind and repo, closed rows included', async () => {
    const out = await readLedger(ledgerRun(both).run, repo);
    expect(ids(out)).toEqual(['tb:shop-app:TB-0042', 'tb:shop-app:TB-0043', 'uv:shop-app:UV-0007', 'uv:shop-app:UV-0008']);
    expect(out.rows.map((r) => [r.kind, r.repo, r.repoPath, r.open])).toEqual([
      ['tombstone', 'shop-app', '/work/shop-app', true],
      ['tombstone', 'shop-app', '/work/shop-app', false],
      ['unverified', 'shop-app', '/work/shop-app', true],
      ['unverified', 'shop-app', '/work/shop-app', false],
    ]);
    expect(out.rows[2]).toMatchObject({ claim: 'CI cache key includes the lockfile', doubt: 'never checked against a cold run' });
  });

  it('a ref given by the caller is used in both specs', async () => {
    const { run, calls } = ledgerRun({ 'origin/wiki:tombstones.jsonl': tombstones, 'origin/wiki:unverified.jsonl': null });
    const out = await readLedger(run, repo, 'origin/wiki');
    expect(calls.map((c) => c.args[3])).toEqual(['origin/wiki:tombstones.jsonl', 'origin/wiki:unverified.jsonl']);
    expect(ids(out)).toEqual(['tb:shop-app:TB-0042', 'tb:shop-app:TB-0043']);
  });

  it('both files are requested before either answers: they run concurrently', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { run, calls } = fakeRun(async () => {
      await gate;
      return ok(line({ id: 'X-1' }));
    });
    const pending = readLedger(run, repo);
    await ticks(3);
    expect(calls.map((c) => c.args[3])).toEqual(['wiki:tombstones.jsonl', 'wiki:unverified.jsonl']);
    release();
    expect(ids(await pending)).toEqual(['tb:shop-app:X-1', 'uv:shop-app:X-1']);
  });

  it('a missing tombstones file is no tombstones, not an error; the same the other way round', async () => {
    const noTb = await readLedger(ledgerRun({ 'wiki:unverified.jsonl': unverified }).run, repo);
    expect(ids(noTb)).toEqual(['uv:shop-app:UV-0007', 'uv:shop-app:UV-0008']);
    expect(noTb.unavailable).toBe(false);
    const noUv = await readLedger(ledgerRun({ 'wiki:tombstones.jsonl': tombstones }).run, repo);
    expect(ids(noUv)).toEqual(['tb:shop-app:TB-0042', 'tb:shop-app:TB-0043']);
    expect(noUv.unavailable).toBe(false);
  });

  it('a non-zero exit of any kind means no rows from that file, whatever it printed', async () => {
    const { run } = fakeRun((call) => (call.args[3].endsWith('tombstones.jsonl') ? { code: 1, stdout: line({ id: 'TB-1' }), stderr: 'boom' } : ok(unverified)));
    const out = await readLedger(run, repo);
    expect(ids(out)).toEqual(['uv:shop-app:UV-0007', 'uv:shop-app:UV-0008']);
  });

  it('neither file readable: no rows and unavailable', async () => {
    const out = await readLedger(ledgerRun({}).run, repo);
    expect(out).toEqual({ rows: [], unavailable: true });
  });

  it('a runner that throws counts as that file missing: both throwing is unavailable, one throwing keeps the other', async () => {
    const both = await readLedger(fakeRun(() => Promise.reject(new Error('spawn git ENOENT'))).run, repo);
    expect(both).toEqual({ rows: [], unavailable: true });
    const one = await readLedger(ledgerRun({ 'wiki:tombstones.jsonl': new Error('timed out'), 'wiki:unverified.jsonl': unverified }).run, repo);
    expect(ids(one)).toEqual(['uv:shop-app:UV-0007', 'uv:shop-app:UV-0008']);
    expect(one.unavailable).toBe(false);
  });

  it('a runner that throws before returning a promise, or throws a non-Error, is handled the same', async () => {
    const sync: Runner = () => {
      throw new Error('synchronous');
    };
    expect(await readLedger(sync, repo)).toEqual({ rows: [], unavailable: true });
    const odd: Runner = () => Promise.reject('just a string');
    expect(await readLedger(odd, repo)).toEqual({ rows: [], unavailable: true });
  });

  it('a ledger that exists but is empty is available with no rows: an empty ledger is not a failure', async () => {
    const out = await readLedger(ledgerRun({ 'wiki:tombstones.jsonl': '', 'wiki:unverified.jsonl': '\n' }).run, repo);
    expect(out).toEqual({ rows: [], unavailable: false });
  });

  it('malformed lines in a file are skipped and the rest of the file still reads', async () => {
    const out = await readLedger(ledgerRun({ 'wiki:unverified.jsonl': `oops\n${line({ id: 'UV-1' })}\n{"id":\n` }).run, repo);
    expect(ids(out)).toEqual(['uv:shop-app:UV-1']);
    expect(out.unavailable).toBe(false);
  });

  it('refuses a ref that could be read as an option or split into arguments, and never runs git for it', async () => {
    const hostile = ['', '-p', '--output=/tmp/pwned', '--upload-pack=sh', '-C', '-', 'wiki main', 'wiki\tmain', 'wiki\nmain', 'wiki\r', ' wiki', 'wiki ', 'wiki\u00a0main', 'wiki\u2028', 'wi\0ki', '\0', '--', 'wiki; rm -rf /'];
    for (const ref of hostile) {
      const { run, calls } = ledgerRun(both);
      expect(await readLedger(run, repo, ref), JSON.stringify(ref)).toEqual({ rows: [], unavailable: true });
      expect(calls, JSON.stringify(ref)).toEqual([]);
    }
  });

  it('a ref that is not a string at all is refused too', async () => {
    const { run, calls } = ledgerRun(both);
    for (const ref of [null, 7, { toString: () => 'wiki' }, ['wiki']]) {
      expect(await readLedger(run, repo, ref as unknown as string)).toEqual({ rows: [], unavailable: true });
    }
    expect(calls).toEqual([]);
  });

  it('plain refs pass through unchanged, a dash inside a name is fine, and an omitted ref is the default', async () => {
    for (const ref of ['wiki', 'origin/wiki', 'refs/heads/ledger-v2', 'team_notes.v1', 'wiki~1']) {
      const { run, calls } = ledgerRun({});
      await readLedger(run, repo, ref);
      expect(calls.map((c) => c.args[3]), ref).toEqual([`${ref}:tombstones.jsonl`, `${ref}:unverified.jsonl`]);
    }
    const { run, calls } = ledgerRun({});
    await readLedger(run, repo, undefined);
    expect(calls[0].args[3]).toBe('wiki:tombstones.jsonl');
  });

  it('a repo path is one argv element after -C, never split, expanded or run through a shell', async () => {
    for (const path of ['/work/my repo', '/work/$(touch pwned)', '/work/a;b|c&d', "/work/it's", '/work/`id`', '-x', '--git-dir=/tmp/other']) {
      const { run, calls } = ledgerRun({});
      await readLedger(run, { name: 'x', path });
      expect(calls.map((c) => [c.cmd, c.args.slice(0, 3)]), path).toEqual([
        ['git', ['-C', path, 'show']],
        ['git', ['-C', path, 'show']],
      ]);
      expect(calls.every((c) => c.args.length === 4), path).toBe(true);
    }
  });

  it('an empty repo path is refused, because git -C "" would read whichever repo the daemon happens to be in', async () => {
    const { run, calls } = ledgerRun(both);
    expect(await readLedger(run, { name: 'x', path: '' })).toEqual({ rows: [], unavailable: true });
    expect(await readLedger(run, { name: 'x', path: '/a\0b' })).toEqual({ rows: [], unavailable: true });
    expect(calls).toEqual([]);
  });

  describe('output size', () => {
    const rowOfBytes = (bytes: number) => {
      const head = '{"id":"BIG-1","claim":"';
      const tail = '"}';
      return head + 'x'.repeat(bytes - head.length - tail.length) + tail;
    };

    it('a file of exactly the cap reads; one byte more is treated as unreadable', async () => {
      const atCap = rowOfBytes(MAX_LEDGER_BYTES);
      expect(Buffer.byteLength(atCap)).toBe(MAX_LEDGER_BYTES);
      const read = await readLedger(ledgerRun({ 'wiki:tombstones.jsonl': atCap, 'wiki:unverified.jsonl': null }).run, repo);
      expect(ids(read)).toEqual(['tb:shop-app:BIG-1']);
      const over = await readLedger(ledgerRun({ 'wiki:tombstones.jsonl': atCap + ' ', 'wiki:unverified.jsonl': unverified }).run, repo);
      expect(ids(over)).toEqual(['uv:shop-app:UV-0007', 'uv:shop-app:UV-0008']);
      expect(over.unavailable).toBe(false);
    });

    it('when no file could be read because of the cap, the read is unavailable, not empty', async () => {
      const big = rowOfBytes(MAX_LEDGER_BYTES + 1);
      const out = await readLedger(ledgerRun({ 'wiki:tombstones.jsonl': big, 'wiki:unverified.jsonl': big }).run, repo);
      expect(out).toEqual({ rows: [], unavailable: true });
    });

    it('the cap counts bytes, not characters', async () => {
      const twoByte = 'é'.repeat(MAX_LEDGER_BYTES / 2 + 1); // fewer characters than the cap, more bytes
      expect(twoByte.length).toBeLessThan(MAX_LEDGER_BYTES);
      const out = await readLedger(ledgerRun({ 'wiki:tombstones.jsonl': `{"id":"TB-1","claim":"${twoByte}"}`, 'wiki:unverified.jsonl': null }).run, repo);
      expect(out).toEqual({ rows: [], unavailable: true });
    });
  });
});

describe('discoverRepos', () => {
  /** git's answers for `rev-parse --git-common-dir`, by directory; a missing directory is not a repo. */
  const commonDirs = (answers: Record<string, string | Error>, delays: Record<string, number> = {}) => {
    let inflight = 0;
    const seen = { max: 0 };
    const fake = fakeRun(async (call) => {
      inflight++;
      seen.max = Math.max(seen.max, inflight);
      await ticks(delays[call.args[1]] ?? 0);
      inflight--;
      const a = answers[call.args[1]];
      if (a instanceof Error) throw a;
      return a === undefined ? { code: 128, stdout: '', stderr: 'fatal: not a git repository' } : ok(a);
    });
    return { ...fake, seen };
  };

  it('a main worktree, a subdirectory of it, and a linked worktree are one repo, found with the exact argv and a 20 s timeout', async () => {
    const { run, calls } = commonDirs({
      '/work/shop-app': '.git\n', // relative to the directory
      '/work/shop-app/src/ui': '../../.git\n',
      '/work/shop-app-wt': '/work/shop-app/.git\n', // absolute in a linked worktree
    });
    const repos = await discoverRepos(run, ['/work/shop-app', '/work/shop-app/src/ui', '/work/shop-app-wt']);
    expect(repos).toEqual([{ name: 'shop-app', path: '/work/shop-app' }]);
    expect(calls).toEqual(
      ['/work/shop-app', '/work/shop-app/src/ui', '/work/shop-app-wt'].map((dir) => ({ cmd: 'git', args: ['-C', dir, 'rev-parse', '--git-common-dir'], opts: { timeoutMs: 20_000 } }))
    );
  });

  it('a relative common dir is resolved against the directory it was asked from, including ones that climb', async () => {
    const { run } = commonDirs({ '/work/a': '.git', '/work/b/pkg/deep': '../../.git', '/work/c/x': '../.git/' });
    const repos = await discoverRepos(run, ['/work/a', '/work/b/pkg/deep', '/work/c/x']);
    expect(repos).toEqual([
      { name: 'a', path: '/work/a' },
      { name: 'b', path: '/work/b' },
      { name: 'c', path: '/work/c' },
    ]);
  });

  it('a linked worktree alone still names the main repo, not itself', async () => {
    const { run } = commonDirs({ '/scratch/feature-wt': '/work/shop-app/.git' });
    expect(await discoverRepos(run, ['/scratch/feature-wt'])).toEqual([{ name: 'shop-app', path: '/work/shop-app' }]);
  });

  it('a directory that is not a repo, a failing git, and a thrown runner error are skipped without hiding the repos around them', async () => {
    const { run } = commonDirs({ '/work/first': '.git', '/work/broken': new Error('spawn git ENOENT'), '/work/last': '.git' });
    const repos = await discoverRepos(run, ['/work/first', '/tmp/not-a-repo', '/work/broken', '/work/last']);
    expect(repos).toEqual([
      { name: 'first', path: '/work/first' },
      { name: 'last', path: '/work/last' },
    ]);
    expect(await discoverRepos(commonDirs({}).run, ['/tmp/nothing'])).toEqual([]);
  });

  it('a runner that throws synchronously is a non-repo too', async () => {
    const sync: Runner = () => {
      throw new Error('synchronous');
    };
    expect(await discoverRepos(sync, ['/work/a'])).toEqual([]);
  });

  it('a bare repo and a submodule gitdir are not repos, because their common dir is not named .git', async () => {
    const { run } = commonDirs({
      '/srv/git/shop.git': '.', // bare
      '/work/shop-app/vendor/lib': '../../.git/modules/vendor/lib', // submodule, from inside it
      '/work/plain': '.git',
    });
    expect(await discoverRepos(run, ['/srv/git/shop.git', '/work/shop-app/vendor/lib', '/work/plain'])).toEqual([{ name: 'plain', path: '/work/plain' }]);
  });

  it('standing inside the .git directory itself still finds the repo above it', async () => {
    const { run } = commonDirs({ '/work/shop-app/.git': '.' });
    expect(await discoverRepos(run, ['/work/shop-app/.git'])).toEqual([{ name: 'shop-app', path: '/work/shop-app' }]);
  });

  it('empty output, blank output, and a repo at the filesystem root (no folder name) yield nothing', async () => {
    const { run } = commonDirs({ '/a': '', '/b': '\n', '/c': '   \n', '/d': '/.git' });
    expect(await discoverRepos(run, ['/a', '/b', '/c', '/d'])).toEqual([]);
  });

  it('CRLF output, trailing whitespace lines and extra lines after the first do not matter', async () => {
    const { run } = commonDirs({ '/w/a': '.git\r\n', '/w/b': '.git\nwarning: something\n' });
    expect(await discoverRepos(run, ['/w/a', '/w/b'])).toEqual([
      { name: 'a', path: '/w/a' },
      { name: 'b', path: '/w/b' },
    ]);
  });

  it('keeps first-seen order even when the answers arrive in the opposite order, and asks about every directory at once', async () => {
    const { run, seen } = commonDirs({ '/w/slow': '.git', '/w/mid': '.git', '/w/fast': '.git' }, { '/w/slow': 6, '/w/mid': 3, '/w/fast': 1 });
    const repos = await discoverRepos(run, ['/w/slow', '/w/mid', '/w/fast']);
    expect(repos.map((r) => r.name)).toEqual(['slow', 'mid', 'fast']);
    expect(seen.max).toBe(3);
  });

  it('the same directory twice, and empty or blank entries, cost no extra git call', async () => {
    const { run, calls } = commonDirs({ '/w/b': '.git', '/w/a': '.git', '/w/a/sub': '../.git' });
    const repos = await discoverRepos(run, ['/w/b', '', '/w/a', '   ', '/w/b', '/w/a', '/w/a/sub', '\t']);
    expect(calls.map((c) => c.args[1])).toEqual(['/w/b', '/w/a', '/w/a/sub']);
    expect(repos).toEqual([
      { name: 'b', path: '/w/b' },
      { name: 'a', path: '/w/a' },
    ]);
  });

  it('no directories, no git calls, no repos', async () => {
    const { run, calls } = commonDirs({});
    expect(await discoverRepos(run, [])).toEqual([]);
    expect(await discoverRepos(run, ['', ' '])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('two repos that happen to share a folder name stay two entries', async () => {
    const { run } = commonDirs({ '/a/app': '.git', '/b/app': '.git' });
    expect(await discoverRepos(run, ['/a/app', '/b/app'])).toEqual([
      { name: 'app', path: '/a/app' },
      { name: 'app', path: '/b/app' },
    ]);
  });

  it('a directory is one argv element after -C, whatever it contains', async () => {
    const dirs = ['/work/my repo', '/work/$(touch pwned)', '/work/a;b|c&d', '-x', '--git-dir=/tmp/other'];
    const { run, calls } = commonDirs({});
    await discoverRepos(run, dirs);
    expect(calls.map((c) => [c.cmd, c.args])).toEqual(dirs.map((d) => ['git', ['-C', d, 'rev-parse', '--git-common-dir']]));
  });

  it('what discoverRepos finds feeds readLedger unchanged', async () => {
    const found = await discoverRepos(commonDirs({ '/work/shop-app/src': '../.git' }).run, ['/work/shop-app/src']);
    const { run, calls } = ledgerRun({ 'wiki:unverified.jsonl': line({ id: 'uv-1', claim: 'offline uploads reuse the session id minted online' }) });
    const out = await readLedger(run, found[0]);
    expect(calls[0].args.slice(0, 2)).toEqual(['-C', '/work/shop-app']);
    expect(out.rows).toMatchObject([{ key: 'uv:shop-app:UV-1', repoPath: '/work/shop-app' }]);
  });
});
