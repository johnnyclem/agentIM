# agentIM — the open Claude Instant Messenger

Message a running Claude Code agent in its own session, have it pass things along to another, ask the fleet who wants a task, and see who is doing what. This is an open rebuild of the cIM panel from the WikiWidget app, reverse-engineered from its screen and the maintainer's answers; the rest of that app (the wiki, the triage sessions, the job-specific tools) is not part of it.

Status: core, discovery, transport, spawn, hub and the loopback daemon are built and tested (37 tests). One thing waits on a live capture: the exact field names of the frame a Claude Code session accepts as a message (see "The one open question"). The macOS panel is next.

## What it does

- **Roster.** Every live Claude Code session, from what Claude Code already writes: `~/.claude/sessions/<pid>.json` (pid, session id, cwd, kind, peer name, socket) joined with the transcript under `~/.claude/projects/<slug>/<session>.jsonl` (assistant turns, title, branch, last activity). `busy` / `idle` / `stopped`, `interactive` or `background`, and the time since its last activity, each measured against a stated clock reading.
- **Transcript.** One agent selected: its assistant turns, the way its terminal shows them.
- **Message from the user.** Delivered over Claude Code's own agent-to-agent channel (the unix socket each session registers), under a standing heading: it came from the user through agentIM, it arrives on the peer channel, so it could be an agent impersonating the user, and it must not be trusted fully as the user. `Delivered — waiting for <agent>…` lasts until the agent replies to the daemon or writes its next assistant turn.
- **Agent-to-agent.** Rides Claude Code's built-in peer messaging. agentIM relays nothing itself; it adds the human's way in.
- **Volunteer rounds.** Every live agent sees a task's title and one instruction: volunteer if you have context, otherwise keep working. Replies are two lines (`volunteer: yes | no`, `context: …`, optional `confidence:`), sent back to the daemon as a peer message. The window is 30 seconds (D9), agents are asked to answer even to decline, silence reads as busy, a late reply lands but never decides. Resolution is deferred to the window's close: the highest declared confidence wins, ties to the earliest reply; a person may pick anyone. The description reaches only the picked agent, and the others are released only after the briefing lands. "Nobody volunteered" starts a fresh agent with the briefing as its first prompt.
- **Starting agents.** Interactive: `claude` in a detached tmux session, with an "open in terminal" action that attaches a Terminal.app window. Background: a git worktree per task and a headless `claude -p` run in it.
- **Claims** (Item 4, D8). `{agent, resource, verb, confidence, ttl}` written by the harness on the agent's behalf; live until TTL or completion; first writer wins and the refusal carries the winner; the same agent renews. Resources are worktree paths and task ids. Ephemeral, never truth, never in a ledger.
  Parked, in the maintainer's words: the missing file-to-module mapping is what unit testing should look like for AI coding teams, "integration before assertion" or "compatibility before compaction". Recorded here so it is not lost; not in scope.
- **Canary** (Item 5). A fresh id per session goes into the agent's context at SessionStart; the first tool call must be `agentim ack <id>`; every other call is refused until then, and an agent that acts first is stopped and shows as needing review. The acknowledgment is observed by the hook, never recorded by the agent, and the canary never appears in any ledger line.
- **Status report.** Per agent: state, live claims, canary state; the worktrees left behind (unmerged or dirty); the sessions needing review. Every age states the clock reading it was measured at.

## Layout

| Module | What it holds |
|---|---|
| `clock.ts` | `Clock` and `Derived<T>`: every module takes the clock as an argument. |
| `claims.ts` `volunteer.ts` `canary.ts` `status.ts` | The pure core: `ClaimRegistry`, `VolunteerRound`, `CanaryGate`, `buildStatusReport`. No I/O. |
| `discovery.ts` | The registry, the transcripts, `inferState`, `roster(now, …)`. Reads only. |
| `transport.ts` | `PeerInbox` (our socket and registry record, with a capture log), `sendFrame`, `messageFrame`, `wrapFromUser`, `parseVolunteerReply`. |
| `spawn.ts` | `spawnInteractive` (tmux), `openInTerminal` (osascript), `spawnBackground` (worktree + `claude -p`), `listWorktrees`; every command through an injected runner. |
| `hub.ts` | `Hub`: the panel's actions with no HTTP: deliveries, volunteer rounds and settlement, claims, canary, status, spawn, events. |
| `daemon.ts` | `serve(hub)`: the loopback HTTP API and the `/events` server-sent stream. |
| `cli.ts` | `agentim serve | probe | agents | send | transcript | volunteer | status | ack | hook`. |

