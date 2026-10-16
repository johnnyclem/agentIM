/**
 * Transcripts: `~/.claude/projects/<slug>/<sessionId>.jsonl` (spec §2.4).
 * Chat history and reply detection both come from here. Two read modes:
 * a backward tail read in 256 KB chunks, and an incremental read of what
 * was appended after a byte offset. Neither re-parses what it already saw.
 */

import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Turn } from './agent.js';

export const CLAUDE_DIR = join(homedir(), '.claude');
export const MAX_TURN_CHARS = 12_000;
export const TAIL_TURNS = 40;
export const CHUNK_BYTES = 256 * 1024;
export const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const SLUG_MAX = 200;

/**
 * The CLI's folder name for a working directory (CLI 2.1.286): every UTF-16
 * code unit outside [0-9A-Za-z] becomes `-`; past 200 units the slug is cut
 * to 200 and suffixed with `-` and the base-36 absolute value of a 32-bit
 * signed rolling hash (h = h*31 + unit) over the original cwd.
 */
export function transcriptSlug(cwd: string): string {
  let out = '';
  for (let i = 0; i < cwd.length; i++) {
    const u = cwd.charCodeAt(i);
    const alnum = (u >= 48 && u <= 57) || (u >= 65 && u <= 90) || (u >= 97 && u <= 122);
    out += alnum ? cwd[i] : '-';
  }
  if (out.length <= SLUG_MAX) return out;
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = (Math.imul(h, 31) + cwd.charCodeAt(i)) | 0;
  // h is a signed 32-bit int; Math.abs works in 64-bit doubles, so -2^31 is safe.
  return `${out.slice(0, SLUG_MAX)}-${Math.abs(h).toString(36)}`;
}

export function transcriptPath(cwd: string, sessionID: string, claudeDir: string = CLAUDE_DIR): string {
  return join(claudeDir, 'projects', transcriptSlug(cwd), `${sessionID}.jsonl`);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n\n').trim();
}

/** One transcript line to a turn, or null for anything that is not a renderable user/assistant turn. */
export function parseTurn(line: string, now: number = Date.now()): Turn | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  if (o.type !== 'user' && o.type !== 'assistant') return null;
  const message = o.message as { role?: unknown; content?: unknown; model?: unknown } | undefined;
  if (!message || typeof message !== 'object') return null;
  if (o.isMeta === true || o.isSidechain === true) return null;
  let text = textOf(message.content);
  if (!text) return null;
  let clipped = false;
  if (text.length > MAX_TURN_CHARS) {
    const more = text.length - MAX_TURN_CHARS;
    text = `${text.slice(0, MAX_TURN_CHARS)}\n\n... ${more} more characters in the session log.`;
    clipped = true;
  }
  const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  const turn: Turn = {
    id: typeof o.uuid === 'string' && o.uuid ? o.uuid : randomUUID(),
    role: o.type,
    text,
    timestamp: Number.isFinite(ts) ? ts : now,
  };
  if (o.type === 'assistant' && typeof message.model === 'string') turn.model = message.model;
  if (clipped) turn.clipped = true;
  return turn;
}

export interface TranscriptRead {
  turns: Turn[];
  /** The byte just past the last complete line read: where `readSince` continues. */
  endOffset: number;
  /** The model of the newest assistant turn read, if any. */
  latestModel: string | null;
}

const NL = 0x0a;

/** Split a byte buffer into complete lines; the trailing partial line (no newline) is returned separately. */
function splitLines(buf: Buffer): { lines: Buffer[]; partial: Buffer } {
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === NL) {
      lines.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  return { lines, partial: buf.subarray(start) };
}

function latestModelOf(turns: Turn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === 'assistant' && turns[i].model) return turns[i].model!;
  return null;
}

/**
 * The newest `maxTurns` renderable turns, walking backwards from EOF in
 * 256 KB chunks up to 8 MB. Each chunk is parsed once; the partial first
 * line is carried to the next (earlier) chunk. A missing file is an empty
 * tail, not an error: a session can be listed before its transcript exists.
 */
export async function readTail(path: string, maxTurns: number = TAIL_TURNS, now: number = Date.now()): Promise<TranscriptRead> {
  let fh;
  try {
    fh = await open(path, 'r');
  } catch {
    return { turns: [], endOffset: 0, latestModel: null };
  }
  try {
    const size = (await fh.stat()).size;
    let pos = size;
    // Bytes known to start a line whose newline was already seen; always newline-terminated when non-empty.
    let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let turns: Turn[] = [];
    let scanned = 0;
    let endOffset = size;
    let foundNewline = false;
    while (pos > 0 && turns.length < maxTurns && scanned < MAX_SCAN_BYTES) {
      const start = Math.max(0, pos - CHUNK_BYTES);
      const len = pos - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      const joined = carry.length ? Buffer.concat([buf, carry]) : buf;
      const { lines, partial } = splitLines(joined);
      if (!foundNewline) {
        // Still inside the unterminated line at EOF (one being written): not read, not counted.
        if (lines.length) {
          endOffset = start + (buf.length - partial.length);
          foundNewline = true;
        } else endOffset = start;
      }
      let chunkLines = lines;
      if (start > 0 && lines.length) {
        // The first line of this chunk may begin in the earlier one: carry it, terminator included.
        carry = Buffer.concat([lines[0], Buffer.from('\n')]);
        chunkLines = lines.slice(1);
      } else if (start > 0) {
        carry = Buffer.alloc(0);
      }
      const chunkTurns: Turn[] = [];
      for (const l of chunkLines) {
        const t = parseTurn(l.toString('utf8'), now);
        if (t) chunkTurns.push(t);
      }
      turns = chunkTurns.concat(turns);
      pos = start;
      scanned += len;
    }
    if (turns.length > maxTurns) turns = turns.slice(-maxTurns);
    return { turns, endOffset, latestModel: latestModelOf(turns) };
  } finally {
    await fh.close();
  }
}

/**
 * The turns appended after `offset`. A file smaller than the offset was
 * rotated: empty, with the new size. More than 8 MB appended falls back to
 * the tail read.
 */
export async function readSince(path: string, offset: number, now: number = Date.now()): Promise<TranscriptRead> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return { turns: [], endOffset: offset, latestModel: null };
  }
  if (size < offset) return { turns: [], endOffset: size, latestModel: null };
  if (size === offset) return { turns: [], endOffset: offset, latestModel: null };
  if (size - offset > MAX_SCAN_BYTES) return readTail(path, TAIL_TURNS, now);
  const fh = await open(path, 'r');
  try {
    const len = size - offset;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, offset);
    const { lines, partial } = splitLines(buf);
    const turns: Turn[] = [];
    for (const l of lines) {
      const t = parseTurn(l.toString('utf8'), now);
      if (t) turns.push(t);
    }
    return { turns, endOffset: size - partial.length, latestModel: latestModelOf(turns) };
  } finally {
    await fh.close();
  }
}
