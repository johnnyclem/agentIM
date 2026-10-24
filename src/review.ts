/**
 * Review mode (spec §5.6): after a Status Check, triage each agent's reply
 * one at a time. The entry computation and ranking are pure functions.
 */

import type { Agent } from './agent.js';
import type { GroupTurn } from './group.js';
import { parseStatusReport, type StatusReport } from './status-report.js';
import { STATUS_ASK_MARKER } from './prompts.js';

export type ReviewState = 'replied' | 'awaiting' | 'noReply';

export interface ReviewEntry {
  sessionID: string;
  name: string;
  cwd: string;
  state: ReviewState;
  /** The newest status-report turn's parse since the ask; null for a prose reply or none. */
  report: StatusReport | null;
  /** The turns after the ask (or from the newest status report when the ask scrolled out). */
  since: GroupTurn[];
  /** The id of the latest assistant reply; "reviewed" is keyed to it so a newer reply makes the entry unreviewed again. */
  latestReplyID: string | null;
  isReviewed: boolean;
  rank: number;
}

/** Lowest first; "needs human" is rank 2 or lower. */
export function reviewRank(state: ReviewState, report: StatusReport | null): number {
  if (state === 'awaiting') return 90;
  if (state === 'noReply') return 100;
  if (!report) return 3; // a prose reply
  switch (report.status) {
    case 'waiting_for_human':
      return 0;
    case 'blocked':
      return 1;
    case 'gave_up':
      return 2;
    case 'paused':
      return 4;
    case 'planning':
      return 5;
    case 'working':
      return 6;
    case 'done':
      return 7;
    default:
      return 3; // an unrecognized spelling reads like prose
  }
}

export const needsHuman = (e: ReviewEntry): boolean => e.rank <= 2;

/** A turn involves a participant when it is its own, or the human's turn addressed to it (or to everyone). */
const involves = (t: GroupTurn, sessionID: string): boolean => t.sessionID === sessionID || (t.sessionID === '' && (!t.recipients || t.recipients.includes(sessionID)));

export function computeReviewEntries(participants: Agent[], turns: GroupTurn[], awaiting: Set<string>, reviewed: Map<string, string>, askMarker: string = STATUS_ASK_MARKER): ReviewEntry[] {
  const entries = participants.map((p): ReviewEntry => {
    const involved = turns.filter((t) => involves(t, p.sessionID));
    let askIndex = -1;
    for (let i = involved.length - 1; i >= 0; i--) {
      const t = involved[i];
      if (t.sessionID === '' && t.turn.role === 'user' && t.turn.text.includes(askMarker)) {
        askIndex = i;
        break;
      }
    }
    let since: GroupTurn[];
    if (askIndex >= 0) since = involved.slice(askIndex + 1);
    else {
      // The ask scrolled out of the retained window: start from the newest status report.
      let reportIndex = -1;
      for (let i = involved.length - 1; i >= 0; i--) {
        const t = involved[i];
        if (t.sessionID === p.sessionID && t.turn.role === 'assistant' && parseStatusReport(t.turn.text)) {
          reportIndex = i;
          break;
        }
      }
      since = reportIndex >= 0 ? involved.slice(reportIndex) : [];
    }
    const replies = since.filter((t) => t.sessionID === p.sessionID && t.turn.role === 'assistant');
    const state: ReviewState = replies.length ? 'replied' : awaiting.has(p.sessionID) ? 'awaiting' : 'noReply';
    let report: StatusReport | null = null;
    for (let i = replies.length - 1; i >= 0; i--) {
      report = parseStatusReport(replies[i].turn.text);
      if (report) break;
    }
    const latestReplyID = replies.length ? replies[replies.length - 1].turn.id : null;
    return {
      sessionID: p.sessionID,
      name: p.name,
      cwd: p.cwd,
      state,
      report,
      since,
      latestReplyID,
      isReviewed: latestReplyID !== null && reviewed.get(p.sessionID) === latestReplyID,
      rank: reviewRank(state, report),
    };
  });
  // Stable: ties keep participant order.
  return entries.map((e, i) => [e, i] as const).sort((a, b) => a[0].rank - b[0].rank || a[1] - b[1]).map(([e]) => e);
}

/** The next unreviewed replied entry after `current` in list order, wrapping once; null when none. */
export function nextUnreviewed(entries: ReviewEntry[], current: string | null): string | null {
  const start = current ? entries.findIndex((e) => e.sessionID === current) : -1;
  for (let k = 1; k <= entries.length; k++) {
    const e = entries[(start + k) % entries.length];
    if (e.state === 'replied' && !e.isReviewed && e.sessionID !== current) return e.sessionID;
  }
  return null;
}

/** Keep the current selection if it still exists; else the first unreviewed entry; else the first. */
export function repairSelection(entries: ReviewEntry[], current: string | null): string | null {
  if (current && entries.some((e) => e.sessionID === current)) return current;
  return entries.find((e) => e.state === 'replied' && !e.isReviewed)?.sessionID ?? entries[0]?.sessionID ?? null;
}

export interface ReviewHeader {
  replied: number;
  total: number;
  reviewed: number;
}

export const reviewHeader = (entries: ReviewEntry[]): ReviewHeader => ({
  replied: entries.filter((e) => e.state === 'replied').length,
  total: entries.length,
  reviewed: entries.filter((e) => e.isReviewed).length,
});
