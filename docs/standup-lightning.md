# Morning Standup and the Lightning Round

Two modes added to the cIM pane, reverse-engineered from a photo of the WikiWidget cIM tab. This document is the contract the code is written against. §1 says what the photo shows and what was inferred; the rest is the design.

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
- `No presentation for uv:<repo>:UV-0021: The present call timed out.. Showing the ledger row.`

### Inferences (a good guess, not read off the screen)

| Observation | Inference |
|---|---|
| GitLab 18 + Jira 3 + Local git 18 = 39, lane says Triage 29 | Chips count raw items per source; lanes count items **after joining on ticket key or branch**. |
| Agents 43 = Sessions 43 | The Agents lane is one item per session. |
| Ledger 101, Lightning 98 | Lightning is the **open** ledger rows (not already settled or snoozed). |
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
- The decision relay: Approve sends the human's choice to the agent as an instruction; **the panel never writes the ledger files** (same rule as the TB/UV sign-off).
- Votes are **opt-in** (an "Ask skeptics" button), because asking four agents per card would interrupt the fleet 98 times.

### Scoped out of this version

- **GitLab and Jira sources.** The sources are an interface (`StandupSource`-shaped functions in `standup.ts`); this version ships Local git, Ledger and Sessions. The two forge chips are the next layer.
- Any write to the ledger by cIM itself, auto-forwarding between agents, browser tests in CI.

## 2. Vocabulary

- **TB**: a tombstone row (`tombstones.jsonl`). **UV**: an unverified-claim row (`unverified.jsonl`). Both live on the repo's **ledger ref** (default `wiki`), read with `git show <ref>:<file>`, as `tbuvLookup` already does.
- **Row**: one JSON object per line. Known fields (all optional except `id`): `id`, `date` or `ts`, `claim`, `doubt`, `settles_it`, `status`, `superseded_by`, `raised_by` (or `skeptic`, `by`). Unknown fields are kept in `raw` and ignored.
- **Open row**: `status` is absent or not one of `settled, confirmed, denied, superseded, resolved, closed, done, wontfix, withdrawn` (case-insensitive), **and** `superseded_by` is not set. An unknown status reads as open: nothing silently disappears.
- **Key**: `tb:<repo>:<ID>` or `uv:<repo>:<ID>`; `<repo>` is the repo root's folder name, `<ID>` uppercased.

## 3. Data model

All of these are exported from the module named in the comment. Names and shapes are fixed; add fields rather than renaming.

