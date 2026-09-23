# ask-user-rich

A stdio MCP server that gives Claude Code a richer way to ask the user than the built-in
`AskUserQuestion`, which is limited to 1–4 questions, 2–4 options and 12-character headers. It is built
for long structured interviews, or "grilling rounds". Claude sends the whole interview in one call, the
server serves it as a local web form, and the call blocks until the user submits.

## Tools

### `ask_user_rich`

The input has:
- `title`;
- an optional `intro` (markdown);
- `questions`, with no upper bound;
- `delivery`, one of `browser` (default), `link` or `elicitation`.

Each question has:
- `id`;
- `header`, the question itself, with no length cap;
- `body` (markdown);
- `options`, with no upper bound. Each option has an `id`, a `label`, a markdown `description` and an
  optional markdown `preview`, such as a fenced code block. An empty `options` list makes the question
  free-text only.
- `recommended`: an option id, or an array of ids when `multiSelect` is on;
- `rationale` (markdown);
- `multiSelect`;
- `allowOther`: free text, default `true`;
- `dependsOn`: ids of earlier questions. It only affects display, as a "Builds on #n" link.

The form is a stepper that shows one question per screen:
- It opens on an intro screen (only when `intro` is set), then shows one screen per question, then a review
  screen. The review screen lists every answer and note; click a row to jump back to that question. It also
  holds the general-notes box and the submit button. If some questions are still unanswered, the first
  submit asks for confirmation.
- A numbered rail in the header shows each question's status (answered, deferred, needs info, open) and the
  current screen. Click a number to jump to that question. A progress bar tracks how many questions are
  resolved.
- Screens slide in from the direction you move, and the slide is skipped when `prefers-reduced-motion` is set.
- Each question shows its recommendation and rationale, single or multi select, Other text, a note, and an
  Answer / Defer / Need more info switch. "Builds on" links jump to the earlier question.

Everything can be done from the keyboard (press `?` in the form for the same table):

| Keys | Action |
|---|---|
| `←` `→` or `H` `L` | Previous / next screen |
| `Enter` | Next screen. On a single-choice question with nothing picked yet, it first picks the focused option. On the review screen it submits. |
| `Ctrl`/`Cmd` + `Enter` | Next screen or submit, even while typing in a text field |
| `Home` `End` | Go to the first screen / the review screen |
| `↑` `↓` or `K` `J` | Move between options. The option list is a single Tab stop. |
| `Space` | Pick or unpick the focused option |
| `1`–`9` | Pick an option by its number |
| `O` | Other: select it and focus its text field |
| `R` | Take the recommendation |
| `N` | Focus the note |
| `D` / `I` | Toggle Defer / Need more info. `I` also focuses the note. |
| `X` / `Backspace` | Clear the answer |
| `A` | On the review screen: accept every recommendation that is still unanswered |
| `Esc` | Leave a text field so the single-key shortcuts work again |
| `Tab` | Options → Other → answer mode → note → Back / Next |

The form works in light and dark mode and follows the OS setting unless the Theme button forces one.
Drafts survive a reload because they are stored in the browser's localStorage, along with the screen you
were on. If Claude stops waiting, the page says so and the answers can still be submitted.

The result has:
- `structuredContent`: `{ summary, interviewId, title, status, via, submittedAt, durationSeconds, counts, generalNotes, answers[] }`.
  Each `answers[]` entry is `{ id, header, status, selected, selectedLabels, other, notes, followedRecommendation }`,
  where `status` is `answered`, `deferred`, `needs-info` or `unanswered`.
- `content`: the same summary as text, followed by the JSON.

Claude Code 2.1.280 gave the model only `structuredContent` and dropped the text blocks when both were
present. That is why the summary is also carried inside `structuredContent`.

The server rejects input it cannot use and lists every problem it finds, each with its fix where one is
known:
- **Non-ASCII ids.** Ids must match `[A-Za-z0-9_.:-]`. The error names the bad value and suggests an ASCII
  slug: `"seção-tabs" is not ASCII-safe … use "secao-tabs" instead`. Labels, headers and bodies take any
  Unicode.
- **Bad `recommended`.** A `recommended` value that is not an option id is rejected. When it matches a
  label, the error names the id to use instead. Several recommendations on a single-select question are
  also rejected.
- **Bad `dependsOn`.** A `dependsOn` that names a later question is rejected with "move X before Y". One
  that names an unknown id, or the question itself, is rejected too.
- **Duplicate ids.**
- **A question that cannot be answered at all**: no options and `allowOther: false`.

The MCP `instructions` and the tool description list these same mistakes, so the model sees them before
the first call, not after the first rejection.

### `await_user_answers`

Takes a `{ sessionId }` and waits for an interview that is still pending. An interview is left pending
by `delivery: "link"`, by a failed browser open, or by an earlier call that was cancelled. If the user
has already submitted, it returns at once.

## Waiting, progress and timeouts

