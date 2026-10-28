# agentIM — the open Claude Instant Messenger

A messaging hub for the Claude Code agents running on one machine, rebuilt in the open from the cIM pane of the WikiWidget app. This repository is the engine: the roster, the transcripts, the inbox protocol, 1:1 and group threads, status checks with review mode, the volunteer flow, session lifecycle, the Morning Standup and the Lightning Round, and a loopback HTTP API a panel talks to. The panel itself (macOS SwiftUI in the original) is the next layer.

Source of truth: the cIM reconstruction spec (branch `dev`, commit `8bf6d00`, 2026-10-16). Section numbers below refer to it. The standup and the Lightning Round are not in that spec; they were reconstructed from a screenshot and are described in [docs/standup-lightning.md](docs/standup-lightning.md).

## What it does

1. **Lists** every Claude Code session on the machine, interactive or background, running or stopped (§2.1, §2.2).
2. **Chats** with one session: history is the tail of its transcript on disk; a message typed here is injected into the session's live prompt box through its messaging socket, so the agent sees it as a message from another Claude session (§2.3, §2.4, §4.2).
3. **Fans out**: a shared group thread, a Status Check that collects one `cim-status` block per agent and opens review mode, and Find Volunteer, which asks everyone who has context and briefs one (§4.3, §5.6, §5.7, §7).
4. **Manages lifecycle**: rename, Done (wrap-up then archive), Pause Agents, Resume Agents (also after a reboot), Open in Terminal, resume a stopped session by messaging it, and Send as me (§2.5, §4.4–4.6, §5.8).
5. **Stands up**: the Morning Standup builds a board of what moved since the last working day from local git, the TB/UV ledger and the live sessions, as three lanes (Triage, Agents, Lightning) with a chip per source. Nothing is sent to an agent.
6. **Settles ledger rows**: the Lightning Round takes the open TB/UV rows one card at a time. An agent in the row's repo presents it as options, every cite is checked against the repository, and a human approves, rejects or defers. An approval goes back to an agent as an instruction; cIM never writes the ledger.

There is no request/response and no group primitive on the wire. A send is a fire-and-forget write into one session's inbox; replies are found by polling that session's transcript; a group is N independent sends plus a merged view of N transcripts. Agents never see each other's replies unless the human relays them, and cIM relays only on a click: Ask skeptics sends other agents a quoted copy of one agent's presentation, and approving a decision sends the decision to the agent that presented it. Auto-forwarding between agents is deliberately absent.

## The interfaces it depends on (undocumented; each isolated in one module, `git rev-parse` in two)

| Interface | Module | What is read or written |
|---|---|---|
| `claude agents --json --all` | `roster.ts` | the roster; a non-zero exit is an error, never an empty list; duplicates deduped with the live row winning |
| `~/.claude/sessions/<pid>.json` | `roster.ts` | only `messagingSocketPath`; a session without one is listed but not messageable |
| the inbox socket | `inbox.ts` | connect, an auth line `{type:"auth", token}` with the `peerToken` from `~/.claude/sessions/<pid>.<sha256-hex of the socket path>.key`, then `{msgV:1, msg_id, type:"user", message:{role:"user", content}, priority:"next"}`, half-close; 5 s timeout; no acknowledgment |
| `~/.claude/projects/<slug>/<sessionId>.jsonl` | `transcript.ts` | the CLI's slug (every non-alphanumeric UTF-16 unit to `-`, a base-36 rolling hash past 200), a backward tail read in 256 KB chunks up to 8 MB, an incremental read past a byte offset, `isMeta` and `isSidechain` dropped, turns clipped at 12,000 characters |
| `claude --bg …`, `--resume`, `stop`, `attach` | `spawner.ts` | spawn with the job id parsed from the colored `backgrounded · <id> · …` line, resume (`--name` only for interactive), stop, send-as-me (re-list, stop, wait for the pid, resume with the text), a login-shell script opened by the OS for the terminal |
| `git show <ledger ref>:tombstones.jsonl` and `…:unverified.jsonl` | `tbuv-ledger.ts` | the TB/UV rows, one JSON object per line; the ref is `wiki` unless `--ledger-ref` says otherwise; git is killed at 2 MiB and the file reads as "larger than 2 MiB", never as a silent prefix; also the sign-off lookup |
| `git for-each-ref refs/heads refs/remotes` | `standup.ts` | tab-separated ref, unix commit date, short sha and subject, newest first; the branches with a commit inside the standup window; capped at 4 MiB |
| `git rev-parse --git-common-dir`, `--abbrev-ref HEAD` | `tbuv-ledger.ts`, `standup.ts` | which repo a working directory belongs to (worktrees of one repo collapse to one, a symlinked spelling too) and which branch a session is on |
| `git rev-parse --verify`, `--show-prefix --show-toplevel`, `git cat-file -t` and `-s`, `git show <sha>:<path>` | `grounding.ts` | checking an agent's cite: the commit exists, the file is in it (looked up from the checkout the agent stood in), it is under 2 MiB, the lines exist and the quote is in them |

