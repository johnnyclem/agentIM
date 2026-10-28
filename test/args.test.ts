import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/args.js';

describe('parseArgs', () => {
  it('splits positional words from flags; a flag takes the next word, or reads as "true" with none', () => {
    expect(parseArgs(['standup', '--date', '2026-10-20', '--json'])).toEqual({ positional: ['standup'], flags: { date: ['2026-10-20'], json: ['true'] } });
    expect(parseArgs(['serve', '--demo', '--port', '7571'])).toEqual({ positional: ['serve'], flags: { demo: ['true'], port: ['7571'] } });
    expect(parseArgs(['a', 'b', 'c'])).toEqual({ positional: ['a', 'b', 'c'], flags: {} });
    expect(parseArgs([])).toEqual({ positional: [], flags: {} });
  });

  it('reads --flag=value like --flag value', () => {
    expect(parseArgs(['standup', '--date=2026-10-20']).flags).toEqual({ date: ['2026-10-20'] });
    expect(parseArgs(['lightning', 'start', '--repo=instrument', '--panel=2'])).toEqual({ positional: ['lightning', 'start'], flags: { repo: ['instrument'], panel: ['2'] } });
    expect(parseArgs(['serve', '--ledger-ref=main', '--port=7572']).flags).toEqual({ 'ledger-ref': ['main'], port: ['7572'] });
  });

  it('the value of --flag=value is everything after the first "=", and may be empty or look like a flag', () => {
    expect(parseArgs(['--prompt=a=b=c']).flags).toEqual({ prompt: ['a=b=c'] });
    expect(parseArgs(['--url=http://x/?q=1&r=2']).flags).toEqual({ url: ['http://x/?q=1&r=2'] });
    expect(parseArgs(['--repo=']).flags).toEqual({ repo: [''] });
    expect(parseArgs(['--repo=', 'next']).flags).toEqual({ repo: [''] }); // an empty value is a value: it does not take the next word
    expect(parseArgs(['--repo=', 'next']).positional).toEqual(['next']);
    expect(parseArgs(['--description=--not-a-flag']).flags).toEqual({ description: ['--not-a-flag'] });
  });

  it('keeps every value of a repeated flag in order, whichever form each one used', () => {
    expect(parseArgs(['serve', '--ticket-prefix', 'QP', '--ticket-prefix=AB', '--ticket-prefix', 'CD']).flags).toEqual({ 'ticket-prefix': ['QP', 'AB', 'CD'] });
  });

  it('an equals sign in a positional word or in a flag’s space-separated value is left alone', () => {
    expect(parseArgs(['send', 'agent', 'a=b']).positional).toEqual(['send', 'agent', 'a=b']);
    expect(parseArgs(['--prompt', 'x=y']).flags).toEqual({ prompt: ['x=y'] });
  });

  it('the old form still ends a flag at the next flag', () => {
    expect(parseArgs(['--a', '--b=1', '--c', 'z'])).toEqual({ positional: [], flags: { a: ['true'], b: ['1'], c: ['z'] } });
  });
});
