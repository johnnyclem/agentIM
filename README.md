# agentIM — the open Claude Instant Messenger

A messaging hub for the Claude Code agents running on one machine, rebuilt in the open from the cIM pane of the WikiWidget app. This repository is the engine: the roster, the transcripts, the inbox protocol, 1:1 and group threads, status checks with review mode, the volunteer flow, session lifecycle, and a loopback HTTP API a panel talks to. The panel itself (macOS SwiftUI in the original) is the next layer.

Source of truth: the cIM reconstruction spec (branch `dev`, commit `8bf6d00`, 2026-10-16). Section numbers below refer to it.

## What it does

1. **Lists** every Claude Code session on the machine, interactive or background, running or stopped (§2.1, §2.2).
2. **Chats** with one session: history is the tail of its transcript on disk; a message typed here is injected into the session's live prompt box through its messaging socket, so the agent sees it as a message from another Claude session (§2.3, §2.4, §4.2).
3. **Fans out**: a shared group thread, a Status Check that collects one `cim-status` block per agent and opens review mode, and Find Volunteer, which asks everyone who has context and briefs one (§4.3, §5.6, §5.7, §7).
4. **Manages lifecycle**: rename, Done (wrap-up then archive), Pause Agents, Resume Agents (also after a reboot), Open in Terminal, resume a stopped session by messaging it, and Send as me (§2.5, §4.4–4.6, §5.8).

There is no request/response and no group primitive on the wire. A send is a fire-and-forget write into one session's inbox; replies are found by polling that session's transcript; a group is N independent sends plus a merged view of N transcripts. Agents never see each other's replies unless the human relays them. Auto-forwarding between agents is deliberately absent.

## The interfaces it depends on (undocumented; each isolated in one module)

| Interface | Module | What is read or written |
|---|---|---|
| `claude agents --json --all` | `roster.ts` | the roster; a non-zero exit is an error, never an empty list; duplicates deduped with the live row winning |
| `~/.claude/sessions/<pid>.json` | `roster.ts` | only `messagingSocketPath`; a session without one is listed but not messageable |
| the inbox socket | `inbox.ts` | connect, an auth line `{type:"auth", token}` with the `peerToken` from `~/.claude/sessions/<pid>.<sha256-hex of the socket path>.key`, then `{msgV:1, msg_id, type:"user", message:{role:"user", content}, priority:"next"}`, half-close; 5 s timeout; no acknowledgment |
| `~/.claude/projects/<slug>/<sessionId>.jsonl` | `transcript.ts` | the CLI's slug (every non-alphanumeric UTF-16 unit to `-`, a base-36 rolling hash past 200), a backward tail read in 256 KB chunks up to 8 MB, an incremental read past a byte offset, `isMeta` and `isSidechain` dropped, turns clipped at 12,000 characters |
| `claude --bg …`, `--resume`, `stop`, `attach` | `spawner.ts` | spawn with the job id parsed from the colored `backgrounded · <id> · …` line, resume (`--name` only for interactive), stop, send-as-me (re-list, stop, wait for the pid, resume with the text), a login-shell script opened by the OS for the terminal |

## Layout

| Module | Spec | What it holds |
|---|---|---|
| `agent.ts` | §3.1, §3.2 | `Agent`, `Turn`, the derived facts (`isMessageable`, `isStopped`, `canTakeUserTurn`, `shortID`) |
| `transcript.ts` | §2.4 | `transcriptSlug`, `parseTurn`, `readTail`, `readSince` |
| `roster.ts` | §2.1, §2.2, §4.1 | `parseRoster`, `listAgents`, `RosterPoller` |
| `inbox.ts` | §2.3 | `sendInboxMessage`, the error vocabulary |
| `prompts.ts` | §6 | `compose` and every message cIM sends |
| `status-report.ts` | §7 | the `cim-status` parser, chore tri-state, rollup, the worktree confirmation decision |
| `conversation.ts` | §4.2 | `Conversation`, `ConversationStore` |
| `group.ts`, `review.ts` | §4.3, §5.6 | `GroupConversation`, `GroupStore`, review entries and ranking |
| `volunteer.ts` | §5.7 | `VolunteerRequest`, the `cim-volunteer` parser |
| `ledger.ts`, `archive.ts`, `store.ts` | §3.3, §4.4, §4.5 | names, the resume set, in-flight, the archive, the JSON file store |
| `spawner.ts` | §2.5, §4.6 | the CLI argv builders, `Spawner`, `gitWorktreeChecks` |
| `hub.ts` | §5.8, §7.4, §9 | the pane's actions: selection, pause, resume, Done, rename, chores, settings |
| `daemon.ts`, `cli.ts` | | the loopback HTTP API with server-sent events, the guard in front of it, the command line |
| `panel/` | §5 | the browser panel: `index.html`, `panel.css`, `panel.js`, served by the daemon at `/` |
| `demo.ts` | | `agentim serve --demo`: fake agents, fake transcripts and canned replies, so the panel can be clicked through with no Claude Code running |
| `claims.ts`, `canary.ts`, `fleet.ts` | markspace review Items 4 and 5 | intent claims with TTL, the canary gate behind Claude Code hooks, the fleet report |