## Layout

| Module | Spec | What it holds |
|---|---|---|
| `agent.ts` | §3.1, §3.2 | `Agent`, `Turn`, the derived facts (`isMessageable`, `isStopped`, `canTakeUserTurn`, `shortID`) |
| `transcript.ts` | §2.4 | `transcriptSlug`, `parseTurn`, `readTail`, `readSince` |
| `roster.ts` | §2.1, §2.2, §4.1 | `parseRoster`, `listAgents`, `RosterPoller` |
| `inbox.ts` | §2.3 | `sendInboxMessage`, the error vocabulary |
| `prompts.ts` | §6 | `compose` and every message cIM sends, the Lightning asks and the decision relay included; `quoted` makes untrusted text one safe line |
| `status-report.ts` | §7 | the `cim-status` parser, chore tri-state, rollup, the worktree confirmation decision |
| `conversation.ts` | §4.2 | `Conversation`, `ConversationStore` |
| `group.ts`, `review.ts` | §4.3, §5.6 | `GroupConversation`, `GroupStore`, review entries and ranking |
| `volunteer.ts` | §5.7 | `VolunteerRequest`, the `cim-volunteer` parser |
| `ledger.ts`, `archive.ts`, `store.ts` | §3.3, §4.4, §4.5 | names, the resume set, in-flight, the archive, the JSON file store |
| `spawner.ts` | §2.5, §4.6 | the CLI argv builders, `Spawner`, `gitWorktreeChecks` |
| `hub.ts` | §5.8, §7.4, §9 | the pane's actions: selection, pause, resume, Done, rename, chores, settings; building the standup and running the Lightning Round |
| `daemon.ts`, `cli.ts`, `args.ts` | | the loopback HTTP API with server-sent events, the guard in front of it, the command line and its flag reader |
| `panel/` | §5 | the browser panel: `index.html`, `panel.css`, `panel.js`, served by the daemon at `/` |
| `demo.ts` | | `agentim serve --demo`: fake agents, fake transcripts, canned replies and one invented repo with a ledger, so the panel, the standup and the Lightning Round can be clicked through with no Claude Code running |
| `claims.ts`, `canary.ts`, `fleet.ts` | markspace review Items 4 and 5 | intent claims with TTL, the canary gate behind Claude Code hooks, the fleet report |
| `runner.ts`, `limit.ts` | | the injected subprocess runner (a timeout or an output cap kills the child and the result says so), `limitRunner`: at most N processes at once |
| `tbuv-ledger.ts` | standup doc | the TB/UV ledger rows and their one parser (`parseLedger`, `readLedger`), repo discovery (`discoverRepos`, `uniqueRepoNames`) |
| `grounding.ts` | standup doc | `parseCite`, `groundCite`: whether `path:lines@sha "quote"` holds in the repository, read from where the agent stood |
| `lightning-format.ts` | standup doc | the `cim-lightning` and `cim-vote` blocks: parsers, the vote tally |
| `standup.ts` | standup doc | `standupWindow`, `buildStandup` (local git, ledger and sessions joined into three lanes, a note on a chip when a source fails), `renderStandupText` |
| `lightning.ts` | standup doc | `LightningRound` (present, approve, reject, defer, ask skeptics, abort), `DecisionStore` |

`standup doc` is [docs/standup-lightning.md](docs/standup-lightning.md).

## Running it

```sh
npm ci && npm run build   # the lockfile matters: a bare `npm install` without it crashes some npm 10.9.x builds in vitest's peer resolution
agentim serve --repo ~/Repos/instrument            # loopback on 127.0.0.1:7433; the panel is at http://127.0.0.1:7433/
agentim serve --demo                               # the same, with fake agents and canned replies
agentim agents
agentim send instrument-62 "please rebase onto main"
agentim status-check                               # asks everyone, opens the group in review mode
agentim volunteer "review MR !1364" --description "three files in Sources/Core"
agentim pause && agentim resume
agentim standup                                    # what moved since the last working day; --date 2026-10-20 for another day, --json for the data
agentim lightning start --repo instrument --panel 4   # settle the open ledger rows; returns at once, the round runs in the daemon
agentim lightning show                             # the round as JSON: every card, its `rev`, the votes, the log
agentim lightning approve uv:instrument:UV-0036 A --rev 1   # also: reject <key>, defer <key>, skeptics <key>, abort
```

