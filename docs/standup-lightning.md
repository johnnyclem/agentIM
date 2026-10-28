# Morning Standup and the Lightning Round

Two modes added to the cIM pane, reverse-engineered from a photo of the original cIM tab. This document describes the code as built. §1 says what the photo shows and what was inferred from it; §2 to §7 are the behaviour as it is in `src/` and `panel/`; §8 lists the limits that were decided rather than fixed; §9 says what was verified and how.

## 1. What the screenshot shows, and what we infer

**Pane header.** New button **Morning Standup** between Find Volunteer and New Group. While a standup is open, **Abort** and **Back to agents** sit at the top right of the standup area.

**Standup header.** `Morning Standup  covering 2026-10-26, run 2026-10-27` and a row of source chips: `GitLab 18 · Jira 3 · Local git 18 · Ledger 101 · Sessions 43`.

**Lanes.** A radio-style list `Triage 29 · Agents 43 · Lightning 98`; the filled dot is the open lane. Under it a **Board**: one row per item, a coloured dot, a title clipped with an ellipsis, and the repo in parentheses for branches and sessions.

**Lightning card** (right pane), top to bottom:

1. Tags: `NeedsHuman`, `decision`, `checkable now`.
2. Title `UV-0036 <claim, clipped>` and a summary line `<repo>. Doubt: <doubt, clipped>`.
3. `Presented by <who> (from the ledger row)`.
4. The claim restated, then an assessment paragraph.
5. **Evidence**: one line per cite, `grounded @75c7b13 path:line` or `UNGROUNDED path:line`. A cite is shown both as `path:line` and as `path:lines@<full sha>`.
6. **Options** `A`, `B`, `C`, each `<Verb>: <title>`, its own grounded or UNGROUNDED tag, and a rationale. Verbs seen: Challenge, Deny, No change.
7. A collapsed `Votes: 0 concur, 0 concern, 0 refuted, 4 silent`.
8. `Pick A, B or C to approve.` and the buttons **Approve** (disabled until a pick), **Reject**, **Defer**.

**Status lines under the card:**
- `<agent> <8-hex> replied without a usable block.` (twice, two agents)
- `No presentation for uv:<repo>:UV-0021: The present call timed out.. Showing the ledger row.` (the double full stop is in the photo; the build prints one)

### Inferences (a good guess, not read off the screen)

| Observation | Inference |
|---|---|
| GitLab 18 + Jira 3 + Local git 18 = 39, lane says Triage 29 | Chips count raw items per source; lanes count items **after joining on ticket key or branch**. |
| Agents 43 = Sessions 43 | The Agents lane is one item per session. |
| Ledger 101, Lightning 98 | Lightning is the **open** ledger rows (not already settled or snoozed); the Ledger chip counts every row. |
| `uv:instrument:UV-0021` | A ledger row's key is `<kind>:<repo>:<ID>`. |
| `@75c7b13` next to a cite with no sha | A cite with no sha is pinned to the checkout's HEAD; one with a sha is checked at that commit. |
| `journal/…md:17` is UNGROUNDED | Grounded means the file exists at that commit **and** the lines exist. A path that is not in the code repo (wiki journal) is not grounded. |
| Every option UNGROUNDED although the evidence list has grounded cites | An option's grounding is about the cites **that option references**; an option with no cite of its own is UNGROUNDED. |
| `4 silent` | A panel of skeptic agents was asked to vote; `silent` = asked minus replied. |
| "replied without a usable block" then "timed out" | The presenter is an agent asked over the inbox; if it gives no usable `cim-lightning` block, the next candidate is tried; if all fail, the card falls back to the ledger row. |
| Approve is disabled until a pick | Approve needs an option; Reject and Defer do not. |

### Invented here (not in the photo)

- The block formats (`cim-lightning`, `cim-vote`) and the prompts that ask for them.
- The meaning of **Reject** (none of these; ask again later with a different presenter) and **Defer** (hide until tomorrow).
- The decision relay: Approve sends the human's choice to the agent as an instruction; **the panel never writes the ledger files** (same rule as the TB/UV sign-off). `no_change` sends nothing.
- Votes are **opt-in** (an "Ask skeptics" button), because asking four agents per card would interrupt the fleet 98 times.
- The `rev` of a card and the 409 that goes with it (§6.2), the demo hub (§6.7), and everything in §8.

### Scoped out of this version

- **GitLab and Jira sources.** Not built. There is no `StandupSource` interface: the three sources are three functions in `standup.ts` (`readBranches`, `readRows`, `readSessions`), each guarded on its own, and `buildStandup` calls them directly. This version ships Local git, Ledger and Sessions; the two forge chips would be new functions beside them.
- Any write to the ledger by cIM itself, auto-forwarding between agents, browser tests in CI.

## 2. Vocabulary

- **TB**: a tombstone row (`tombstones.jsonl`). **UV**: an unverified-claim row (`unverified.jsonl`). Both live on the repo's **ledger ref** (default `wiki`, `serve --ledger-ref REF`), read with `git show <ref>:<file>`, as `tbuvLookup` does. The ledger is two fixed file names (`LEDGER_FILES` in `tbuv-ledger.ts`).
- **Row**: one JSON object per line. Known fields (all optional except `id`): `id`, `date` or `ts`, `claim`, `doubt`, `settles_it` (or `settlesIt`), `status`, `superseded_by` (or `supersededBy`), `raised_by` (or `raisedBy`, `skeptic`, `by`). A text field that is not a string is ignored, not converted; text is trimmed and a blank one is absent. Unknown fields are kept in `raw` and ignored.
- **Id**: a non-blank string or a finite number, trimmed and uppercased, that matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. A row with any other id is skipped, because the id is quoted into agent prompts and the panel and is what a reply is matched on. The first row for an id wins, per file.
- **Date**: `'YYYY-MM-DD'`. A string starting `YYYY-MM-DD` (then end, `T` or a space) is cut to its date if it is a real calendar date; a finite positive number is an epoch (seconds below 1e11, else milliseconds) read as the user's local day; anything else is no date.
- **Open row**: `status` is absent or not one of `settled, confirmed, denied, superseded, resolved, closed, done, wontfix, withdrawn` (case-insensitive), **and** no `superseded_by` is set. `superseded_by` counts when it is a non-blank string, a finite number, or a list holding one. An unknown status reads as open: nothing silently disappears.
- **Key**: `tb:<repo>:<ID>` or `uv:<repo>:<ID>`; `<repo>` is the repo root's folder name, `<ID>` the uppercased id. Two repos with one folder name are named `<parent folder>~<folder>` (`a~app`), with `~2`, `~3` after that when even that collides, in path order (`uniqueRepoNames`); that is also the name `--repo` takes for them.