## Running it

```sh
npm install && npm run build
agentim serve --repo ~/Repos/instrument            # loopback on 127.0.0.1:7433; the panel is at http://127.0.0.1:7433/
agentim serve --demo                               # the same, with fake agents and canned replies
agentim agents
agentim send instrument-62 "please rebase onto main"
agentim status-check                               # asks everyone, opens the group in review mode
agentim volunteer "review MR !1364" --description "three files in Sources/Core"
agentim pause && agentim resume
```

`AGENTIM_URL` points the CLI at another port. Settings (§9) are flags on `serve`: `--claude PATH`, `--repo PATH`, `--permission-mode bypassPermissions|acceptEdits|dontAsk`, `--claude-dir DIR`, `--state FILE`. Persistent state lives in `~/.claude/agentim/state.json`. The canary hooks are in `hooks/settings.example.json`.

## Who can call the daemon

It listens on `127.0.0.1` only and refuses anything that did not come from your own tools:

- the `Host` header must be a loopback name, which blocks DNS rebinding;
- an `Origin` header, if present, must be this daemon's own (`http://` plus the same host and port), so a web page on any other site, another local port, a sandboxed frame or a browser extension is refused with 403;
- every request that changes anything must send `Content-Type: application/json`, otherwise 415. A browser cannot send that cross-origin without a preflight, and the daemon sends no CORS headers.

The CLI and the Claude Code hooks send no `Origin` and declare JSON, so they pass. With plain `curl`, add `-H 'Content-Type: application/json'`.

There is no authentication beyond that. Any process on the machine can call the port, and `POST /spawn` starts `claude` with a prompt of the caller's choosing, so on a shared machine treat the port like a shell, or do not run the daemon.

## The API in one screen

`GET /state` is the whole pane. Then, by area: `/agents/:id/{select,thread,draft,message,send-as-me,instruction,model,terminal,done,rename}`, the chip chores `/agents/:id/chore/{wiki,worktrees,tbuv}` and `/agents/:id/tbuv-review`, `POST /chip` to parse a turn; `/message-all`, `/status-check`, `/groups`, `/groups/:key/{select,draft,message,instruction,status-check,review,tbuv}` and `/groups/:key/review/:sid/{draft,reply,mark-reviewed}`; `/volunteer`, `/volunteer/:id/{select,assign,spawn,listen}`, `/spawn-defaults`, `/spawn`; `/pause`, `/resume`, `/resume/dismiss`, `/archive`, `/archive/:id/restore`; `/claims`, `/canary/*`, `/fleet`; `GET /events` streams `roster`, `selection`, `conversation`, `group`, `volunteer`, `toast`, `claim`, `canary`.

## Rules carried over (§8)

Every socket, subprocess, git and file read is asynchronous and never blocks the event loop. Threads keep at most 60 turns (120 for groups) and clip each at 12,000 characters. Idle threads unload when the pane is left or more than three are loaded, never while awaiting a reply, loading, or holding a pending send. A roster failure never reads as an empty roster, and threads are pruned only on clean reads. Group fan-out is concurrent. Bounded string scans. The engine is verified by unit tests of the pure logic (`npm test`, 79 tests), never by driving a screen.

## What is not here yet

- **The macOS pane.** The original is SwiftUI, and there is no Swift toolchain where this was built, so `panel/` is a browser client over the same API: a working reference for the port, and usable on its own. It covers header, cards, 1:1 chat with the model picker, Open in Terminal and Send as me, group threads, status chips and their three chores, review mode, the volunteer flow, pause, resume, Done, rename and the archive (§5.1 to §5.8, §7.4). It is checked in a real browser against the demo hub (screenshots and assertions), and `test/panel.test.ts` covers what it serves and that it never writes agent text through an HTML parser.
- **Left out of the panel:** the large-paste collapse (§5.4) and the column-width probe and layout guards (§8.5, §8.6), which are SwiftUI-specific; an assignee's live chat embedded in the volunteer view (it is an "Open thread" button); un-marking a reviewed entry (the API only marks).
- The TB/UV sign-off reads the wiki branch ledgers through `git show wiki:tombstones.jsonl`; adjust `tbuvLookup` if yours live elsewhere.