```ts
// tbuvLedger: src/tbuv-ledger.ts
export type RowKind = 'tombstone' | 'unverified';
export interface RepoRef { name: string; path: string }        // path: the repo root (the main worktree)
export interface LedgerRow {
  key: string; id: string; kind: RowKind; repo: string; repoPath: string;
  date?: string;            // 'YYYY-MM-DD' (an ISO timestamp is cut to its date)
  claim?: string; doubt?: string; settlesIt?: string; raisedBy?: string;
  status: string;           // lower-cased; 'open' when absent
  supersededBy?: string;
  open: boolean;
  raw: Record<string, unknown>;
}
export interface LedgerRead { rows: LedgerRow[]; unavailable: boolean }  // unavailable: git could not run, or neither file could be read
export const DEFAULT_LEDGER_REF = 'wiki';
export function isOpen(status: string | undefined, supersededBy?: string): boolean;
export function parseLedger(jsonl: string, kind: RowKind, repo: RepoRef): LedgerRow[];   // blank and malformed lines skipped; the first row for an id wins
export function readLedger(run: Runner, repo: RepoRef, ref?: string): Promise<LedgerRead>;
export function discoverRepos(run: Runner, dirs: string[]): Promise<RepoRef[]>;          // worktrees of one repo collapse to one entry; non-repos are skipped

// grounding: src/grounding.ts
export interface Cite { raw: string; path: string; startLine: number; endLine: number; sha?: string; quote?: string }
export interface Grounding { status: 'grounded' | 'ungrounded'; sha?: string /* 7 chars, set when grounded */; reason?: string /* set when ungrounded */ }
export function parseCite(text: string): Cite | null;
export function groundCite(run: Runner, gitDir: string, cite: Cite): Promise<Grounding>;

// lightningFormat: src/lightning-format.ts  (the prompts themselves live in src/prompts.ts)
export type Needs = 'human' | 'agent' | 'none';
export type Nature = 'decision' | 'fact' | 'measurement';
export type Checkable = 'now' | 'later' | 'never';
export type Verb = 'confirm' | 'deny' | 'challenge' | 'no_change';
export type Letter = 'A' | 'B' | 'C' | 'D';
export interface RawOption { letter: Letter; verb: Verb; title: string; cites: number[]; why: string }
export interface RawPresentation { id: string | null; needs: Needs | null; nature: Nature | null; checkable: Checkable | null; title: string; claim: string; assessment: string; evidence: string[]; options: RawOption[] }
export interface RawVote { id: string | null; vote: 'concur' | 'concern' | 'refuted'; prefers: Letter | null; reason: string }
export interface VoteTally { concur: number; concern: number; refuted: number; silent: number; asked: number }
export function parsePresentation(text: string, expectId?: string): RawPresentation | null;
export function parseVote(text: string, expectId?: string): RawVote | null;
export function tallyVotes(votes: Array<RawVote | null>): VoteTally;   // null = asked, did not answer → silent
export function verbLabel(v: Verb): string;                           // 'Confirm' | 'Deny' | 'Challenge' | 'No change'

// standup: src/standup.ts
export type Lane = 'triage' | 'agents' | 'lightning';
export interface BoardItem {
  id: string;               // 'branch:<repo>:<name>' | 'session:<sessionID>' | the LedgerRow.key
  lane: Lane; title: string; detail?: string; repo?: string;
  state: string;            // 'branch' | 'working' | 'blocked' | 'stopped' | 'open' …
  tint: Tint;               // from status-report.ts
  refs: string[];           // ticket keys, 'QP-27153'
  sources: Array<'git' | 'sessions' | 'ledger'>;
  sessionIDs?: string[];    // triage: sessions whose checkout is on the branch, or whose name mentions the ticket
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
export function standupWindow(now: number, covering?: string): { covering: string; through: string; run: string; start: number; end: number };
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
  title: string; summary: string;                          // 'UV-0036 <claim>' and '<repo>. Doubt: <doubt>'
  row: Omit<LedgerRow, 'raw'>;
  phase: ItemPhase; presentation: Presentation | null;
  votes: { asked: boolean; tally: VoteTally; entries: VoteEntry[] };
  decision: { option: Letter; verb: Verb; at: number; delivered: boolean } | null;
}
export interface LightningView {
  active: boolean; current: string | null; panelSize: number;
  items: LightningItemView[];                              // queue order
  counts: { total: number; remaining: number; decided: number; deferred: number };
  log: string[];                                           // the last 20 status lines, oldest first
}
export class DecisionStore { constructor(kv: KV, clock: Clock); hidden(key: string): boolean; record(key: string, rec: { state: 'decided' | 'deferred'; option?: Letter; verb?: Verb }, until: number): void }
export class LightningRound { /* §6 */ }
```

## 4. Wire formats

Both are fenced blocks with a distinct info string, parsed like `cim-status` (`fencedBlock` in `status-report.ts`): `key: value` lines, `- ` list lines, a value containing `|` is the ask's own template echoed back and is ignored.