## 3. Data model

All of these are exported from the module named in the comment. Names and shapes are fixed; add fields rather than renaming.

```ts
// runner: src/runner.ts, limit: src/limit.ts
export interface RunOptions { cwd?: string; timeoutMs?: number; maxOutputBytes?: number }   // past maxOutputBytes the child is killed
export interface RunResult { code: number; stdout: string; stderr: string; truncated?: boolean; timedOut?: boolean }   // truncated: code is 1, stdout is what was kept
export function limitRunner(run: Runner, max: number): Runner;   // at most max calls in flight, first come first served; a failing call frees its slot

// tbuvLedger: src/tbuv-ledger.ts
export type RowKind = 'tombstone' | 'unverified';
export interface RepoRef { name: string; path: string }        // path: the repo root (the main worktree), by its real path
export interface LedgerRow {
  key: string; id: string; kind: RowKind; repo: string; repoPath: string;
  date?: string;            // 'YYYY-MM-DD'
  claim?: string; doubt?: string; settlesIt?: string; raisedBy?: string;
  status: string;           // lower-cased; 'open' when absent
  supersededBy?: string;
  open: boolean;
  raw: Record<string, unknown>;
}
export interface LedgerRead {
  rows: LedgerRow[];
  unavailable: boolean;     // git could not run, the ref is unsafe, or neither file could be read
  note?: string;            // a file that was there but could not be read: 'tombstones.jsonl is larger than 2 MiB', 'git timed out reading unverified.jsonl'
}
export const DEFAULT_LEDGER_REF = 'wiki';
export const MAX_LEDGER_BYTES = 2 * 1024 * 1024;
export function isOpen(status: string | undefined, supersededBy?: string): boolean;
export function parseLedger(jsonl: string, kind: RowKind, repo: RepoRef): LedgerRow[];   // blank, malformed and non-object lines skipped; the first row for an id wins
export function readLedger(run: Runner, repo: RepoRef, ref?: string): Promise<LedgerRead>;
export function uniqueRepoNames(repos: RepoRef[]): RepoRef[];                             // depends on the paths only, idempotent
export function discoverRepos(run: Runner, dirs: string[]): Promise<RepoRef[]>;          // worktrees of one repo, and a symlinked spelling of its path, collapse to one entry; non-repos are skipped

// grounding: src/grounding.ts
export interface Cite { raw: string; path: string; startLine: number; endLine: number; sha?: string; quote?: string }
export interface Grounding { status: 'grounded' | 'ungrounded'; sha?: string /* 7 chars, set when grounded */; reason?: string /* set when ungrounded */ }
export function parseCite(text: string): Cite | null;
export function groundCite(run: Runner, gitDir: string, cite: Cite): Promise<Grounding>;   // gitDir: the checkout the agent was in

// lightningFormat: src/lightning-format.ts  (the prompts themselves live in src/prompts.ts)
export type Needs = 'human' | 'agent' | 'none';
export type Nature = 'decision' | 'fact' | 'measurement';
export type Checkable = 'now' | 'later' | 'never';
export type Verb = 'confirm' | 'deny' | 'challenge' | 'no_change';
export type Letter = 'A' | 'B' | 'C' | 'D';
export interface RawOption { letter: Letter; verb: Verb; title: string; cites: number[]; why: string }
export interface RawPresentation { id: string | null; repo: string | null; needs: Needs | null; nature: Nature | null; checkable: Checkable | null; title: string; claim: string; assessment: string; evidence: string[]; options: RawOption[] }
export interface RawVote { id: string | null; repo: string | null; vote: 'concur' | 'concern' | 'refuted'; prefers: Letter | null; reason: string }
export interface VoteTally { concur: number; concern: number; refuted: number; silent: number; asked: number }
export function parsePresentation(text: string, expectId?: string, expectRepo?: string): RawPresentation | null;
export function parseVote(text: string, expectId?: string, expectRepo?: string): RawVote | null;
export function hasFence(text: string, info: string): boolean;                                          // the text opens this fence, closed or not
export function namesAnotherRow(text: string, info: string, expectId: string, expectRepo?: string): boolean;
export function tallyVotes(votes: Array<RawVote | null>): VoteTally;   // null = asked, did not answer → silent
export function verbLabel(v: Verb): string;                           // 'Confirm' | 'Deny' | 'Challenge' | 'No change'

// standup: src/standup.ts
export type Lane = 'triage' | 'agents' | 'lightning';
export interface BoardItem {
  id: string;               // 'branch:<repo>:<ticket key or branch name>' | 'session:<sessionID>' | the LedgerRow.key
  lane: Lane; title: string; detail?: string; repo?: string;
  state: string;            // 'branch' | 'working' | 'blocked' | 'stopped' | 'open' …
  tint: Tint;               // from status-report.ts
  refs: string[];           // ticket keys, 'ABC-123'
  sources: Array<'git' | 'sessions' | 'ledger'>;
  sessionIDs?: string[];    // triage: sessions in the same repo on the branch, or whose name mentions the ticket
  rowKey?: string;          // lightning only
  at?: number;              // epoch ms of the last activity
}
export interface SourceChip { id: 'git' | 'ledger' | 'sessions'; label: string; count: number; note?: string }
export interface Standup {
  at: number; covering: string; through: string; run: string;   // 'YYYY-MM-DD', local dates
  windowStart: number; windowEnd: number;                         // epoch ms
  sources: SourceChip[];                                          // raw counts per source
  lanes: Record<Lane, number>;                                    // after the join
  board: BoardItem[];                                             // triage, then agents, then lightning
}
export interface SessionActivity { lastAt: number | null; lastStatus: Status | null; lastScope: string | null }
export interface StandupDeps { clock: Clock; run: Runner; repos: RepoRef[]; agents: Agent[]; activity: (a: Agent) => Promise<SessionActivity> }
export interface StandupOptions { covering?: string; ticketPrefixes?: string[]; ledgerRef?: string; hidden?: (rowKey: string) => boolean; defaultBranches?: string[] }
export function standupWindow(now: number, covering?: string): { covering: string; through: string; run: string; start: number; end: number };
export function orderLightningRows(rows: LedgerRow[], window?: { start: number; end: number }): LedgerRow[];
export function buildStandup(deps: StandupDeps, opts?: StandupOptions): Promise<Standup>;
export function renderStandupText(s: Standup): string;

// lightning: src/lightning.ts
export type ItemPhase = 'queued' | 'presenting' | 'presented' | 'fallback' | 'decided' | 'deferred';
export interface PresentedEvidence { n: number; raw: string; cite: Cite | null; grounding: Grounding }   // n is 1-based, the number options cite
export interface PresentedOption extends RawOption { grounding: 'grounded' | 'ungrounded' }
export interface Presentation {
  source: 'agent' | 'ledger'; presentedBy: string;
  needs: Needs | null; nature: Nature | null; checkable: Checkable | null;
  title: string; claim: string; assessment: string;
  evidence: PresentedEvidence[]; options: PresentedOption[];
}
export interface VoteEntry { sessionID: string; name: string; vote: RawVote['vote'] | null; prefers: Letter | null; reason: string }
export interface LightningItemView {
  key: string; id: string; kind: RowKind; repo: string;
  title: string; summary: string;                          // '<ID> <claim>' and '<repo>. Doubt: <doubt>' ('<repo>.' with no doubt)
  row: Omit<LedgerRow, 'raw'>;
  phase: ItemPhase; presentation: Presentation | null;
  rev: number;                                             // goes up every time the presentation is set, replaced or dropped
  votes: { asked: boolean; tally: VoteTally; entries: VoteEntry[] };
  decision: { option: Letter; verb: Verb; at: number; delivered: boolean } | null;
}
export interface LightningView {
  active: boolean; current: string | null; panelSize: number;
  items: LightningItemView[];                              // queue order, decided and deferred items included
  counts: { total: number; remaining: number; decided: number; deferred: number };
  log: string[];                                           // the last 20 status lines, oldest first
}
export interface ApproveResult { delivered: boolean; decided: boolean }   // decided: the row is settled for this round, whether or not anything was sent
export class StaleCardError extends Error {}                              // 'The card for <key> changed; look again.'
export class DecisionStore { constructor(kv: KV, clock: Clock); hidden(key: string): boolean; record(key: string, rec: { state: 'decided' | 'deferred'; option?: Letter; verb?: Verb }, until: number): void }
export class LightningRound { /* §6.2 */ }
```