`AGENTIM_URL` points the CLI at another port. Settings (§9) are flags on `serve`: `--claude PATH`, `--repo PATH`, `--permission-mode bypassPermissions|acceptEdits|dontAsk`, `--claude-dir DIR`, `--state FILE`, `--ledger-ref REF` (the branch the TB/UV ledgers live on, default `wiki`), `--ticket-prefix PFX` (repeatable: with `--ticket-prefix SHOP`, `shop142` in a branch or session name is the ticket `SHOP-142`). A flag takes `--flag value` or `--flag=value`. The standup looks for repositories in the `--repo` directory and in every agent's working directory; a `lightning start --repo` name is a repository's folder name (`<parent>~<folder>` for two repositories that share one). Persistent state, the Lightning decisions included, lives in `~/.claude/agentim/state.json`. The canary hooks are in `hooks/settings.example.json`.

`agentim serve --demo` has the standup and the round too: one invented repository, `instrument`, with branches and nine ledger rows, seven fake agents, canned presentations (grounded and ungrounded cites, a card that falls back to its ledger row) and canned votes. The Morning Standup button in the panel builds the board; Start Lightning runs the round.

## Who can call the daemon

It listens on `127.0.0.1` only and refuses anything that did not come from your own tools:

- the `Host` header must be a loopback name, which blocks DNS rebinding;
- an `Origin` header, if present, must be this daemon's own (`http://` plus the same host and port), so a web page on any other site, another local port, a sandboxed frame or a browser extension is refused with 403;
- every request that changes anything must send `Content-Type: application/json`, otherwise 415. A browser cannot send that cross-origin without a preflight, and the daemon sends no CORS headers.

The CLI and the Claude Code hooks send no `Origin` and declare JSON, so they pass. With plain `curl`, add `-H 'Content-Type: application/json'`.

There is no authentication beyond that. Any process on the machine can call the port, and `POST /spawn` starts `claude` with a prompt of the caller's choosing, so on a shared machine treat the port like a shell, or do not run the daemon.

## The API in one screen

`GET /state` is the whole pane. Then, by area: `/agents/:id/{select,thread,draft,message,send-as-me,instruction,model,terminal,done,rename}`, the chip chores `/agents/:id/chore/{wiki,worktrees,tbuv}` and `/agents/:id/tbuv-review`, `POST /chip` to parse a turn; `/message-all`, `/status-check`, `/groups`, `/groups/:key/{select,draft,message,instruction,status-check,review,tbuv}` and `/groups/:key/review/:sid/{draft,reply,mark-reviewed}`; `/volunteer`, `/volunteer/:id/{select,assign,spawn,listen}`, `/spawn-defaults`, `/spawn`; `/pause`, `/resume`, `/resume/dismiss`, `/archive`, `/archive/:id/restore`; `/claims`, `/canary/*`, `/fleet`; `GET /standup` (the last one, 404 before the first), `POST /standup` (`{covering?}`, builds and selects it); `GET /lightning` (the round, with every card, its `rev`, the votes and the log), `POST /lightning/{start,select,approve,reject,defer,skeptics,abort}`, where `approve` takes the `rev` of the card the caller saw and answers 409 if the card has changed since; `GET /events` streams `roster`, `selection`, `conversation`, `group`, `volunteer`, `toast`, `claim`, `canary`, `standup`, `lightning`.

## Morning Standup and the Lightning Round

The standup answers "what moved since the last working day" (the previous weekday, so a Monday spans the weekend; `--date` picks one day). It is a board of three lanes: **Triage** (branches with a commit in the window, merged when they share a ticket key, with the sessions working on them), **Agents** (the live sessions and the ones that spoke in the window) and **Lightning** (the open TB/UV ledger rows). One chip per source (`Local git`, `Ledger`, `Sessions`) counts what it read, and turns amber with a note when it could not read all of it, so a failure never looks like a zero. The Lightning Round goes through the Lightning lane one card at a time. An agent that works in the row's repo is asked to present the row as options, cIM checks every cite against that agent's checkout (grounded or UNGROUNDED), and a human approves one option, rejects the card (asks again later, with another agent) or defers the row until tomorrow. Approving sends the chosen option to the presenting agent as an instruction; a "no change" option sends nothing. Settled rows stay out of later rounds for a week, deferred ones until the next midnight. The design, the block formats and the behaviour as built are in [docs/standup-lightning.md](docs/standup-lightning.md).

