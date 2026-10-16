import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcriptSlug, transcriptPath, parseTurn, readTail, readSince, MAX_TURN_CHARS, CHUNK_BYTES } from '../src/transcript.js';

const T0 = Date.parse('2026-10-16T12:00:00.000Z');
let dir: string | null = null;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

const line = (role: 'user' | 'assistant', text: string, i: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: role, uuid: `${role}-${i}`, timestamp: new Date(T0 + i * 1000).toISOString(), message: { role, content: role === 'assistant' ? [{ type: 'text', text }] : text, ...(role === 'assistant' ? { model: 'claude-opus-5-5' } : {}) }, ...extra }) + '\n';

describe('the transcript slug', () => {
  it('replaces every non-alphanumeric UTF-16 unit with a dash', () => {
    expect(transcriptSlug('/Users/johnny/Repos/instrument')).toBe('-Users-johnny-Repos-instrument');
    expect(transcriptSlug('/a b/c.d')).toBe('-a-b-c-d');
    expect(transcriptSlug('/x/\u{1F600}')).toBe('-x---'); // a non-BMP char is two units
    expect(transcriptPath('/a/b', 'sid', '/c')).toBe('/c/projects/-a-b/sid.jsonl');
  });
  it('past 200 units: truncates and appends a base-36 32-bit rolling hash', () => {
    const cwd = '/' + 'a'.repeat(250);
    const slug = transcriptSlug(cwd);
    let h = 0;
    for (let i = 0; i < cwd.length; i++) h = (Math.imul(h, 31) + cwd.charCodeAt(i)) | 0;
    expect(slug).toBe('-' + 'a'.repeat(199) + '-' + Math.abs(h).toString(36));
    expect(slug.length).toBeLessThan(220);
  });
  it('handles the minimum 32-bit int: the absolute value is taken in 64-bit', () => {
    expect(Math.abs(-2147483648).toString(36)).toBe('zik0zk');
  });
});

describe('turn extraction', () => {
  it('keeps user and assistant text, drops meta, sidechain, tool blocks and empties', () => {
    expect(parseTurn(line('user', 'hi', 1))).toMatchObject({ id: 'user-1', role: 'user', text: 'hi', timestamp: T0 + 1000 });
    expect(parseTurn(line('assistant', 'yo', 2))).toMatchObject({ role: 'assistant', text: 'yo', model: 'claude-opus-5-5' });
    expect(parseTurn(line('user', 'x', 3, { isMeta: true }))).toBeNull();
    expect(parseTurn(line('assistant', 'x', 4, { isSidechain: true }))).toBeNull();
    expect(parseTurn(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }, { type: 'thinking', thinking: 'hm' }] } }))).toBeNull();
    expect(parseTurn(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }))?.text).toBe('a\n\nb');
    expect(parseTurn(JSON.stringify({ type: 'summary', summary: 'x' }))).toBeNull();
    expect(parseTurn('not json')).toBeNull();
  });
  it('truncates a long turn with a marker and the clipped flag', () => {
    const t = parseTurn(line('user', 'z'.repeat(MAX_TURN_CHARS + 500), 1))!;
    expect(t.clipped).toBe(true);
    expect(t.text.endsWith('\n\n... 500 more characters in the session log.')).toBe(true);
    expect(t.text.length).toBe(MAX_TURN_CHARS + '\n\n... 500 more characters in the session log.'.length);
  });
});

describe('tail and since reads', () => {
  it('reads the newest 40 turns across chunk boundaries and continues from the end offset', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tx-'));
    const path = join(dir, 't.jsonl');
    // Each line is a few KB so the file spans several 256 KB chunks with lines straddling boundaries.
    let content = '';
    for (let i = 0; i < 300; i++) content += line(i % 2 ? 'assistant' : 'user', `turn ${i} ` + 'x'.repeat(3000 + (i % 7) * 100), i);
    writeFileSync(path, content);
    expect(content.length).toBeGreaterThan(3 * CHUNK_BYTES);
    const tail = await readTail(path);
    expect(tail.turns).toHaveLength(40);
    expect(tail.turns[0].text.startsWith('turn 260 ')).toBe(true);
    expect(tail.turns[39].text.startsWith('turn 299 ')).toBe(true);
    expect(tail.endOffset).toBe(Buffer.byteLength(content));
    expect(tail.latestModel).toBe('claude-opus-5-5');
    const nothing = await readSince(path, tail.endOffset);
    expect(nothing.turns).toEqual([]);
    appendFileSync(path, line('assistant', 'later', 300));
    const since = await readSince(path, tail.endOffset);
    expect(since.turns.map((t) => t.text)).toEqual(['later']);
    expect(since.endOffset).toBe(Buffer.byteLength(content) + line('assistant', 'later', 300).length);
  });
  it('leaves a line still being written out of the read and out of the offset', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tx-'));
    const path = join(dir, 't.jsonl');
    const full = line('user', 'one', 1) + line('assistant', 'two', 2);
    writeFileSync(path, full + '{"type":"assistant","message":{"role":"assistant","content":"half');
    const tail = await readTail(path);
    expect(tail.turns.map((t) => t.text)).toEqual(['one', 'two']);
    expect(tail.endOffset).toBe(Buffer.byteLength(full));
    const since = await readSince(path, tail.endOffset);
    expect(since.turns).toEqual([]);
    expect(since.endOffset).toBe(Buffer.byteLength(full));
  });
  it('treats a rotated (smaller) file as empty with the new size, and a missing file as an empty tail', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tx-'));
    const path = join(dir, 't.jsonl');
    writeFileSync(path, line('user', 'a', 1));
    const r = await readSince(path, 10_000);
    expect(r).toEqual({ turns: [], endOffset: line('user', 'a', 1).length, latestModel: null });
    expect(await readTail(join(dir, 'nope.jsonl'))).toEqual({ turns: [], endOffset: 0, latestModel: null });
    expect(await readSince(join(dir, 'nope.jsonl'), 5)).toEqual({ turns: [], endOffset: 5, latestModel: null });
  });
  it('a single line longer than a chunk is carried whole', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tx-'));
    const path = join(dir, 't.jsonl');
    const big = line('user', 'B'.repeat(CHUNK_BYTES + 1000), 1);
    writeFileSync(path, line('user', 'first', 0) + big + line('assistant', 'last', 2));
    const tail = await readTail(path);
    expect(tail.turns.map((t) => t.text.slice(0, 5))).toEqual(['first', 'BBBBB', 'last']);
    expect(tail.turns[1].clipped).toBe(true);
  });
});