## 4. Wire formats

Both are fenced blocks with a distinct info string, with the fence syntax of `cim-status` (`fencedBlock` in `status-report.ts`): `key: value` lines and `- ` list lines under a bare `key:`. The block is read as text and never trusted: a field outside its listed words is `null`, never guessed.

````text
```cim-lightning
id: UV-0036
repo: shop-app
needs: human | agent | none
nature: decision | fact | measurement
checkable: now | later | never
title: <one line>
claim: <the claim restated in one sentence>
assessment: <two or three sentences: what the evidence shows>
evidence:
- <path>:<line or first-last>@<commit sha> "<short verbatim quote, optional>"
options:
- A | challenge | <short title> | 1,2 | <one-sentence rationale>
- B | deny | <short title> | 1 | <one-sentence rationale>
- C | no_change | <short title> | | <one-sentence rationale>
```
````

- The ask fills in `id:` and `repo:` with the row's id and repo name (quoted). A reply with no `repo:` line is accepted; one with a `repo:` line must name this repo (compared case-insensitively after the same 120-character cut the ask used).
- **Echoed template.** A value that is a bare `<placeholder>` is the ask's template echoed back and is left out. A `|` in `needs`, `nature`, `checkable`, `vote` or `prefers` is the template's list of words and the field is left out. Every other field keeps its pipes: a claim or a reason may contain `|`.
- **Several blocks.** Every closed fence with the info string is read, in order, from at most the first 8 opening lines; a block over 32,768 characters is skipped. The first usable block that is about this row wins, so an agent that answered two asks in one text, or put a quoted example before its answer, is still read.
- An option line is `letter | verb | title | cite numbers | why`; `why` is everything after the fourth pipe (it may contain pipes and may be empty; the title may not). Letters A to D, a repeated letter keeps its first line. `verb` accepts `confirm`, `deny`, `challenge`, and `no_change` written `no change`, `no-change`, `nochange` or `no_change`, in any case.
- **Cite numbers** are 1-based indexes into `evidence`: positive whole numbers separated by commas, semicolons or spaces, optionally in brackets or after a `#`, `1-3` for a range, each once, at most 20. A field with anything else in it (a word, a full stop, a stray hyphen) is prose and cites nothing; the digits inside "none (checked 2 files)" are not evidence 2.
- **Usable** = the fence closes, `id` matches the row when one is expected (case-insensitive), `repo` matches when both are given, at least two well-formed options, and a non-empty `claim` or `assessment`. Anything else is `null`.
- Clips: `title` 200 characters, `claim` and `assessment` 1,500 each, 20 evidence lines of at most 1,000, option titles 200 and rationales 1,500.
- An evidence line is `<path>:<line>[-<last>][@<sha>]`, optionally followed by a double-quoted verbatim quote. The path has no whitespace, colon or double quote, so a cite whose path has a space in it is not recognised (§8).
- **Classifying one reply text** (`classify` in `lightning.ts`): *usable* (a winning block); *unusable* (it opens the fence but no block is usable and not every block names another row); *foreign* (every fence it opens names another id, or this id under another repo: neither a win nor a failure of this ask); *chatty* (no fence at all, ignored).

````text
```cim-vote
id: UV-0036
repo: shop-app
vote: concur | concern | refuted
prefers: A | B | C | D | none
reason: <one sentence>
```
````

A vote is the first `cim-vote` block (of at most 8) with a recognised `vote` word that is about this row; `prefers` is a letter or `null`; `reason` is clipped to 1,500 characters. When a transcript read returns several texts, the last vote among them counts.

## 5. Rules the code keeps

