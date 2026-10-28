import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { limitRunner } from '../src/limit.js';
import type { RunResult, Runner } from '../src/runner.js';

const tick = () => new Promise<void>((r) => setImmediate(r));
const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const emfile = () => Object.assign(new Error('spawn git EMFILE'), { code: 'EMFILE' });

/** A runner whose calls finish when the test says so: `finish(i)` ends the i-th call started, with a result or an error. */
function gated() {
  const started: string[] = [];
  const ends: Array<(r: RunResult | Error) => void> = [];
  let inflight = 0;
  let peak = 0;
  const run: Runner = (_cmd, args) => {
    started.push(args[0]);
    inflight++;
    peak = Math.max(peak, inflight);
    return new Promise<RunResult>((resolve, reject) => {
      ends[started.length - 1] = (r) => {
        inflight--;
        if (r instanceof Error) reject(r);
        else resolve(r);
      };
    });
  };
  return { run, started, finish: (i: number, r: RunResult | Error = ok(String(i))) => ends[i](r), inflight: () => inflight, peak: () => peak };
}

const stray: unknown[] = [];
const onStray = (reason: unknown) => void stray.push(reason);
process.on('unhandledRejection', onStray);
afterEach(() => {
  stray.length = 0;
});
afterAll(() => {
  process.off('unhandledRejection', onStray);
});

describe('limitRunner', () => {
  it('runs at most `max` calls at once and starts the rest in the order they were asked, as slots free up', async () => {
    const g = gated();
    const run = limitRunner(g.run, 2);
    const results = ['a', 'b', 'c', 'd', 'e'].map((x) => run('git', [x]));
    await tick();
    expect(g.started).toEqual(['a', 'b']);
    g.finish(1);
    await tick();
    expect(g.started).toEqual(['a', 'b', 'c']);
    g.finish(0);
    g.finish(2);
    await tick();
    expect(g.started).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(g.inflight()).toBe(2);
    g.finish(3);
    g.finish(4);
    expect((await Promise.all(results)).map((r) => r.stdout)).toEqual(['0', '1', '2', '3', '4']);
    expect(g.peak()).toBe(2);
  });

  it('passes the command, the argv and the options through untouched and returns the result as it is', async () => {
    const seen: unknown[][] = [];
    const result: RunResult = { code: 1, stdout: 'x', stderr: 'y', truncated: true };
    const run = limitRunner(async (...a) => (seen.push(a), result), 3);
    expect(await run('git', ['-C', '/r', 'show'], { cwd: '/r', timeoutMs: 5, maxOutputBytes: 9 })).toBe(result);
    expect(seen).toEqual([['git', ['-C', '/r', 'show'], { cwd: '/r', timeoutMs: 5, maxOutputBytes: 9 }]]);
  });

  it('a call that fails rejects for its own caller only, frees its slot, and leaves nothing unhandled behind', async () => {
    const g = gated();
    const run = limitRunner(g.run, 1);
    const first = run('git', ['a']).then(() => 'ok', (e: Error) => e);
    const second = run('git', ['b']).then((r) => r.stdout);
    const third = run('git', ['c']).then(() => 'ok', (e: Error) => e);
    await tick();
    expect(g.started).toEqual(['a']);
    g.finish(0, emfile());
    await tick();
    expect(g.started).toEqual(['a', 'b']); // the failure did not stop the queue
    g.finish(1, ok('second'));
    await tick();
    g.finish(2, new Error('third failed'));
    expect(await first).toMatchObject({ message: 'spawn git EMFILE', code: 'EMFILE' });
    expect(await second).toBe('second');
    expect(await third).toMatchObject({ message: 'third failed' });
    await tick();
    await tick();
    expect(stray).toEqual([]);
    expect(g.inflight()).toBe(0);
    void run('git', ['d']); // the slot is free: a later call starts at once
    await tick();
    expect(g.started).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a runner that throws before it returns a promise is a rejection too, and also frees the slot', async () => {
    let calls = 0;
    const run = limitRunner(((): Promise<RunResult> => {
      if (++calls === 1) throw emfile();
      return Promise.resolve(ok('fine'));
    }) as Runner, 1);
    const [a, b] = [run('git', []).catch((e: Error) => e.message), run('git', [])];
    expect(await a).toBe('spawn git EMFILE');
    expect((await b).stdout).toBe('fine');
  });

  it('a hundred calls against a machine that has only a few file descriptors all complete when the cap is below that number', async () => {
    let inflight = 0;
    let failures = 0;
    const fdLimit = 8;
    const machine: Runner = async () => {
      if (++inflight > fdLimit) {
        inflight--;
        failures++;
        throw emfile();
      }
      await tick();
      inflight--;
      return ok('x');
    };
    const run = limitRunner(machine, fdLimit);
    const limited = await Promise.allSettled(Array.from({ length: 100 }, () => run('git', [])));
    expect(limited.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(failures).toBe(0);
  });

  it('a cap that is not a number of at least one is one', async () => {
    for (const bad of [0, -3, Number.NaN, 0.4]) {
      const g = gated();
      const run = limitRunner(g.run, bad);
      const calls = [run('git', ['a']), run('git', ['b'])];
      await tick();
      expect(g.started, String(bad)).toEqual(['a']);
      g.finish(0);
      await tick();
      g.finish(1);
      await Promise.all(calls);
    }
  });
});
