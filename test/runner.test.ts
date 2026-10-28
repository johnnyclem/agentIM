import { describe, it, expect } from 'vitest';
import { runCommand } from '../src/runner.js';

/** Real child processes: `node -e` is the one program every machine that runs these tests has. */
const node = (script: string, opts: Parameters<typeof runCommand>[2] = {}) => runCommand(process.execPath, ['-e', script], opts);

describe('runCommand', () => {
  it('without a cap or a timeout it is what it always was: the exit code and both streams, and no other field', async () => {
    const r = await node("process.stdout.write('hi'); process.stderr.write('err'); process.exit(3)");
    expect(r).toStrictEqual({ code: 3, stdout: 'hi', stderr: 'err' });
    expect(await node("process.stdout.write('x'.repeat(300000))")).toMatchObject({ code: 0, stdout: 'x'.repeat(300_000) });
  });

  it('a timeout that does not fire, and a cap of 0, change nothing', async () => {
    const r = await node("process.stdout.write('x'.repeat(200000))", { timeoutMs: 10_000, maxOutputBytes: 0 });
    expect(r).toStrictEqual({ code: 0, stdout: 'x'.repeat(200_000), stderr: '' });
  });

  describe('maxOutputBytes', () => {
    it('output of exactly the cap is whole; one byte more kills the child and says so', async () => {
      const exact = await node("process.stdout.write('x'.repeat(1000))", { maxOutputBytes: 1000 });
      expect(exact).toStrictEqual({ code: 0, stdout: 'x'.repeat(1000), stderr: '' });
      const over = await node("process.stdout.write('x'.repeat(1001))", { maxOutputBytes: 1000 });
      expect(over.truncated).toBe(true);
      expect(over.code).toBe(1);
      expect(over.timedOut).toBeUndefined();
      expect(over.stdout).toBe('x'.repeat(1000));
    });

    it('a megabyte against a cap of 1000 returns promptly with truncated and a bounded stdout', async () => {
      const started = Date.now();
      const r = await node("process.stdout.write('x'.repeat(1000000))", { maxOutputBytes: 1000 });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(r.truncated).toBe(true);
      expect(r.code).toBe(1);
      expect(r.stdout.length).toBeLessThanOrEqual(1000);
      expect(r.stdout).toBe('x'.repeat(r.stdout.length));
    });

    it('a child that would print forever is killed at the cap, and nothing more is buffered', async () => {
      const started = Date.now();
      const r = await node("setInterval(() => process.stdout.write('y'.repeat(65536)), 1)", { maxOutputBytes: 100_000, timeoutMs: 20_000 });
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(r).toMatchObject({ code: 1, truncated: true });
      expect(r.timedOut).toBeUndefined(); // it was the cap, not the clock
      expect(r.stdout.length).toBeLessThanOrEqual(100_000);
    });

    it('the cap counts bytes of stdout; stderr is not part of it', async () => {
      const r = await node("process.stderr.write('e'.repeat(5000)); process.stdout.write('é'.repeat(400))", { maxOutputBytes: 1000 });
      expect(r.truncated).toBeUndefined(); // 800 bytes of stdout
      expect(r.stderr).toBe('e'.repeat(5000));
      const over = await node("process.stdout.write('é'.repeat(600))", { maxOutputBytes: 1000 }); // 1200 bytes
      expect(over.truncated).toBe(true);
    });

    it('output that arrives in several chunks is counted across them', async () => {
      const script = "let n = 0; const t = setInterval(() => { process.stdout.write('z'.repeat(400)); if (++n === 5) clearInterval(t); }, 20)";
      const whole = await node(script, { maxOutputBytes: 2000 });
      expect(whole).toStrictEqual({ code: 0, stdout: 'z'.repeat(2000), stderr: '' });
      const cut = await node(script, { maxOutputBytes: 1999 });
      expect(cut).toMatchObject({ code: 1, truncated: true, stdout: 'z'.repeat(1999) });
    });
  });

  describe('timeoutMs', () => {
    it('a child still running at the timeout is killed, and the result says timedOut', async () => {
      const started = Date.now();
      const r = await node('setTimeout(() => {}, 60000)', { timeoutMs: 200 });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(r.timedOut).toBe(true);
      expect(r.code).toBe(1);
      expect(r.truncated).toBeUndefined();
    });

    it('a child that finishes in time is not timedOut, whatever its exit code', async () => {
      expect(await node('process.exit(2)', { timeoutMs: 10_000 })).toStrictEqual({ code: 2, stdout: '', stderr: '' });
    });

    it('what was printed before the kill is kept', async () => {
      const r = await node("process.stdout.write('partial'); setTimeout(() => {}, 60000)", { timeoutMs: 1500 });
      expect(r).toMatchObject({ timedOut: true, stdout: 'partial' });
    });
  });
});