**Security.** Agent replies and ledger rows are untrusted text.
- A cite's `path` and `sha` reach `git` as argv. `sha` is lower-cased and must match `^[0-9a-f]{7,40}$`; `path` must not start with `-`, contain a `..` segment, a NUL or a backslash. Violations are `null` from `parseCite`, and `not a valid citation` from `groundCite` for a hand-built `Cite`; never a thrown error. An absolute path is accepted by `parseCite` as text (agent tools print them): `groundCite` maps one that lies inside the checkout's repo to a repo path and answers `outside the repository` for any other, so git never sees an absolute path. The commit git prints for the cite is checked against `^[0-9a-f]{7,64}$` before it is used as argv again.
- The ledger ref from settings must not start with `-` and contains no whitespace or NUL; otherwise the repo's ledger reads as unavailable.
- Ledger ids are plain identifiers (§2).
- Git is only ever run through the injected `Runner`, argv arrays, never a shell string; every git call has a timeout (20 s). Output is capped while git runs, not after: a ledger file at 2 MiB, a ref listing at 4 MiB, a file being grounded at 2 MiB (its size is asked first). At the cap the child is killed and the result says so (`truncated`); on a timeout it says `timedOut`. A cut-off or timed-out git is never read as an answer: a ledger file becomes a `note` (`<file> is larger than 2 MiB`, `git timed out reading <file>`), a ref listing makes the repo unreadable, a cite becomes ungrounded with `output too large` or `git timed out`.
- Git for the standup, the queue, the round's grounding and the sign-off lookup goes through one `limitRunner` with 8 slots, so a standup over many repos and sessions cannot use up the process's file descriptors.
- Text goes to the panel through `textContent` only (the panel test enforces it). Text that goes to **another agent** (the present ask, the vote ask, the decision relay) is fixed template plus quoted data. `quoted()` drops invisible format characters (zero-width, bidi controls, the U+E0000 tag block), turns every run of whitespace or control characters into one space, replaces a run of three or more backticks, and cuts the value to a limit (600 by default; 80 for an id, 120 for a repo, 200 for a title, 400 for a rationale in a vote ask). Row ids, repo names and option letters and verbs are quoted too; a curly quote inside a quoted span is straightened so the span has exactly one end. The text the decision relay adds for each verb and row kind is fixed (`DECISION_ACTION` in `prompts.ts`) and holds nothing quoted.
- **What sends.** A GET, the standup build, and a board click outside a round send nothing. Presenting sends one ask, in turn to up to `maxPresenters` (2) agents that work in the row's repo, the second only if the first did not give a usable block; an active round presents the current card and the next `prefetch` (1) as soon as it starts, and selecting a card that has not been presented presents it. Asking skeptics and relaying a decision are explicit POSTs from the human.

**Async.** Every git call, socket and file read is asynchronous (README §8). No poll loop outlives its round: `abort()` and `hub.stop()` cancel them, and a test proves that after an abort nothing sleeps, reads or sends again.

**Failure never reads as empty.** A source that cannot be read is a `note` on its chip, not a silent zero (§6.1). One failing source does not fail the standup. A round that is empty because the repositories or ledgers could not be read says why in its log (§6.4).

**Dates** are local (`new Date(y, m, d)`), so a day boundary is the user's midnight and DST does not shift it.

## 6. Behaviour

### 6.1 Standup

`standupWindow(now, covering?)`: `run` is the local date of `now`. Without `covering`, `covering` is the previous weekday (Tue→Mon, Mon→Fri, Sat→Fri, Sun→Fri), the window is `[covering 00:00, run 00:00)` so a Monday standup spans the weekend, and `through` is the last day inside the window. With `covering` (`YYYY-MM-DD`, validated as a real date; `POST /standup` answers 400 for any other) the window is that one day and `through === covering`.

Sources, each independent and each guarded (one that throws is a note and a count of 0, not a failed standup):
- **Local git** (`git`): per repo, one `for-each-ref --sort=-committerdate --format=%(refname)%09%(committerdate:unix)%09%(objectname:short)%09%(subject) refs/heads refs/remotes`, capped at 4 MiB. A ref counts when its commit date is inside the window. `origin/x` and `x` are one branch (the newest ref speaks for it). `HEAD`, the default branches (`main`, `master`, `develop`, `trunk`) and the ledger ref are not items. Chip count: branches in the window, over all repos.
- **Sessions** (`sessions`): every visible agent (listed once per session id) that is live, or whose last transcript turn is inside the window (`SessionActivity.lastAt`). Chip count: those sessions.
- **Ledger** (`ledger`): every row of every repo's ledger (`readLedger`), open or closed, hidden or not. Chip count: **all the rows read**. The Lightning lane is a different number: the open rows the decision store does not hide.

Chip notes (the chip is amber and shows the note in the panel):

| Chip | Note | When |
|---|---|---|
| Local git | `no repository` | no repo was found |
| Local git | `git unavailable` / `git unavailable in N of M repos` | git failed, was cut off or timed out in all / some repos |
| Local git, Ledger, Sessions | `git unavailable` / `ledger unavailable` / `sessions unavailable` | the whole source threw |
| Ledger | `no repository` | no repo was found |
| Ledger | `<file> is larger than 2 MiB`, `git timed out reading <file>`, prefixed with `<repo>: ` when there is more than one repo | a ledger file was there and could not be read; its rows are missing |
| Ledger | `no ledger` | no repo's ledger could be read and no file said why |
| Sessions | `activity unavailable for N of M sessions` | reading a session's transcript failed; it counts as no activity |
| Sessions | `roster unavailable: <message>`, in front of the note above, joined by `; ` | the hub's last roster read failed (one line, cut at 200 characters) |

Join (Triage lane): each branch carries the ticket keys found in its name and its newest commit subject. Branches of one repo that share a key, directly or through a third branch, merge into one item (union-find, near-linear in the number of branches); a branch with no key is its own item. A ticket key is `[A-Z][A-Z0-9]+-\d+` written in capitals (`ABC-123`), or with any capitalisation when its prefix is a configured `ticketPrefixes` entry; it is uppercased. For each configured prefix the unhyphenated form (`abc123`, with no letter or digit touching it) is a key too. Prefixes that are never tickets, whatever the case or the configuration: `UTF`, `SHA`, `MD`, `ISO`, `RFC`, `AES`, `RSA`, `TLS`, `SSL`, `HTTP`, `HTTPS`, `WCAG`, `X`, `V`, `IPV`, `CVE`. The match uses word boundaries, so a key next to an underscore is not found (§8).

A session joins a triage item when it is in the same repo and either its checkout's current branch (`git rev-parse --abbrev-ref HEAD`, once per distinct cwd; none when detached) is one of the item's branches, or its name contains one of the item's keys. A session's repo is the deepest repo whose directory holds its cwd, or, for a linked worktree outside that directory, the repo whose git common dir the cwd names (compared by real path).

Lanes: `lanes.triage` = triage items; `lanes.agents` = counted sessions; `lanes.lightning` = open, un-hidden rows. Order inside Triage and Agents: needs-attention tints first (red, amber), then newest `at`. Order of the Lightning lane (and of a round's queue, which uses the last standup's window when there is one; `orderLightningRows`): rows dated inside the window first, then the rest, each oldest date first, rows with no readable date last; stable.

The board item per lane:

| | Triage | Agents | Lightning |
|---|---|---|---|
| `id` | `branch:<repo>:<first key of the newest branch, else its name>` | `session:<sessionID>` | the row key |
| `title` | the newest branch's name | the session's name (cut at 300 characters), else its project name | `<ID> <claim>` (cut at 300), the ID alone with no claim |
| `detail` | `+N more` when branches merged, else the newest commit's subject (cut at 300; absent when empty) | the `scope` of its last `cim-status` report (cut at 300) | the doubt (cut at 300) |
| `repo` | the repo | the repo it works in, else its project name | the repo |
| `state` | `branch` | `stopped`, else its last reported status, else `working` (busy) or `idle` | `open` |
| `tint` | `blue`; when joined sessions have reported a status, the worst tint among those statuses | `STATUS_TINT[lastStatus]`, else `grey` stopped, `blue` busy, `green` idle | `green` |
| `refs` | the keys of all its branches | the keys in the session's name | none |
| `sources` | `git`, plus `sessions` when sessions joined | `sessions` | `ledger` |
| `at` | the newest commit | the last transcript turn, else the start time | the row's date (local midnight) |

A triage item also carries `sessionIDs` when sessions joined; a Lightning item carries `rowKey`. The "last status" is the newest assistant turn in the transcript tail that parses as a `cim-status` report.

`renderStandupText` is the terminal rendering: `Morning Standup  covering <date>, run <date>` (`covering <a> through <b>` for a window of several days), the chips on one line separated by ` | ` (with `(note)`), the three lane counts, then the board, one line per item: `[lane] title  (repo)  refs`. A title is cut at 72 characters with `...`; control characters and bidi overrides in data become a space.

### 6.2 Lightning Round

`LightningRound` owns a queue of open rows. Constructor `(rows: LedgerRow[], deps: LightningDeps, opts?: { panelSize?: number; prefetch?: number })`; defaults `panelSize` 4, `prefetch` 1 (whole numbers from 0 up). A repeated row key keeps its first row.

```ts
export interface LightningDeps {
  clock: Clock; sleep: (ms: number) => Promise<void>; run: Runner;
  messageable: () => Agent[];                                  // the current messageable agents
  repoOf: (agent: Agent) => string | null;                     // the repo root the agent's cwd belongs to, or null
  sendInbox: (agent: Agent, text: string) => Promise<void>;
  transcriptSize: (agent: Agent) => Promise<number>;
  readSince: (agent: Agent, offset: number) => Promise<{ texts: string[]; endOffset: number }>;
  decisions: DecisionStore;
  onChange?: (r: LightningRound) => void;
  presentTimeoutMs?: number;  // 90_000 per presenter
  voteTimeoutMs?: number;     // 60_000
  pollMs?: number;            // 2_000
  maxPresenters?: number;     // 2
}
```

Public surface: `id`, `view(): LightningView`, `start()`, `select(key)`, `approve(key, letter, rev?)`, `reject(key)`, `defer(key)`, `askSkeptics(key)`, `abort()`, `note(text)`, `settle()` (resolves when no background task is running; for tests). Unknown keys throw `new Error('No lightning item <key>.')` (the daemon maps `No …` to 404). `note(text)` adds a line to the log from outside and reports the change; the hub uses it for a failure that happened before there were any items.

`start()` drops the rows the decision store hides, makes the first live row current and presents it and the next `prefetch` live rows. `select(key)` makes any item current, a settled one too (its history), and presents it if it is still queued. `counts.remaining` is `total − decided − deferred`. The view's `title` is `<ID> <claim>` (the presentation's title when the row has no claim).

