import { describe, it, expect } from 'vitest';
import { Conversation, ConversationStore, MAX_RETAINED_TURNS, REPLY_WINDOW_MS, RESUME_HOLD_MS } from '../src/conversation.js';
import type { Agent, Turn } from '../src/agent.js';
import type { TranscriptRead } from '../src/transcript.js';
import { RELAY_PREAMBLE, HUMAN_TAG } from '../src/prompts.js';

const T0 = Date.parse('2026-10-16T12:00:00.000Z');

/** A fake transcript per session: turns are appended by the test, offsets are indices. */
function harness() {
  let now = T0;
  const files = new Map<string, Turn[]>();
  const sent: Array<{ to: string; text: string }> = [];
  const resumed: Array<{ to: string; prompt: string }> = [];
  const userTurns: Array<{ to: string; prompt: string }> = [];
  let failSend: string | null = null;
  const deps = {
    clock: () => now,
    // Advances the fake clock and yields a macrotask, so a sleep never completes inside the same flush as the send that started it.
    sleep: (ms: number) =>
      new Promise<void>((r) => {
        now += ms;
        setImmediate(r);
      }),
    transcriptPath: (a: Agent) => a.sessionID,
    readTail: async (path: string): Promise<TranscriptRead> => {
      const turns = files.get(path) ?? [];
      return { turns: turns.slice(-40), endOffset: turns.length, latestModel: [...turns].reverse().find((t) => t.model)?.model ?? null };
    },
    readSince: async (path: string, offset: number): Promise<TranscriptRead> => {
      const turns = files.get(path) ?? [];
      return { turns: turns.slice(offset), endOffset: turns.length, latestModel: null };
    },
    sendInbox: async (a: Agent, text: string) => {
      if (failSend) throw new Error(failSend);
      sent.push({ to: a.sessionID, text });
    },
  };
  const append = (sid: string, role: 'user' | 'assistant', text: string, extra: Partial<Turn> = {}) => {
    const list = files.get(sid) ?? [];
    list.push({ id: `${sid}-${list.length}`, role, text, timestamp: now, ...extra });
    files.set(sid, list);
  };
  const agent = (over: Partial<Agent> = {}): Agent => ({ sessionID: 'S1', pid: 11, name: 'one', cwd: '/r', kind: 'interactive', status: 'idle', startedAt: T0, inboxSocketPath: '/tmp/11.sock', ...over });
  return { deps, append, agent, sent, resumed, userTurns, setFail: (m: string | null) => (failSend = m), now: () => now };
}

