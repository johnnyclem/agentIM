import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

/** What Node hands back when a spawn fails (EMFILE, ENOENT): a child with no stdio that emits 'error' on a later tick. */
class FailedChild extends EventEmitter {
  stdout = null;
  stderr = null;
  kill = vi.fn();
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('node:child_process');
});

describe('runCommand when the spawn itself fails', () => {
  it('rejects with the spawn error instead of throwing on the missing stdio or leaving the error event unhandled', async () => {
    const err = Object.assign(new Error('spawn git EMFILE'), { code: 'EMFILE' });
    vi.doMock('node:child_process', () => ({
      spawn: () => {
        const child = new FailedChild();
        setImmediate(() => child.emit('error', err));
        return child;
      },
    }));
    const { runCommand } = await import('../src/runner.js');
    await expect(runCommand('git', ['status'])).rejects.toBe(err);
  });

  it('clears its timeout when the spawn fails, so nothing keeps the process alive', async () => {
    const err = new Error('spawn git EMFILE');
    vi.doMock('node:child_process', () => ({
      spawn: () => {
        const child = new FailedChild();
        setImmediate(() => child.emit('error', err));
        return child;
      },
    }));
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const { runCommand } = await import('../src/runner.js');
    await expect(runCommand('git', ['status'], { timeoutMs: 60_000 })).rejects.toBe(err);
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});