- While it waits, the server sends a `notifications/progress` every 15 s
  (`ASK_USER_RICH_PROGRESS_MS`). Claude Code resets its idle timer on these
  ([docs](https://code.claude.com/docs/en/mcp): "A tool call to an MCP server that sends no response and
  no progress notification for the idle window aborts"). Claude Code does send a `progressToken`; the
  log shows `progressToken=present`.
- The server is registered with `"timeout": 14400000`, which is 4 hours. It is a hard wall-clock limit
  per call. Because it is at least 1000 ms, it also acts as a floor for the idle timeout.
- In an interactive session, a call still running after 2 minutes becomes a background task; the
  answers come back as a task notification. `claude -p` does not background calls.
- If a call is cancelled or times out, it stops waiting cleanly, but the form stays open. Submitted
  answers are kept, and `await_user_answers` can still collect them.

## Delivery modes

- `browser` opens the form with `explorer.exe` on WSL, `open` on macOS or `xdg-open` on Linux. If that
  fails, the tool returns the URL and a `sessionId` right away instead of blocking; Claude shows the link
  and calls `await_user_answers`.
- `link` never opens a browser and always returns the URL straight away.
- `elicitation` uses the client's native MCP form dialog, when the client advertises form elicitation.
  It suits small, flat interviews: one field per question, plus an "Other" field. It has no notes, no
  defer and no previews. If the client can't elicit, it falls back to `browser`. This mode is covered by
  tests with an SDK client only; it has not been tried in Claude Code's own dialog.

### WSL note (this machine, 2026-09-23)

WSL interop is currently disabled in this distro: `/proc/sys/fs/binfmt_misc` has no `WSLInterop` entry,
so no `.exe` (explorer.exe, powershell.exe) can run from Linux. The server detects this and falls back to
returning the link. A known cause is `systemd=true` in `/etc/wsl.conf`, which can drop the binfmt
registration. A commonly used fix, which was **not applied or verified here**, is:

```bash
sudo sh -c 'echo ":WSLInterop:M::MZ::/init:PF" > /usr/lib/binfmt.d/WSLInterop.conf'
sudo systemctl restart systemd-binfmt   # or: wsl.exe --shutdown from Windows, then reopen
```

After the fix, check with `ls /proc/sys/fs/binfmt_misc | grep WSLInterop` and
`explorer.exe https://example.com`.

## Install, reinstall, uninstall

The server is installed at user scope, so it is available in every project. `claude mcp add` has no
timeout flag, so it is registered through `add-json` with the documented `timeout` field:

```bash
claude mcp add-json --scope user ask-user-rich \
  '{"type":"stdio","command":"/home/pedro/.claude/mcp-servers/ask-user-rich/run.sh","args":[],"timeout":14400000}'
claude mcp get ask-user-rich        # expect: Status: ✔ Connected, Timeout: 14400000ms
```

To reinstall after moving the directory or changing the timeout:

```bash
claude mcp remove --scope user ask-user-rich
# then run the add-json command above again
```

To reinstall the dependencies (they live in the local `node_modules/`; nothing is installed globally):

```bash
cd /home/pedro/.claude/mcp-servers/ask-user-rich && npm ci
```

To uninstall:

```bash
claude mcp remove --scope user ask-user-rich
rm -rf /home/pedro/.claude/mcp-servers/ask-user-rich   # optional
```

`run.sh` uses `node` from `PATH`. If `PATH` has none, it falls back to the newest `~/.nvm` Node. You can
also pin one with `ASK_USER_RICH_NODE`.

## Running it by hand

```bash
npm test                          # 16 tests: a real SDK client driving the server over stdio
npm run dev                       # asks examples/demo-interview.json and prints the result
node scripts/dev.mjs my.json --link      # print the URL, then wait (use when no browser can be opened)
node scripts/dev.mjs --no-open           # block without opening; the URL is in the progress lines
./run.sh                          # raw stdio server (what Claude Code launches); Ctrl-D to stop
```

## Configuration (environment variables)

| Variable | Default | Effect |
|---|---|---|
| `ASK_USER_RICH_OPEN` | on | `0` disables opening a browser, so the tool returns the link at once |
| `ASK_USER_RICH_OPEN_CMD` | platform opener | Command run with the URL as its only argument |
| `ASK_USER_RICH_PORT` | `0` (random free port) | Fixed port for the form server |
| `ASK_USER_RICH_HOST` | `127.0.0.1` | Bind address |
| `ASK_USER_RICH_PUBLIC_HOST` | `localhost` | Hostname used in the URL |
| `ASK_USER_RICH_PROGRESS_MS` | `15000` | Progress notification interval |
| `ASK_USER_RICH_LOG_DIR` | `./logs` | Log and answer archive location |

Set these with `-e`/`env` on the MCP entry, or in the environment Claude Code starts with. The server
inherits Claude Code's environment.

## Logs

- `logs/server.log` records every call, session, browser-open result, progress tick, page view (with
  its user agent) and submit. The same lines go to stderr, which Claude Code captures in `claude --debug`
  output.
- `logs/answers/<timestamp>-<id>.json` archives every submitted interview, so answers survive even when
  the tool call that asked for them is gone.

## Security

- The server listens on loopback only.
- Each interview URL carries a random 144-bit token.
- Requests whose `Host` header is not loopback get a 403, which blocks DNS rebinding.
- Submits must be `application/json`. That forces a CORS preflight, which the server never answers, so
  other origins cannot post blind.
- Markdown is rendered with `marked` and sanitized with DOMPurify. Both are served from local
  `node_modules`, so no CDN is used.

## Steering Claude toward it (optional, not installed anywhere)

The server already sends MCP `instructions` that recommend it over `AskUserQuestion` for large
interviews. To make that stronger, you can add this to `~/.claude/CLAUDE.md` or to a skill:

```markdown
## Asking me questions
When you need my input on more than 4 questions, more than 4 options, long question text, code or layout
previews, or a recommendation you want to argue for, use the `ask_user_rich` tool (MCP server
ask-user-rich) instead of AskUserQuestion. Put every question of the round in one call, give each one a
recommended option with a rationale, and treat `deferred` / `needs-info` answers as open, not as consent.
If it returns a link instead of answers, show me the link and call `await_user_answers`.
```
