/**
 * Persistence (spec §3.3): a key-value store with JSON values. The app's
 * defaults store in the original; here a JSON file, or memory in tests.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface KV {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

export class MemoryKV implements KV {
  private data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    const v = this.data.get(key);
    return v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as T);
  }
  set(key: string, value: unknown): void {
    if (value === undefined || value === null) this.data.delete(key);
    else this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
}

/** One JSON object per file, rewritten atomically on every set. */
export class JsonFileKV implements KV {
  private data: Record<string, unknown> = {};
  constructor(readonly path: string) {
    if (existsSync(path)) {
      try {
        this.data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      } catch {
        this.data = {};
      }
    }
  }
  get<T>(key: string): T | undefined {
    return this.data[key] as T | undefined;
  }
  set(key: string, value: unknown): void {
    if (value === undefined || value === null) delete this.data[key];
    else this.data[key] = value;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}

export const KEYS = {
  archived: 'cimArchivedSessions',
  names: 'cimSessionNames',
  resumeSet: 'cimResumeSet',
  lastRunning: 'cimLastRunning',
  volunteerRequester: 'cimVolunteerRequesterName',
} as const;