**`rev`.** Each item has a `rev`, 0 until it is first presented, and up by one every time its presentation is set (an agent's block, or the ledger row), replaced, or dropped (Reject). It is the identity of "the card the human is looking at": a click made on one card must not land on another that was presented after a Reject.

**Present** (per item, started by `start`, `select`, and prefetch of the next `prefetch` queued items):
1. Candidates: messageable agents whose `repoOf` equals the row's `repoPath`, minus a session that already rejected this item and minus one with an unanswered ask about another row that has the same id; idle before busy, then roster order; at most `maxPresenters`.
2. For each candidate in turn: remember `transcriptSize`, send `lightningPresentAsk(row)`, then poll `readSince` every `pollMs` for new assistant texts, each classified as in §4. A *usable* text wins. An *unusable* text logs `<name> <shortID> replied without a usable block.` and moves to the next candidate at once. A *foreign* or *chatty* text is ignored. At `presentTimeoutMs`: if the agent wrote any other assistant text since the ask, the same "replied without a usable block" line; else `<name> <shortID> did not reply within <n>s.` If the size cannot be read or the send fails: `<name> <shortID> did not take the ask: <error>` and the next candidate. A read that fails is retried at the next poll and logged once per ask: `<name> <shortID> transcript could not be read: <error>`.
3. No candidate, or all failed: phase `fallback`, a presentation built from the row (`source: 'ledger'`, `presentedBy: row.raisedBy ?? ''`; options A Confirm (`The claim holds` / `The tombstone stands`), B Deny (`The claim is wrong` / `The tombstone is wrong`) and C No change (`Leave the row as it is`), all ungrounded, no tags; the assessment is the row's doubt and its `settles_it`). The log line is `No presentation for <key>: <reason> Showing the ledger row.` with reason `The present call timed out.` (a candidate timed out), `Nobody replied with a usable block.` (every candidate answered unusably or failed), `No agent in <repo> can be messaged.` (no agent works in the repo), or `The present call failed: <error>`. When the repo has agents but none was eligible (all rejected the row, or all are held by an ask about a same-id row) the card is shown without a line.
4. A winning block is **grounded** before it is shown: each evidence line goes through `parseCite` then `groundCite(run, presenter.cwd, cite)`, one after the other; an unparseable line is `{ cite: null, grounding: { status: 'ungrounded', reason: 'not a citation' } }`. An option is `grounded` when at least one cite it references is grounded, otherwise `ungrounded`. A card that left play while its cites were being checked is not shown.
   - A cite is **grounded** when its commit exists (the cite's sha, else the checkout's HEAD), the file is a text blob in that commit and not over 2 MiB, the lines exist, and a quote, when given, is in them (white space collapsed). Otherwise the reason is one of: `not a valid citation`, `no checkout to check against`, `commit <sha> not found`, `no commit at HEAD`, `outside the repository`, `<path> is not in <sha>`, `<path> is not a file`, `could not read the size of <path>`, `too large to check`, `could not read <path> at <sha>`, `binary file`, `lines <a>-<b> are beyond the end of the file (<n> lines)`, `quote not found in lines <a>-<b>`, `git timed out`, `output too large`. The panel shows the reason as text beside an UNGROUNDED pill.
   - A relative path is read the way the agent saw it, from its working directory, which may be below the repo root: `git rev-parse --show-prefix --show-toplevel` gives the checkout's folder below the root, `<prefix><path>` is tried first, and the repo-root path only when that file is not in the commit (a path that starts with `./` is from the checkout only). Where git cannot say, the path is a repo-root path.
5. Replies are matched on the id and the repo, not on the id alone (§4). An agent is never asked about two rows with the same id at once (ids are only unique per ledger file, so a TB and a UV, or two repos, can share one): a candidate or panel member with an unanswered ask for another row key with the same id is skipped without a word. The hold is released when the ask is answered, abandoned or the round stops, and, for a vote ask, as soon as that agent's vote is read. When that leaves nobody to ask (a TB and a UV that share an id in one repo, with one agent in it, is the case), the card shows the ledger row without a line in the log; Reject presents it again, which works once the agent's first ask is answered.

**Approve** `(key, letter, rev?)`:
- `rev`, when given, must equal the item's current `rev`, else `StaleCardError` (`The card for <key> changed; look again.`, HTTP 409) and nothing is sent. Without `rev` the letter applies to the card as it is.
- The letter must be one of the item's options, else `Option <L> is not offered for <key>.` (400). A decided item answers `{ delivered: false, decided: true }`; a card with nothing to act on, `{ delivered: false, decided: false }`; the item must be `presented` or `fallback`.
- `no_change` records the decision and sends nothing (`{ delivered: false, decided: true }`). The other verbs send `lightningDecision(row, option, presentation)` to the presenting agent (its current roster entry; for a ledger card, the first messageable agent in the row's repo). If there is nobody, the log says `Nobody in <repo> can be messaged: copy the decision by hand.`; if the send fails, `<name> did not take the decision: <error>`; either way `{ delivered: false, decided: false }` and **nothing is recorded**, so the row stays in the queue.
- On success: phase `decided`, `DecisionStore.record(key, …, now + 7 days)` (a store that fails logs `Could not save the decision for <key>: <error>` and the round goes on), the queue advances to the next live item, prefetch continues. Approves racing each other send once: the second waits for the first and answers `{ delivered: false, decided: <the first's> }`.
- The decision text names what to do by verb and row kind: Confirm on a tombstone sets its `status` to `confirmed`; Deny on a tombstone retracts it by superseding it; Confirm on an unverified claim marks it confirmed; Deny files a tombstone and closes the claim; Challenge amends the row and keeps it open.

**Reject** `(key)`: for a card that is `presented` or `fallback` in an active round and not being approved; otherwise it does nothing. It drops the presentation (`rev` goes up), clears the votes, remembers the presenter in `rejectedBy`, and puts the item at the back of the queue as `queued`; if it was the current card the next live one becomes current. When every agent in the repo has rejected it, it presents from the ledger row, without a log line. Nothing is sent to an agent.

**Defer** `(key)`: for any live item that is not being approved: `DecisionStore.record(key, { state: 'deferred' }, nextLocalMidnight)`; phase `deferred`; advance.

**Ask skeptics** `(key)`: the item must be `presented` or `fallback`. Candidates: messageable agents other than the presenter, not already on this card's panel, with no unanswered ask about a same-id row; same repo first, then the rest in roster order; at most `panelSize` seats in all, counting those already asked. Each gets `lightningVoteAsk(row, presentation)` (the presentation is quoted data: its title, claim, assessment and the options' letters, verbs, titles and rationales). With nobody to ask, the log says `No other agent can be messaged to vote on <key>.` and `votes.asked` stays false, so the human can try again later; `asked` turns true only when somebody was asked. A send that fails logs `<name> <shortID> did not take the vote ask: <error>`. Votes are read like presentations, `parseVote(text, row.id, row.repo)`, polled until everyone has answered, the card closes, or the round stops. After `voteTimeoutMs` the log says `<k> of <n> did not vote on <key> within <s>s. A late vote still counts.`, and a late vote does count for another 15 minutes while the card is open. A transcript that cannot be read leaves that agent silent in the tally and logs `<name> <shortID> transcript could not be read: <error>` once. `tally.silent` = asked − answered. A card that left play while the sizes were being read sends nothing.

**Abort**: stops every poller, sets `active: false`, leaves decisions already recorded, and sends cards that were still being presented back to `queued`. After an abort, no ask goes out and no transcript is read again. Ask skeptics sends nothing and logs `This round was stopped.` (once in a row); Reject does nothing; select switches the current card but presents nothing. Approve and Defer still act on the cards that exist: the panel offers Approve only (§6.6), the engine does not refuse Defer.

### 6.3 Persistence

`DecisionStore` keeps `{ [key]: { state, option?, verb?, at, until } }` under `KEYS.lightning` (`cimLightningDecisions`). `hidden(key)` is `until > now`. A stored value that is not a record is skipped. Entries more than 30 days past `until` are dropped on write. Decided and no-change rows come back after 7 days if the ledger still lists them open; deferred rows come back at the next local midnight.

### 6.4 Hub

New on `Hub`: `settings.ledgerRef` (default `'wiki'`), `settings.ticketPrefixes` (default `[]`); `standup: Standup | null`; `lightning: LightningRound | null` (kept after an abort so its log stays readable until the next start); `buildStandup(covering?)` (selects `{ kind: 'standup' }`); `openRows()`; `lightningStart({ keys?, repo?, panelSize? })`; `lightningView()`; `lightningSelect`, `lightningApprove(key, letter, rev?)` (returns `{ delivered, decided, view }`), `lightningReject`, `lightningDefer`, `lightningSkeptics`, `lightningAbort`. `Selection` gains `{ kind: 'standup' }`. `HubEvent` gains `{ type: 'standup' }` and `{ type: 'lightning' }`. `snapshot()` gains `standup: { at, covering, through, run, lanes } | null` and `lightning: { active, remaining, current } | null`. `stop()` aborts the round.

- **Which repos.** `refreshRepos` asks, for the `--repo` directory and every visible agent's cwd (at most 200 distinct directories), which repo it belongs to, applies `uniqueRepoNames` to the whole set, and rebuilds the map from cwd to repo that the round's `repoOf` reads. It runs at standup build, at queue read and at round start; an agent that appears mid-round is recognised at the next of these (§8).
- **Roster first.** The standup and the queue wait for the first roster read before they look at sessions, so a standup built a moment after start does not read an empty roster as zero sessions.
- **Git.** The standup, the queue, the round's grounding and `tbuvLookup` use a runner limited to 8 processes at a time; the roster and the spawner keep the plain one.
- **`lightningStart`.** Counts starts and aborts: a start that finds, after reading the queue, that a newer start or an abort happened installs nothing and starts nothing; it returns the view as it stands. It narrows the queue to `keys` and then to rows whose repo name equals `repo` (`a~app` for repos that share a folder name), stops the old round in the same step that installs the new one, and starts it. An empty queue is a round with nothing in it, not an error, and the log says why when it can: `No repository found: pass --repo or start an agent inside one.`, `No repository named <repo>; the repositories are <a>, <b>.`, `No ledger could be read in <n> repo(s): <reasons>.`, `Part of the ledger could not be read in <n> repo(s): <reasons>.` (reasons are `<repo>: <why>` joined by `; `, and just the reason with one repo).
- **`tbuvLookup`** reads through `readLedger` (one parser for both features), with the ledger ref from settings. The sign-off sheet behaves as before except for these changes: a date is cut to `YYYY-MM-DD` (a date that is not a real one is absent, and then `ts` is tried; a numeric `ts` becomes its local day instead of the number as text); a field that is not a string is ignored instead of converted with `String()`, and text is trimmed; an id must be a plain identifier (§2), and a row with another id is skipped; `superseded_by` may also be a number or a list, and wins over `supersededBy` when a row has both (the old lookup preferred `supersededBy`); the ledger ref is `settings.ledgerRef`, not always `wiki`; a ledger file over 2 MiB reads as not found (the lookup ignores the `note`), because git is killed at the cap.

### 6.5 HTTP and CLI

```
GET  /standup              the last Standup, or 404 "No standup yet; POST /standup first."
POST /standup              { covering?: 'YYYY-MM-DD' } → Standup; selects the standup; 400 for a covering that is not a string or not a real date
GET  /lightning            LightningView ({ active: false, … } when no round)
POST /lightning/start      { keys?: string[], repo?: string, panelSize?: 0..12 } → LightningView; 400 for a wrong type
POST /lightning/select     { key } → LightningView
POST /lightning/approve    { key, option: 'A'..'D', rev?: n } → { delivered, decided, view }
POST /lightning/reject     { key } → LightningView
POST /lightning/defer      { key } → LightningView
POST /lightning/skeptics   { key } → LightningView   (returns once the asks are sent)
POST /lightning/abort      → { ok: true }
```

Errors: an unknown key, or a select, approve, reject, defer or skeptics call before a round was started, is 404 (`No lightning item <key>.`, `No lightning round yet; POST /lightning/start first.`). `approve` answers 400 for an `option` outside A to D, a letter the card does not offer, or a `rev` that is not a whole number from 0 up, and **409** when `rev` is not the card's current `rev`. The events stream `GET /events` gains `standup` and `lightning`.

`agentim standup [--date YYYY-MM-DD] [--json]` prints `renderStandupText` (or the JSON). `agentim lightning start [--repo NAME] [--panel N]`, `lightning show`, `lightning approve <key> <A-D> [--rev N]`, `lightning reject <key>`, `lightning defer <key>`, `lightning skeptics <key>`, `lightning abort` print the view as JSON (`approve` prints the result); `--rev` is the `rev` of the card in `lightning show`, and a value that is not a whole number is an error. `lightning start` from the command line takes every open row; the panel's Start Lightning sends the keys of the lane it shows. `serve` gains `--ledger-ref REF` and `--ticket-prefix PFX` (repeatable). Every flag takes `--flag value` or `--flag=value`.

### 6.6 Panel

Header: `Morning Standup` button, between Find Volunteer and New Group. Selecting it calls `POST /standup`; the standup band at the top shows the title and `covering <date>, run <date>`, the source chips, **Abort** (while a round is active) and **Back to agents** (`POST /selection/clear`). The left column becomes the navigator: the three lanes with counts and a filled dot on the open one, then the Board for that lane. The open lane is the Lightning lane once a round has started (a stopped round stays on screen), else Triage, unless the person chose.

- A source chip is green; with a note it is amber, the note is part of the chip's text and the chip carries a warning mark.
- A board row has a tint dot, a title clipped with an ellipsis, and the repo in parentheses for branches and sessions. In a round the highlighted row follows the current card and is scrolled into view when it changes (the person's own scrolling is kept). A row the panel saw decided or deferred since the board was built is dimmed; the panel remembers that until the standup is rebuilt.
- **Start Lightning** at the top of the Lightning lane starts a round over the lane's rows (disabled with none), replacing a running one; a line beside it reads `<n> of <total> left, <n> decided, <n> deferred`, plus `, stopped`. From then on the card follows the round's `current`. Clicking a Lightning row in a round selects it, which presents it if it has not been. A row that is not in the round shows its fields, and **Present this one** when no round is running, `Not in the running round.` while one is, `Decided: option C (Deny)` or `Deferred until tomorrow.` when it was settled.
- The card is §1 point for point: tag pills (`NeedsHuman`, `decision`, `checkable now`), title, summary, `Presented by …`, claim, assessment, evidence lines with a number, a `grounded @sha` or `UNGROUNDED` pill, the cite, its quote and the reason as visible text, options with letter, verb, title, pill, a visible reason (`cites no grounded evidence.`, `cites nothing.`), the rationale and `(cites 1, 4)`, a collapsible votes row, the hint line, and **Approve / Reject / Defer** (Approve disabled until a letter is picked). The hint says what Approve will do (`Approve sends option A (Challenge) to <agent>.` or `Approve records option C and sends nothing.`). The votes summary reads `Votes: 0 concur, 0 concern, 0 refuted, 4 silent` once somebody was asked, else `Votes: not asked` with **Ask skeptics**; when the round's log holds `No other agent can be messaged to vote on <key>.` the line `Nobody could be asked.` is shown beside the button, and the summary stays `Votes: not asked` rather than a tally of zeros.
- Keys `A` to `D` pick and `Enter` approves, unless a text field or a button has focus, a modifier key is held or a sheet is open. With the Votes summary focused `A` to `D` still work and `Enter` opens or closes it. A mouse click on the summary hands focus back to the page, so `Enter` approves after one.
- A pick belongs to the presentation it was made on: it is stamped with the card's `rev`, the option's verb and its title, and dropped when any of them changes or a new round starts. Approve sends the `rev` it saw; on a 409 the panel shows the toast `The card changed; look again.`, drops the pick and reloads.
- In a stopped round the card offers Approve only, under the line `This round was stopped, so Reject, Defer and Ask skeptics are off. Approve still works.`
- A control reached with the keyboard keeps focus across a repaint, and a card's own controls are named with the item key so focus never lands on the next card's button. After a mouse click focus is not restored, which is what lets `A` to `D` and `Enter` work right after a click.
- The round's `log` is shown under the card, one line each.
- Triage and Agents items: the detail shows the fields (triage: repo, detail, ticket keys, last commit, the joined sessions as links, sources; agents: repo, last scope, ticket keys, last activity, directory, session id) and, for sessions, **Open thread** (selects the agent).
- Same constraints as the rest of the panel: nodes through `h()`, text through `textContent`, no inline style or script, tokens from `:root`, light and dark. Pill, chip and primary-button text meets 4.5:1 against its background in both schemes; the primary buttons use dark text on the accent.

### 6.7 Demo

`serve --demo` runs the standup and the round with no Claude Code and no git: `run` answers `git` from a table for one invented repo, `instrument`, whose branches and ledger rows are dated against the standup window so the first standup of any day finds them. The ledger has nine rows (seven open: six UV and one TB; one TB closed by `superseded_by`, one UV confirmed). A first standup reads Local git 6, Ledger 9, Sessions 6 and Triage 5, Agents 6, Lightning 7. The roster is seven fake agents: five with an inbox (`instrument-62` busy and an idle merge-conflict agent, both in the repo; `docs sweep`, `gateway tracing` and `infra cleanup` elsewhere), a stopped background agent, and a session with no inbox. UV-0036 is presented by the idle repo agent with four cites (three grounded, one in a file that is not there), UV-0021 falls back to the ledger row (the first presenter answers with a block that has one option and the second never answers), the other rows get a generic card with one cite past the end of the file, and a vote table gives named agents a concur, a concern or a refutation, and any other agent stays silent, so a panel shows silent seats. The round's timings are shortened (poll 300 ms, present 4 s, vote 6 s).

## 7. Tests

Unit tests of the pure logic with fake runners, clocks and transcripts, like the rest of the suite; no browser in CI. Each module has its own `test/*.test.ts`: `tbuv-ledger`, `grounding`, `lightning-format`, `standup`, `lightning`, `limit`, `args`, and `runner` (which spawns real child processes for the output cap and the timeout). The hub and the daemon routes are covered in `standup-hub.test.ts` and `standup-daemon.test.ts` against one fake machine (`standup-world.ts`: a clock whose sleep advances it, git as tables, transcripts and an inbox whose agents answer an ask). `panel.test.ts` runs `panel.js` in a `vm` against a small fake DOM and a canned server, and recomputes the colour contrast from the CSS tokens. `npm test` runs 836 tests in 25 files.

## 8. Known limits (decided, not fixed)

- **The repo map is refreshed at standup build, queue read and round start.** An agent that starts working in a repo, or in a new directory, mid-round is recognised as a presenter or a skeptic at the next refresh, not before.
- **The sign-off lookup skips a ledger file over 2 MiB.** The reader reports it in `LedgerRead.note` and the standup shows it on the Ledger chip and the round's log, but `tbuvLookup` ignores the note, so the sign-off sheet shows those rows as not found.
- **A tag named like the ledger ref shadows the branch.** The ledger is read with `git show <ref>:<file>`, which resolves a tag before a branch of the same name (git warns about the ambiguous name).
- **Cites with a space in the path are not recognised.** The evidence line is shown as it was written and marked UNGROUNDED (`not a citation`).
- **A ticket key next to an underscore is not found** (`fix_ABC-123`, `ABC-123_retry`): the key match uses word boundaries and an underscore is a word character.
- **No paging.** `GET /lightning` carries every item of the round and the panel draws the whole board; a queue of hundreds of rows makes large responses (a mocked board of 98 rows was checked in the browser).
- **The lane buttons are announced as radio buttons but do not respond to the arrow keys** (Tab and Enter work).
- **The asks have not been tried against a live model.** The tests and the demo use fake agents. An agent that does not answer in the block as asked is handled (the next candidate, then the ledger row, with a log line saying why), but how often real agents comply, and whether the wording of the asks in `prompts.ts` needs tuning, is not known until a live run.
- Not built: the GitLab and Jira sources, a `StandupSource` interface, ledger writes by cIM, auto-forwarding between agents.

## 9. Verified

**By unit tests** (§7): the ledger reader and the sign-off lookup against fake git (caps, notes, ids, dates, repo naming), grounding (argv validation, relative and absolute cites, every reason string), both block formats (pipes, several fences, cite numbers, reply identity), the standup (window, join, chips, notes, board), the round (presenting ladder, same-id holds, approve and `rev`, reject, defer, skeptics, abort leaving nothing sleeping), the hub and the HTTP routes end to end on a fake machine, the CLI argument reader, the output cap and timeout with real processes, and the panel script and its colours.

**By hand, in a browser against `serve --demo`** (Chromium, 1280x800 and 800x700, dark and light, with no console or page errors): the standup, Start Lightning, picking by keyboard and approving with Enter, Ask skeptics, Reject, Defer, a second round, a settled row, a row outside the running round, Abort, a reload with a round running, an abort from the command line, Back to agents. The amber chip with a note, the line `Nobody could be asked.`, a 409 on approve and a board of 98 rows cannot be produced by the demo, so those were checked against mocked `GET /standup` and `GET /lightning` responses (Chromium logs its own `Failed to load resource` line for the 409). The contrast of pills, chips and primary buttons was measured in the browser: the lowest ratio is 4.68 in the light scheme and 5.02 in the dark. The built command line was run against the demo for the `=` flag form and `--rev`. Cites in a subdirectory, with `./` and as absolute paths were checked against real git, as were a symlinked repo path and a 300 MB blob on the ledger ref (read as `tombstones.jsonl is larger than 2 MiB` in 20 ms instead of crashing).

The agents in all of these are fakes: the test doubles and the demo's canned replies.

**Review.** The change was reviewed through six lenses (the round, the data layer, security, the integration, the panel, and conformance to the screenshot and the docs); each finding was checked by two skeptics, one trying to reproduce it and one trying to refute it, and 66 of the 68 findings held up. The ones that mattered were fixed with a regression test that fails on the old code; the ones decided against are in §8. One more defect was found after the review, by reading the fix reports: `runCommand` registered its `error` listener after first touching the child's streams, so a failed spawn (`EMFILE`) could kill the process. It is fixed and has a test.
