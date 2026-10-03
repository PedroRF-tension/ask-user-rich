# Plugin API probes (2026-10-03, Claude Code 2.1.288)

Throwaway function-hook plugins, run with `claude -p … --plugin-dir` and, for the wake, an interactive
session in tmux. The probe plugin lives outside the repo (`~/.cache/prometheus-mods/probes/aur-probe`).

**Contradicts the spec:** there is no `tool.offer` event (only `agent.offer`, for agent types), so the
mod cannot hide its tools from subagents. It refuses their calls instead, with a reason that says only the
main conversation asks. Plugin tool results must be a string or an array of content blocks: a plain object
fails the engine's output check ("Invalid input").

## A detached daemon outlives the session

`$.process.run(['node', 'spawn.mjs'])`, where the script spawns a child with `detached: true,
stdio: 'ignore'` and `unref()`s it, returns at once (exit 0), and the child kept writing its heartbeat
file after `claude -p` had exited (`kill -0` on its pid succeeded). The mod starts the daemon this way
through `daemon/launch.js`, which also waits for the socket before it exits.

## `$.prompt.submit` from a timer wakes an idle interactive session

A `$.clock.after(20000, …)` armed in `session.start` called `$.prompt.submit({ text })` while the
session sat idle at the prompt. A turn started at once; the transcript shows "Prompt from the aurprobe
plugin" and the model read "The aurprobe plugin sent a message: …" and answered it. The call resolved
`{ text, origin: { kind: 'plugin', name } }`.

## `$.session.append` of a user row is read mid-turn

A `tool.call` hook on Bash appended `{ type: 'user', content: [text] }` after the call; the model's
next step read it (it repeated the code word it carried). The row is stored `isMeta` with role `user`.

## `$.http.fetch` over a Unix socket: fine, but 30 s at most

Requests over `socketPath` work (status, text). A request the server holds longer than 30 s is
aborted by the engine ("no complete answer within 30000ms"), so the mod cannot long-poll past that.
The mod polls the daemon about once a second instead, with short requests; the poll doubles as the
heartbeat the daemon uses to tell a running session from a gone one.

## No `tool.offer`

The declaration file has `agent.offer` (agent types) and `tool.describe` (a description and its
deferral) but nothing that offers a tool per loop. The tools are listed everywhere; the mod denies a
call that carries an `agentId`.