```text
```cim-lightning
id: UV-0036
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
```

- An option line is `letter | verb | title | cite numbers | why`; `why` is everything after the fourth pipe (it may contain pipes). Letters A–D, 2–4 options. `verb` accepts `no change`, `no-change`, `nochange` in any case. Cite numbers are 1-based indexes into `evidence`; an empty field means none.
- **Usable** = the fence closes, `id` matches the row when one is expected (case-insensitive), at least two well-formed options, and a non-empty `claim` or `assessment`. Anything else is `null`.
- `needs`, `nature`, `checkable` that are not one of the listed words are `null`, never guessed.
- An evidence line is `<cite>` or `<cite> "<quote>"`. The cite is the first whitespace-delimited token.

```text
```cim-vote
id: UV-0036
vote: concur | concern | refuted
prefers: A | B | C | D | none
reason: <one sentence>
```
```

## 5. Rules the code must keep

**Security.** Agent replies and ledger rows are untrusted text.
- A cite's `path` and `sha` reach `git` as argv. `sha` must match `^[0-9a-f]{7,40}$`; `path` must not be absolute, start with `-`, contain a `..` segment, a NUL or a backslash. Violations are `null` from `parseCite`, never a thrown error. The ledger ref from settings must not start with `-` and contains no whitespace.
- Git is only ever run through the injected `Runner`, argv arrays, never a shell string; every git call has a timeout (20 s) and an output cap where the data is a file (2 MB; larger is ungrounded, "too large to check").
- Text goes to the panel through `textContent` only (the panel test enforces it). Text that goes to **another agent** (the vote ask, the decision relay) is fixed template plus quoted data: a quoted value is cut to 600 characters, newlines collapsed, and never placed where it could read as the template's own instruction.
- Nothing is sent to an agent by a GET, by the standup build, or by presenting. Asking skeptics and relaying a decision are explicit POSTs from the human.

**Async.** Every git call, socket and file read is asynchronous (README §8). No poll loop outlives its round: `abort()` and `hub.stop()` cancel them, and a test proves the fake clock has no pending sleeper afterwards.

**Failure never reads as empty.** A source that cannot be read is a `note` on its chip (`git unavailable`, `no repository`), not a silent zero. One failing source does not fail the standup.

**Dates** are local (`new Date(y, m, d)`), so a day boundary is the user's midnight and DST does not shift it.

## 6. Behaviour

### 6.1 Standup

`standupWindow(now, covering?)`: `run` is the local date of `now`. Without `covering`, `covering` is the previous weekday (Tue→Mon, Mon→Fri, Sat→Fri, Sun→Fri), the window is `[covering 00:00, run 00:00)` so a Monday standup spans the weekend, and `through` is the last day inside the window. With `covering` (`YYYY-MM-DD`, validated as a real date) the window is that one day and `through === covering`.

Sources, each independent:
- **Local git** (`git`): per repo, one `for-each-ref --sort=-committerdate --format=%(refname)%09%(committerdate:unix)%09%(objectname:short)%09%(subject) refs/heads refs/remotes`. A ref counts when its commit date is inside the window. `origin/x` and `x` are one branch. `HEAD`, the default branches (`main`, `master`, `develop`, `trunk`) and the ledger ref are not items. Chip count: branches in the window, over all repos.
- **Sessions** (`sessions`): every visible agent that is live, or whose last transcript turn is inside the window (`SessionActivity.lastAt`). Chip count: those sessions.
- **Ledger** (`ledger`): the open rows of every repo (`readLedger`), minus rows the decision store hides. Chip count: the rows.

Join (Triage lane): branches become items keyed by `<repo>:<ticket key or branch>`; branches sharing a ticket key in one repo merge into one item (title: the most recent branch; `detail` says `+N more`). A ticket key is `[A-Z][A-Z0-9]+-\d+` (case-insensitive) found in the branch name or the commit subject, plus, for each configured `ticketPrefixes` entry, the unhyphenated form (`qp27153` → `QP-27153`). A session joins a triage item when its checkout's current branch (`git rev-parse --abbrev-ref HEAD`, once per distinct cwd) is one of the item's branches, or its name contains one of the item's ticket keys.

Lanes: `lanes.triage` = triage items; `lanes.agents` = sessions; `lanes.lightning` = open, un-hidden rows. Order inside a lane: needs-attention tints first (red, amber), then newest `at`; lightning rows opened inside the window first, then oldest first.

Tint: triage `blue`, or the worst tint among its joined sessions' last statuses; agents `STATUS_TINT[lastStatus]` else `grey` when stopped, `blue` when busy, `green` when idle; lightning `green`.

`renderStandupText` is the terminal rendering: the header line, the chips, the three lane counts, then the board, one line per item.

### 6.2 Lightning Round

`LightningRound` owns a queue of open rows. Constructor `(rows: LedgerRow[], deps: LightningDeps, opts?: { panelSize?: number; prefetch?: number })`; defaults `panelSize` 4, `prefetch` 1.

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

Public surface: `id`, `view(): LightningView`, `start()`, `select(key)`, `approve(key, letter)`, `reject(key)`, `defer(key)`, `askSkeptics(key)`, `abort()`, `settle()` (resolves when no background task is running; for tests). Unknown keys throw `new Error('No lightning item <key>.')` (the daemon maps `No …` to 404).

**Present** (per item, started by `start`, `select`, and prefetch of the next `prefetch` queued items):
1. Candidates: messageable agents whose `repoOf` equals the row's `repoPath`, idle before busy, then roster order; skip a session that already rejected this item; at most `maxPresenters`.
2. For each candidate in turn: remember `transcriptSize`, send `lightningPresentAsk(row)`, then poll `readSince` every `pollMs` for new assistant texts. A text with a usable block (`parsePresentation(text, row.id)`) wins. A text that contains the `cim-lightning` fence but is not usable logs `<name> <shortID> replied without a usable block.` and moves to the next candidate at once. At `presentTimeoutMs`: if the agent wrote any assistant text since the ask, the same "replied without a usable block" line; else `<name> <shortID> did not reply within <n>s.`
3. No candidate, or all failed: phase `fallback`, a presentation built from the row (`source: 'ledger'`, `presentedBy: row.raisedBy ?? ''`, options Confirm, Deny, No change, all ungrounded, no tags), and the log line `No presentation for <key>: <reason> Showing the ledger row.` with reason `The present call timed out.` (a candidate timed out), `No agent in <repo> can be messaged.` (no candidate), or `Nobody replied with a usable block.`.
4. A winning block is **grounded** before it is shown: each evidence line goes through `parseCite` then `groundCite(run, presenter.cwd, cite)`; an unparseable line is `{ cite: null, grounding: { status: 'ungrounded', reason: 'not a citation' } }`. An option is `grounded` when at least one cite it references is grounded, otherwise `ungrounded`.
5. Two asks about different rows can be in one agent's transcript at once; `expectId` is what keeps them apart.

**Approve** `(key, letter)`: the letter must be one of the item's options and the item must be `presented` or `fallback`. `no_change` records the decision and sends nothing. The other verbs send `lightningDecision(row, option, presentation)` to the presenting agent (for a fallback, to the first messageable agent in the row's repo; if there is none, `delivered: false` and the log says `Nobody in <repo> can be messaged: copy the decision by hand.` and the decision is **not** recorded, so the row stays in the queue). On success: phase `decided`, `DecisionStore.record(key, …, now + 7 days)`, the queue advances to the next undecided item, prefetch continues. A second approve of a decided item is a no-op returning `delivered: false`; concurrent approves of one item send once.

**Reject** `(key)`: drop the presentation, remember the presenter in `rejectedBy`, put the item at the back of the queue as `queued`. When every candidate has rejected it, it presents from the ledger row. Nothing is sent to an agent.

**Defer** `(key)`: `DecisionStore.record(key, { state: 'deferred' }, nextLocalMidnight)`; phase `deferred`; advance.

**Ask skeptics** `(key)`: the item must be `presented` or `fallback`. Candidates: messageable agents other than the presenter, same repo first, then the rest in roster order, at most `panelSize`. Each gets `lightningVoteAsk(row, presentation)` (the presentation is quoted data). Votes are read like presentations, `parseVote(text, row.id)`, polled until everyone answered or `voteTimeoutMs`; a late vote still counts. `votes.asked` stays false until this is called. `tally.silent` = asked − answered.

**Abort**: stops every poller, sets `active: false`, leaves decisions already recorded.

### 6.3 Persistence

`DecisionStore` keeps `{ [key]: { state, option?, verb?, at, until } }` under `KEYS.lightning` (`cimLightningDecisions`). `hidden(key)` is `until > now`. Entries more than 30 days past `until` are dropped on write. Decided and no-change rows come back after 7 days if the ledger still lists them open; deferred rows come back at the next local midnight.

### 6.4 Hub

New on `Hub`: `settings.ledgerRef` (default `'wiki'`), `settings.ticketPrefixes` (default `[]`); `standup: Standup | null`; `lightning: LightningRound | null`; `buildStandup(covering?)` (selects `{ kind: 'standup' }`); `openRows()`; `lightningStart({ keys?, repo?, panelSize? })`; `lightningView()`; thin pass-throughs for approve, reject, defer, skeptics, abort. `Selection` gains `{ kind: 'standup' }`. `HubEvent` gains `{ type: 'standup' }` and `{ type: 'lightning' }`. `snapshot()` gains `standup: { at, covering, through, run, lanes } | null` and `lightning: { active, remaining, current } | null`. `tbuvLookup` reads through `readLedger` (one parser for both features) and keeps its current behaviour. `stop()` aborts the round.

### 6.5 HTTP and CLI

```
GET  /standup              the last Standup, or 404 "No standup yet; POST /standup first."
POST /standup              { covering?: 'YYYY-MM-DD' } → Standup; selects the standup
GET  /lightning            LightningView ({ active: false, … } when no round)
POST /lightning/start      { keys?: string[], repo?: string, panelSize?: number } → LightningView
POST /lightning/select     { key } → LightningView
POST /lightning/approve    { key, option: 'A'..'D' } → { delivered, view }
POST /lightning/reject     { key } → LightningView
POST /lightning/defer      { key } → LightningView
POST /lightning/skeptics   { key } → LightningView   (returns once the asks are sent)
POST /lightning/abort      → { ok: true }
```
`agentim standup [--date YYYY-MM-DD] [--json]` prints `renderStandupText` (or the JSON). `agentim lightning start [--repo NAME] [--panel N]`, `lightning show`, `lightning approve <key> <A-D>`, `lightning reject <key>`, `lightning defer <key>`, `lightning skeptics <key>`, `lightning abort` print the view as JSON. `serve` gains `--ledger-ref REF` and `--ticket-prefix PFX` (repeatable). `serve --demo` has ledger rows, presenter replies, a grounded and an ungrounded cite, and a silent panel, so the whole flow can be clicked through.

### 6.6 Panel

Header: `Morning Standup` button. Selecting it calls `POST /standup`; the left column becomes the standup navigator (title and date line, the chips, the three lanes with counts and a filled dot on the open one, the Board for that lane) and the right pane shows the detail for the picked board item. **Back to agents** clears the selection (`POST /selection/clear`); **Abort** appears while a round is active.

- A **Lightning** board row opens its card; **Start Lightning** at the top of the lane starts a round over the lane, and from then on the card follows the round's `current`.
- The card is §1 point for point: tag pills (`NeedsHuman`, `decision`, `checkable now`), title, summary, `Presented by …`, claim, assessment, evidence lines with grounded/UNGROUNDED pills, options with letter, verb, title, pill and rationale, a collapsible votes row (with **Ask skeptics** when not asked), the hint line, and **Approve / Reject / Defer** (Approve disabled until a letter is picked). Keys `A`–`D` pick, `Enter` approves, unless a text field has focus.
- The round's `log` is shown under the card, one line each.
- Agents and Triage items: the detail shows the fields and, for sessions, **Open thread** (selects the agent); for triage items the joined sessions as links.
- Same constraints as the rest of the panel: nodes through `h()`, text through `textContent`, no inline style or script, tokens from `:root`, light and dark.

## 7. Tests

Unit tests of the pure logic with fake runners, clocks and transcripts, like the rest of the suite; no browser in CI. Each module has its own `test/*.test.ts`. The hub and the daemon routes are covered in `test/hub.test.ts`-style integration tests. The live-browser check is done by hand against `serve --demo`.
