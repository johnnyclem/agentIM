# agentIM — the open Claude Instant Messenger

Message a running Claude Code agent in its own session, and have it pass things along to another. This is an open rebuild of the cIM panel from the WikiWidget app, reverse-engineered from its screen and the maintainer's answers; the rest of that app (the wiki, the triage sessions, the job-specific tools) is not part of it.

Status: the coordination core is built and tested. The daemon, the transports and the panel wait on the open questions below.

## What the panel does (as read off the screen)

- A roster of running agents: name, `busy` / `idle` / `stopped`, `interactive` or `background`, the repository or worktree, and the time since its last activity.
- One agent selected: its working directory and its transcript, assistant turns only, mirroring what its terminal shows.
- A composer: a message to that agent lands in its session as a user turn, with a standing preamble ("when the user asks you to send a message to another agent, use Claude Code agent-to-agent messaging; if you cannot see the agent in question, search active agents for the keywords in the message"), and the panel shows `Delivered — waiting for <agent>…` until the agent answers.
- Agent-to-agent passing rides Claude Code's own peer messaging; the panel adds the human's way in.
- A volunteer request (from the "Nobody Volunteered" talk): every agent sees a task's title and one instruction, volunteer if you have context and keep working; replies are two lines; a person picks; the description reaches only the picked agent; the others are released only after the briefing lands; silence for 30 seconds reads as busy; "nobody volunteered" is a button that starts a fresh agent with the briefing as its first prompt.
- Escalations: an agent can raise something that needs the person's confirmation.

## The core (built)

Pure, clock-injected, no I/O, no ledger. Every time claim states the clock reading it was measured at.

| Module | What it holds | From |
|---|---|---|
| `claims.ts` | `ClaimRegistry`: `{agent, resource, verb, confidence, ttlMs}` written by the harness on the agent's behalf; live until TTL or completion, no cleanup logic; first writer wins and the refusal carries the winner; the same agent renews. Resources are opaque: worktree paths and task ids first (D8). | markspace review, Item 4 |
| `volunteer.ts` | `VolunteerRound`: a fixed 30-second window (D9); deferred resolution, highest declared confidence wins, ties to the earliest reply; a person may pick anyone; late replies land but never decide; `nobody` names the silent and the declined; the others are released only after `briefed()`. | Item 4, the talk |
| `canary.ts` | `CanaryGate`: a fresh id per session, the prompt line that carries it, a gate that refuses every tool call until `cim_ack` with the exact id, stops the session on the first unacknowledged call and reports it; the acknowledgment is recorded by the harness. The canary never reaches a ledger. | Item 5 |
| `status.ts` | `buildStatusReport`: per agent its state against the clock it states, its live claims and its canary state; the worktrees left behind (unmerged or dirty); the sessions needing review. | the status report |

`npm test` runs the example and property tests (fast-check). Boundary: nothing here imports or writes stenographer; claims are ephemeral and are not truth.

## Open questions before the daemon and the panel

1. **Delivery transport.** How does a message reach an interactive session: tmux `send-keys`, Terminal.app via AppleScript, a PTY the daemon spawns, or a Claude Code hook that drains an inbox? Does cIM start the `claude` processes (the `caffeinate · claude` tabs), or attach to ones started by hand?
2. **Discovery.** Where does the roster come from: the transcripts under `~/.claude/projects`, the process list, or a registry the spawner writes? What makes an agent `busy` versus `idle`?
3. **"Delivered — waiting".** What ends the wait: the next assistant turn in the transcript, an explicit acknowledgment, or the session's stop event?
4. **Background mode.** Are background agents headless `claude -p` runs with a worktree per task, and is that what the "nobody volunteered" button starts?
5. **Agent-to-agent.** Confirm it is Claude Code's built-in peer messaging and cIM relays nothing itself.
6. **Home and shape.** A new public repository (name, license), and the panel's stack: a local daemon with a web UI like WikiWidget, or a TUI.