describe('a 1:1 thread', () => {
  it('loads the tail once, sends with the preamble first and the human tag, and matches the transcript copy by containment', async () => {
    const h = harness();
    h.append('S1', 'user', 'earlier', { model: undefined });
    h.append('S1', 'assistant', 'hello', { model: 'claude-opus-5-5' });
    const c = new Conversation(h.agent(), h.deps);
    await c.loadIfNeeded();
    expect(c.turns.map((t) => t.text)).toEqual(['earlier', 'hello']);
    expect(c.selectedModel).toBe('claude-opus-5-5');
    c.draft = 'please rebase';
    expect(c.canSend).toBe(true);
    const sending = c.send();
    expect(c.draft).toBe('');
    expect(c.turns.at(-1)).toMatchObject({ role: 'user', text: 'please rebase' });
    expect(c.hasPending).toBe(true);
    // The recipient CLI records the send wrapped in its own framing, preamble included on the first turn
    h.append('S1', 'user', `Another Claude session sent a message...\n\n${RELAY_PREAMBLE}\n\n${HUMAN_TAG}\n\nplease rebase`);
    h.append('S1', 'assistant', 'rebased');
    await sending;
    await c.settle();
    expect(h.sent).toEqual([{ to: 'S1', text: `${RELAY_PREAMBLE}\n\n${HUMAN_TAG}\n\nplease rebase` }]);
    expect(c.isAwaitingReply).toBe(false);
    expect(c.turns.map((t) => [t.role, t.text])).toEqual([
      ['user', 'earlier'],
      ['assistant', 'hello'],
      ['user', 'please rebase'],
      ['assistant', 'rebased'],
    ]);
    expect(c.turns[2].id).toBe('S1-2'); // adopted the transcript's id
    expect(c.hasPending).toBe(false);
    // The second send carries no preamble
    c.draft = 'thanks';
    await c.send();
    await c.settle();
    expect(h.sent[1].text).toBe(`${HUMAN_TAG}\n\nthanks`);
  });

  it('gives up waiting after the reply window and clears the pending list', async () => {
    const h = harness();
    const c = new Conversation(h.agent(), h.deps);
    c.draft = 'anyone?';
    await c.send();
    expect(c.isAwaitingReply).toBe(true);
    await c.settle();
    expect(h.now() - T0).toBeGreaterThanOrEqual(REPLY_WINDOW_MS);
    expect(c.isAwaitingReply).toBe(false);
    expect(c.hasPending).toBe(false);
    // A later unrelated user turn is appended as its own turn, not matched
    h.append('S1', 'user', 'anyone? typed in the terminal');
  });

  it('on a failed send: removes the bubble, shows the error, puts the text back at the front of the draft', async () => {
    const h = harness();
    const c = new Conversation(h.agent(), h.deps);
    h.setFail('connection refused');
    c.draft = 'lost?';
    await c.send();
    await c.settle();
    expect(c.errorMessage).toBe('connection refused');
    expect(c.turns).toEqual([]);
    expect(c.draft).toBe('lost?');
    c.draft = 'second';
    await c.send();
    await c.settle();
    expect(c.draft).toBe('second');
    expect(c.isAwaitingReply).toBe(false);
  });

  it('an app-composed instruction carries no human tag and leaves the draft alone', async () => {
    const h = harness();
    const c = new Conversation(h.agent(), h.deps);
    c.draft = 'my draft';
    await c.sendInstruction('Journal this session to the wiki now.');
    await c.settle();
    expect(h.sent[0].text).toBe(`${RELAY_PREAMBLE}\n\nJournal this session to the wiki now.`);
    expect(c.draft).toBe('my draft');
  });

  it('resumes a stopped session through the resumer and holds until the roster lists it with an inbox', async () => {
    const h = harness();
    const stopped = h.agent({ pid: undefined, inboxSocketPath: undefined, status: undefined, kind: 'background', jobID: 'S1' });
    const c = new Conversation(stopped, h.deps);
    c.resumer = async (a, prompt) => {
      h.resumed.push({ to: a.sessionID, prompt });
    };
    expect(c.canResume).toBe(true);
    c.draft = 'wake up';
    expect(c.canSend).toBe(true);
    const p = c.send();
    expect(c.isResuming).toBe(true);
    c.draft = 'again';
    await c.send(); // a second send during the hold does not launch a second copy
    expect(h.resumed).toHaveLength(1);
    expect(c.draft).toBe('again');
    await p;
    expect(c.isResuming).toBe(true);
    c.refreshAgent(h.agent({ pid: 44, kind: 'background', jobID: 'S1' }));
    expect(c.isResuming).toBe(false);
    expect(c.canSend).toBe(true);
    await c.settle();
  });

  it('the resume hold ends on its own after 90 s', async () => {
    const h = harness();
    const c = new Conversation(h.agent({ pid: undefined, inboxSocketPath: undefined }), h.deps);
    c.resumer = async () => undefined;
    c.draft = 'x';
    await c.send();
    expect(c.isResuming).toBe(true);
    await c.settle();
    expect(h.now() - T0).toBeGreaterThanOrEqual(RESUME_HOLD_MS);
    expect(c.isResuming).toBe(false);
  });

  it('send-as-me goes through the user-turn sender and the hold waits for a new pid', async () => {
    const h = harness();
    const a = h.agent({ kind: 'background', jobID: 'S1', status: 'idle' });
    const c = new Conversation(a, h.deps);
    c.userTurnSender = async (ag, prompt) => {
      h.userTurns.push({ to: ag.sessionID, prompt });
    };
    expect(c.offersSendAsUser).toBe(true);
    c.draft = 'as me';
    await c.sendAsUser();
    expect(h.userTurns[0].prompt).toContain('as me');
    expect(c.isResuming).toBe(true);
    c.refreshAgent({ ...a, status: 'busy' }); // same pid: still the old process winding down
    expect(c.isResuming).toBe(true);
    c.refreshAgent({ ...a, pid: 99 });
    expect(c.isResuming).toBe(false);
    await c.settle();
  });

  it('changes the model with a /model message, rolling back on failure', async () => {
    const h = harness();
    const c = new Conversation(h.agent(), h.deps);
    expect(await c.changeModel('claude-sonnet-5-5')).toBe(true);
    expect(h.sent[0].text).toBe('/model claude-sonnet-5-5');
    expect(c.selectedModel).toBe('claude-sonnet-5-5');
    h.setFail('nope');
    expect(await c.changeModel('claude-haiku-5-5')).toBe(false);
    expect(c.selectedModel).toBe('claude-sonnet-5-5');
    expect(c.errorMessage).toBe('nope');
  });

  it('trims to 60 turns and unloads only when idle, keeping draft, model and preamble', async () => {
    const h = harness();
    for (let i = 0; i < 100; i++) h.append('S1', i % 2 ? 'assistant' : 'user', `t${i}`);
    const c = new Conversation(h.agent(), h.deps);
    await c.loadIfNeeded();
    expect(c.turns).toHaveLength(40);
    c.draft = 'go';
    const sending = c.send();
    for (let i = 100; i < 140; i++) h.append('S1', 'user', `noise ${i}`);
    h.append('S1', 'assistant', 'done');
    await sending;
    await c.settle();
    expect(c.turns.length).toBeLessThanOrEqual(MAX_RETAINED_TURNS);
    expect(c.turns.at(-1)!.text).toBe('done');
    c.draft = 'kept';
    c.unloadIfIdle();
    expect(c.turns).toEqual([]);
    expect(c.draft).toBe('kept');
    expect(c.selectedModel).toBeNull();
    await c.loadIfNeeded();
    expect(c.turns).toHaveLength(40);
    c.draft = 'again';
    await c.send();
    expect(h.sent.at(-1)!.text.startsWith(RELAY_PREAMBLE)).toBe(false); // preamble flag survived the unload
    c.unloadIfIdle(); // awaiting a reply: no-op
    expect(c.turns.length).toBeGreaterThan(0);
    await c.settle();
  });
});

describe('the conversation store', () => {
  it('keeps one thread per session, pushes the routes to every thread, prunes dead sessions and unloads stale tails', async () => {
    const h = harness();
    const store = new ConversationStore(h.deps);
    const a = h.agent();
    const b = h.agent({ sessionID: 'S2', pid: 12 });
    const ca = store.conversation(a);
    expect(store.conversation(a)).toBe(ca);
    expect(store.existing('S2')).toBeNull();
    store.resumer = async () => undefined;
    expect(ca.resumer).not.toBeNull();
    const cb = store.conversation(b);
    expect(cb.resumer).not.toBeNull();
    h.append('S1', 'assistant', 'x');
    await ca.loadIfNeeded();
    for (const id of ['S3', 'S4', 'S5']) store.select(h.agent({ sessionID: id, pid: 1 }));
    expect(ca.turns).toEqual([]); // unloaded: not among the last three selected
    expect(store.prune([a, b])).toBe(true);
    expect(store.all().map((c) => c.sessionID).sort()).toEqual(['S1', 'S2']);
    expect(store.prune([a, b])).toBe(false);
    store.drop('S1');
    expect(store.existing('S1')).toBeNull();
  });
});
