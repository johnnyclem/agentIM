/**
 * A cap on how many subprocesses run at once. One standup build or round start asks git hundreds of questions (a repo per working directory,
 * a ledger read per repo, a few reads per cite); started all together they use up the process's file descriptors.
 */

import type { Runner } from './runner.js';

/**
 * `run`, with at most `max` calls in flight (at least 1). A call over the cap waits its turn, first come first served; its result or its rejection is
 * exactly what `run` gave, and the slot is handed on whichever way `run` ended, so a failing command never stops the queue.
 */
export function limitRunner(run: Runner, max: number): Runner {
  const cap = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1;
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (cmd, args, opts) => {
    // A freed slot goes straight to the next waiter (active stays as it is), so a call arriving in between cannot jump the queue.
    if (active >= cap) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await run(cmd, args, opts);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