What it never does:
- **It never writes the ledger.** A decision reaches the ledger only when an agent acts on the instruction it was sent.
- **It sends nothing from a GET, from the standup build, or from a board click outside a round.** Presenting sends one ask to up to two agents of the row's repo, in turn. Votes are opt-in: Ask skeptics is a click and asks up to four other agents; relaying a decision is a click.
- **It never trusts what an agent or a ledger row says.** A cite's path and commit are validated before they reach git, a ledger id must be a plain identifier, and anything that goes on to another agent is a fixed template with the value quoted on one line.

What it reads: local git (`git for-each-ref` in each repository found from `--repo` and the agents' working directories), the ledgers (`git show <ledger ref>:tombstones.jsonl` and `unverified.jsonl`), and the roster and the transcripts (a session's last status and when it last spoke).

Deliberately not built: the GitLab and Jira sources (the two forge chips of the original) and a `StandupSource` interface. The three sources are three functions in `standup.ts`; a fourth would be another function beside them. cIM does not write the ledger, and agents are not wired to each other.

Known limits, decided and not fixed:
- The map from working directory to repository is refreshed when a standup is built, when the queue is read and when a round starts. An agent that joins a repository mid-round is recognised as a presenter or a skeptic at the next refresh.
- The sign-off lookup skips a ledger file over 2 MiB: its rows read as not found there. The standup and the round do report it, on the Ledger chip and in the round's log.
- The ledger is read with `git show <ref>:<file>`, so a tag named like the ledger branch (a `wiki` tag next to a `wiki` branch) is read in its place.
- A cite whose path has a space in it is not recognised, and shows as UNGROUNDED.
- A ticket key next to an underscore (`fix_ABC-123`) is not found.
- The round and the board have no paging: `GET /lightning` carries every card.
- The lane buttons in the panel are announced as radio buttons and do not answer the arrow keys.
- The asks have only been exercised against fake agents (the tests and the demo). Whether a real model answers in the `cim-lightning` and `cim-vote` blocks as asked has not been tried; an agent that does not is handled (the card falls back to the ledger row and the log says why), but the wording of the asks in `prompts.ts` is the first thing to adjust after a live run.

## Rules carried over (§8)

Every socket, subprocess, git and file read is asynchronous and never blocks the event loop. Threads keep at most 60 turns (120 for groups) and clip each at 12,000 characters. Idle threads unload when the pane is left or more than three are loaded, never while awaiting a reply, loading, or holding a pending send. A roster failure never reads as an empty roster, and threads are pruned only on clean reads. Group fan-out is concurrent. Bounded string scans. Git output is capped while git runs (a ledger file at 2 MiB, a ref listing at 4 MiB, a file being grounded at 2 MiB), and a cut-off or timed-out git is never read as an answer. The standup, the queue, the round's grounding and the sign-off lookup run at most 8 git processes at once. A ledger id must be a plain identifier, and a cite's path and commit are validated before they reach git. The engine is verified by unit tests of the pure logic (`npm test`, 836 tests), never by driving a screen.

## What is not here yet

- **The macOS pane.** The original is SwiftUI, and there is no Swift toolchain where this was built, so `panel/` is a browser client over the same API: a working reference for the port, and usable on its own. It covers header, cards, 1:1 chat with the model picker, Open in Terminal and Send as me, group threads, status chips and their three chores, review mode, the volunteer flow, pause, resume, Done, rename and the archive (§5.1 to §5.8, §7.4), and the Morning Standup and the Lightning Round (the standup band, the lanes and board, the card with its evidence, options and votes). It is checked in a real browser against the demo hub (screenshots and assertions), and `test/panel.test.ts` covers what it serves and that it never writes agent text through an HTML parser.
- **Left out of the panel:** the large-paste collapse (§5.4) and the column-width probe and layout guards (§8.5, §8.6), which are SwiftUI-specific; an assignee's live chat embedded in the volunteer view (it is an "Open thread" button); un-marking a reviewed entry (the API only marks).
- The TB/UV sign-off and the Lightning Round read the ledgers through `git show <ledger ref>:tombstones.jsonl` and `…:unverified.jsonl`, with one parser (`tbuv-ledger.ts`). The ref is `wiki` unless `serve --ledger-ref REF` says otherwise; if the ledgers live in other files, change `LEDGER_FILES` there.