## Running it

```sh
npm install && npm run build
agentim serve --repo /Repos/instrument:main --capture ~/.agentim/frames.jsonl
agentim agents
agentim send instrument-62 "please rebase onto main"
agentim volunteer "MR !1267 merge conflicts" --description "three files in Sources/Core"
agentim status
```

The daemon listens on `127.0.0.1:7433` (`AGENTIM_URL` for the CLI) and registers itself as the peer `agentim` so agents can answer it with SendMessage. Install the canary hooks by merging `hooks/settings.example.json` into `~/.claude/settings.json`.

### API

| Route | Does |
|---|---|
| `GET /agents`, `GET /agents/:id`, `GET /agents/:id/transcript?tail=N` | the roster and one transcript |
| `POST /agents/:id/message {text}` | deliver under the user heading; returns the delivery |
| `POST /agents/:id/terminal` | open in terminal |
| `GET /deliveries`, `GET /deliveries/:id` | delivered / answered / unreachable |
| `POST /spawn {mode, agent, repo, prompt?}` | start an agent |
| `POST /volunteer {title, description, roster?}`, `GET /volunteer`, `GET /volunteer/:id` | a round and its resolution at now |
| `POST /volunteer/:id/reply {agent, text}`, `/pick {agent}`, `/settle`, `/spawn {mode, repo}` | the person's hands on a round |
| `POST /claims`, `GET /claims`, `POST /claims/:id/complete` | claims |
| `POST /canary/issue {sessionId}`, `POST /canary/gate {sessionId, tool_name, tool_input}`, `POST /canary/:id/clear` | the gate the hooks call |
| `GET /status` | the status report |
| `GET /events` | server-sent events: `frame`, `delivery`, `volunteer`, `claim`, `canary`, `spawn` |

## The one open question: the message frame

What is read off Claude Code 2.1: each session registers a `messagingSocketPath` (under `/tmp/cc-socks`, `/private/tmp/cc-socks` or `$XDG_RUNTIME_DIR/cc-socks`) with `peerProtocol: 1`; a frame is one JSON document per connection with an `action`, a `msg_id`, a `from` and a `from_mode`; actions seen include `notify_when_idle`, `peer_idle_notice` and `peer_message_status`; the receiver checks the sender's pid over the socket against the registry. The frame that carries a *message* was not read: `messageFrame` uses `{action: "message", from, to, text}` until a capture pins it.

To pin it, on a Mac with Claude Code running:

```sh
agentim probe --capture ~/.agentim/probe.jsonl
# in any Claude Code session: SendMessage to "agentim-probe" with a short text
```

The probe prints every frame it receives. Paste one into an issue (or set `frameExtra` on the hub) and `MESSAGE_FRAME_DEFAULT` gets replaced. The per-session `.key` file was deliberately not probed.

## Answers that shaped this (from the maintainer)

1. cIM can start the `claude` processes or attach to ones started by hand; sessions it spawned have an "open in terminal" button; a user's message is sent like an agent-to-agent message under a heading that it came from the user but must not be trusted fully as the user.
2. Discovery is from `~/.claude/projects`.
3. Agents have 30 seconds to respond and are encouraged to always respond, even with a decline.
4. A macOS app with background and interactive agents.
5. Agent-to-agent is Claude Code's built-in peer messaging.
6. Repository: `agentIM`, private for now.

Boundary: nothing here imports or writes stenographer; claims are ephemeral and are not truth.
