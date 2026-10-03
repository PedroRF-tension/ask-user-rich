# ask-user-rich

A Claude Code mod (a function-hook plugin) that gives the model a rich way to ask you questions, and gives
every conversation **one stable page**, its **Thread**, where all of its questions, follow-ups and messages
land in order.

- The model calls `ask_user_rich` with a **Round** of questions. The call returns at once, the model ends
  its turn, and the Round appears on the Thread page as a card. Open it to get a keyboard-driven stepper:
  one question per screen, markdown, previews, recommendations with rationale, rank questions, notes,
  defer and need-more-info.
- When you submit, **the answers come back by themselves**: they start the model's next turn when the
  session is idle, or are folded into the turn that is running. Nothing waits in a loop.
- The **links are drawn by the mod** under the tool call (Internal for this machine, Public for another
  device such as a phone over Tailscale), so they never depend on the model remembering to print them.
- While a Thread is open the page **mirrors the conversation**: the model's text, what you type in the
  terminal, and a one-line chip per tool call. A **composer** sends a message back; **End** closes the
  Thread and tells the model the discussion is over.
- A status line shows whether the model is working, waiting for you, idle, or not running. Answers sent
  while the session is not running are delivered when the conversation resumes.
- `http://<host>:<port>/` lists every live Thread, so one bookmark reaches whichever conversation is asking.

Requires Claude Code with function hooks (2.1.288 or newer) and Node.js 20 or newer.

## Install

The mod loads from a user-level skills folder, so it is available in every project:

```bash
git clone https://github.com/PedroRF-tension/ask-user-rich.git ~/.claude/skills/ask-user-rich
cd ~/.claude/skills/ask-user-rich && npm ci
```

Start a new Claude Code session. Check with `claude plugin validate ~/.claude/skills/ask-user-rich`.
To try it without installing: `claude --plugin-dir /path/to/ask-user-rich`.

If an older version is registered as an MCP server under the same name, remove it first
(`claude mcp remove --scope user ask-user-rich`): both would offer `mcp__ask-user-rich__*`.

## Configuration

Rows in `/config` (the mod's `userConfig`), or `pluginConfigs["ask-user-rich"].options` in settings:

| Option | Default | Effect |
|---|---|---|
| `enabled` | `true` | Off: no tools, no guard, no mirroring; everything passes through |
| `hosts` | `127.0.0.1` | Addresses the page binds, comma-separated, e.g. `127.0.0.1,100.x.y.z` for loopback plus a tailnet |
| `publicHost` | `localhost` | Host of the Public link; a loopback name shows no Public link |
| `port` | `47810` | The one port every Thread page is served on |

`PROMETHEUS_MODS=off` in the environment switches it off too. A change restarts the daemon once no Round
is open anywhere.

## The model's tools

| Tool | Does |
|---|---|
| `ask_user_rich` | `{ title, intro?, questions }`. Opens a Round on the conversation's Thread, or adds the questions to the Round still open, under the title. Returns at once. |
| `append_questions` | `{ questions, note? }`. Follow-ups to the open Round; the open page updates live and shows the note. |
| `close_thread` | `{ summary }`. Closes the Thread: mirroring stops and the page shows the summary. |

The question schema is the one the form has always taken (ids ASCII-only, `recommended` holding option ids,
`dependsOn` naming earlier questions, rank questions holding a full recommended order). Invalid input is
rejected with every problem listed and, where one is known, its fix.

Only the main conversation asks: a subagent's call is refused with a note to report the decision back.
While grilling is armed (a grilling skill, or a "grill me" prompt) or a Thread is open, AskUserQuestion is
denied in favour of `ask_user_rich`, except for the rest of a turn in which ask-user-rich itself failed.

## How it works

```
Claude Code session ── mod (hooks) ──Unix socket──▶ daemon ◀──HTTP── browser (Thread page)
```

- **The mod** (`hooks/`) registers the tools, starts the daemon when it is absent (restarting it on a new
  version or changed addresses when no Round is open), polls it about once a second while the
  conversation has a Thread, and stores what you sent: `$.prompt.submit` when idle, an appended user row
  when busy. Every `$` call is in `hooks/register.tsx`; the rules are pure files in `hooks/lib/`.
- **The daemon** (`daemon/`) is one process per machine. It keeps each Thread as a JSON document in
  `~/.cache/ask-user-rich/threads/`, the permanent answer archive in `~/.cache/ask-user-rich/answers/`, and
  its log in `~/.cache/ask-user-rich/daemon.log`. It serves the mod over `daemon.sock` (never on TCP) and
  the page over HTTP. It exits after 24 hours with no open Round and no page connected; a Thread is pruned
  seven days after its last activity.
- **The page** (`public/`) is vanilla JavaScript with no build step: the Thread stream (`thread.html`,
  `js/`), the index (`home.html`), and the stepper as focus mode (`index.html`, `app.js`). Drafts are saved
  to the daemon, so a half-answered Round follows you between devices.

`ASK_USER_RICH_HOME` moves the daemon's state elsewhere (tests use it).

## Security

- The page binds loopback only unless `hosts` adds another address; keep that to a private network such as
  a tailnet. Requests whose `Host` is not loopback or the public host get a 403 (DNS rebinding).
- Each Thread URL carries a random 144-bit token. The root index lists every live Thread, so anyone who
  can reach the port can open them.
- The mod's routes exist only on the Unix socket (mode 600).
- Writes must be `application/json`, which forces a CORS preflight the daemon never answers.
- Markdown is rendered with `marked` and sanitized with DOMPurify, both served from local `node_modules`.

## Development

```bash
npm test             # the daemon as a black box (S1), plus the schema sync check
npm run test:mod     # the mod through the engine's plugin test kit (S2)
npm run gen:schemas  # regenerate hooks/lib/schemas.gen.ts after changing src/schema.js
claude plugin validate .
```

`docs/probes.md` records the plugin-API behaviours the design rests on and what the smoke run found.

## License

MIT. See [LICENSE](LICENSE).
