/**
 * Every message cIM composes (spec §6). One composer joins the parts with
 * blank lines: the relay preamble (first message of a thread only), the
 * human-origin tag (only for text a human typed), then the message.
 */

export const RELAY_PREAMBLE =
  'When the user asks you to send a message to another agent, another Claude, another terminal, or similar, use Claude Code’s ' +
  'agent-to-agent messaging. If you cannot immediately see the agent in question, search the active agents for the keywords in the ' +
  'user’s message and send it to the best match.';

export const HUMAN_TAG = '[cIM: a human typed and sent the message below directly, at the keyboard.]';

export interface ComposeOptions {
  includePreamble: boolean;
  userGenerated: boolean;
}

export function compose(message: string, opts: ComposeOptions): string {
  const parts: string[] = [];
  if (opts.includePreamble) parts.push(RELAY_PREAMBLE);
  if (opts.userGenerated) parts.push(HUMAN_TAG);
  parts.push(message.trim());
  return parts.join('\n\n');
}

/** The Done button: two instructions in the order they must happen. */
export const WRAP_UP = 'Clean up any leftover worktrees. Then journal this session to the wiki.';

/** The first sentence is the ask marker review mode searches for; keep it literal. */
export const STATUS_ASK_MARKER = 'Report your status here in this exact format';

export const STATUS_CHECK = [
  `${STATUS_ASK_MARKER}, in one fenced block with the info string cim-status, and nothing else:`,
  '',
  '```cim-status',
  'scope: <the one MR, ticket or task this reply is about>',
  'status: working | planning | paused | waiting_for_human | blocked | gave_up | done',
  'remaining:',
  '- <a few short bullets; if the real write-up is longer, journal it to a .md file and put that file’s path here as the value instead>',
  'wiki_journaled: true | false',
  'worktrees_cleaned: true | false',
  'tb_uv_cleared: true | false',
  'wiki_entry: <path under the wiki directory, only if journaled>',
  'tb_uv_refs:',
  '- <TB-NNNN or UV-NNNN ids you touched; leave empty if none>',
  '```',
  '',
  'If your status is done: journal the session to the wiki, clean up the worktrees you created and are finished with, resolve the ' +
    'TB/UV entries you opened that are now resolved, and then set the three booleans to what you actually did, not what you are about to do.',
].join('\n');

export const TBUV_RESOLUTION_GROUP =
  'You and at least one other agent have an unresolved TB/UV (tombstone or unverified claim) outstanding. State which ids are yours and ' +
  'what each claims, and ask the human to relay this to the others. If consensus is reached, say what each side does: file a tombstone, ' +
  'confirm an unverified claim, or both. If not, say exactly what is unresolved and ask the human to decide.';

export const TBUV_RESOLUTION_SOLO =
  'You have an unresolved TB/UV (tombstone or unverified claim) outstanding and nothing else is blocking this session. Resolve it now: ' +
  'file the tombstone or confirm the claim, whichever the evidence supports. Then update tb_uv_cleared.';

export const JOURNAL_NOW = 'Journal this session to the wiki now.';
export const JOURNAL_INCOMPLETE =
  'Journal this session to the wiki now, and note in the entry that it is an incomplete-session journal: the session has not completed its assigned tasks.';
export const CLEANUP_SAFE = 'Clean up any worktrees you created this session that you’re finished with.';
export const CLEANUP_ANYWAY =
  'Clean up the worktrees you created this session. Double-check each one before deleting anything, and report back if something should not be cleaned up yet.';

export const pauseMessage = (name: string): string =>
  `cIM is pausing every running agent, usually ahead of a reboot. You are the session called “${name}” in cIM. Stop at the next safe ` +
  'point: finish or back out the step you are on, save whatever a resumed session would need (memory, a wiki journal entry, a note in ' +
  'the worktree), and start no new work. Reply with one line saying where you stopped. cIM will message you to resume.';

export const resumeMessage = (name: string, wasPaused: boolean): string =>
  `${wasPaused ? 'cIM paused you earlier and is resuming you now.' : 'This session stopped unexpectedly (a reboot or a crash) and cIM has resumed it.'} ` +
  `You are the session called “${name}” in cIM. Check the state of the step you were on, re-read your memory or journal notes, then continue.`;

export const renameNotice = (name: string): string =>
  `Your session name in cIM is now “${name}”. Use it when identifying yourself to the human or to other agents. No reply needed.`;

export const modelCommand = (modelId: string): string => `/model ${modelId}`;

export const VOLUNTEER_FENCE = 'cim-volunteer';

export const volunteerAsk = (requester: string, title: string): string =>
  [
    `${requester} is looking for a volunteer for: ${title}`,
    '',
    'If you already have context on this, volunteer; if not, decline. Reply only in this fenced block and nothing else:',
    '',
    '```cim-volunteer',
    'volunteer: yes | no',
    'context: <one line on what you know about it>',
    '```',
    '',
    'Only answer for now: don’t start on the task, and carry on with whatever you were doing.',
  ].join('\n');

export const volunteerBriefing = (requester: string, title: string, description: string): string =>
  `${requester} picked you for: ${title}\n\nHere is the task.\n\n${description.trim()}`;

export const volunteerRelease = (title: string, assignee: string): string =>
  `No more volunteers are needed for “${title}”: it was assigned to ${assignee}. Continue with your previous task.`;

export const tbuvReviewed = (id: string, looksRight: boolean): string =>
  `Reviewed ${id}: ${looksRight ? 'confirmed, looks right.' : 'flagged for follow-up.'}`;
