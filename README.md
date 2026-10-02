# ask-user-rich

A stdio MCP server that gives Claude Code a richer way to ask the user than the built-in
`AskUserQuestion`, which is limited to 1–4 questions, 2–4 options and 12-character headers. It is built
for long structured interviews, or "grilling rounds". Claude sends the whole interview in one call, the
server serves it as a local web form, and the call blocks until the user submits.

Requires Node.js 20 or newer. Works with Claude Code and any other MCP client that supports stdio servers.

## Quick start

Register it with Claude Code at user scope, so it is available in every project:

```bash
claude mcp add-json --scope user ask-user-rich \
  '{"type":"stdio","command":"npx","args":["-y","github:PedroRF-tension/ask-user-rich"],"timeout":14400000}'
claude mcp get ask-user-rich        # expect: Status: ✔ Connected
```

Then ask Claude to "grill me with ask_user_rich about …", or let it choose the tool when a round of
questions outgrows `AskUserQuestion`. See [Install](#install-reinstall-uninstall) for a local clone instead of npx.


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
- `kind`: `choice` (default) or `rank`. A rank question has the user put every option in order of priority,
  by dragging or from the keyboard. It needs at least 2 options, takes no `multiSelect`, and has no Other
  field.
- `recommended`: an option id, or an array of ids when `multiSelect` is on. For a rank question it is the
  recommended order: an array holding every option id exactly once.
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
- A rank question shows numbered rows. You can drag them with the mouse or move them from the keyboard
  (see the table), and the other rows slide aside. Nothing is recorded until you move a row or press
  "Keep this order" (`C`), so Claude never mistakes the default order for a deliberate ranking.
- **Show all** (`V`, or the header button) stacks every screen on one page. The rail then scrolls to a
  question instead of switching screens, and it tracks the question you are reading as you scroll. The
  choice is remembered.
- **Scrolling follows the keyboard.** When focus moves by keyboard (arrows, Tab, `N`, `O`, …), the page
  scrolls smoothly so the focused item stays in the middle half of the space between the header and the
  footer. It no longer waits until the item is off screen. A tall option, such as one with a big preview,
  is pinned near the top instead. Mouse clicks never scroll the page.
- **Live follow-ups.** When Claude calls `append_questions`, the open form picks up the new questions
  within about 2.5 s: new rail chips carry a dot, a notice shows Claude's note, and `G` jumps to the first
  new question. If a submit races an append, the server refuses it (409). The form then pulls in the new
  questions and asks you to look at them before submitting again, so no question is lost unseen.

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
| `V` | Show all questions on one page / back to one per screen |
| `G` | Go to the follow-up questions Claude just added |
| Rank: `Space`, then `↑` `↓`, then `Space` / `Enter` | Pick up the focused row, move it, drop it. `Esc` cancels and restores the order. |
| Rank: `Shift` + `↑` `↓` | Move the focused row directly |
| Rank: `1`–`9` | Send the focused row to that position |
| Rank: `C` / `R` / `X` | Keep the order as shown / apply the recommended order / reset |
| `Esc` | Leave a text field so the single-key shortcuts work again |
| `Tab` | Options → Other → answer mode → note → Back / Next |

The form works in light and dark mode and follows the OS setting unless the Theme button forces one.
Drafts survive a reload because they are stored in the browser's localStorage, along with the screen you
were on. If Claude stops waiting, the page says so and the answers can still be submitted.

The result has:
- `structuredContent`: `{ summary, interviewId, title, status, via, submittedAt, durationSeconds, counts, generalNotes, answers[] }`.
  Each `answers[]` entry is `{ id, header, status, selected, selectedLabels, other, ranked, rankedLabels, notes, followedRecommendation }`,
  where `status` is `answered`, `deferred`, `needs-info` or `unanswered`.
  - `ranked` and `rankedLabels` give the order for an answered rank question, and are `null` otherwise.
  - For a rank question, `followedRecommendation` means the order matches the recommendation exactly. The
    summary line reads `A > B > C`.
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
- **Bad rank questions.** A rank question is rejected if it has fewer than 2 options or has
  `multiSelect`. It is also rejected if its `recommended` is not a full order: the error names the missing,
  repeated or unknown ids.
- **Duplicate ids.**
- **A question that cannot be answered at all**: no options and `allowOther: false`.

The MCP `instructions` and the tool description list these same mistakes, so the model sees them before
the first call, not after the first rejection.

### `append_questions`

Takes `{ sessionId, questions, note? }` and adds follow-up questions to an interview whose form is still
open. It returns at once with `{ status: "appended", sessionId, appended, total, version, url }`.

Use it when `ask_user_rich` returned "awaiting", or while an `ask_user_rich` or `await_user_answers` call
is still waiting in the background. The user answers everything in one submit, and the answers arrive
through the call that is already waiting (or through `await_user_answers`).

The questions follow the same rules as in `ask_user_rich`:
- ids must be unique across the whole interview;
- `dependsOn` may name any existing question, or an earlier question in the same call.

Error numbering starts at `questions[0]`, the first appended question. Once the user has submitted,
the call fails and tells the model to ask a new interview instead.

HTTP contract behind it:
- Every append increments the session's `version`. `GET /api/s/:token` and `/state` report the current
  version, and `GET /api/s/:token` also returns `note`.
- A submit carrying an outdated `specVersion` gets a 409 with the current `version`.
- A submit that leaves `specVersion` out is still accepted.

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

- `browser` opens the form with `open` on macOS, `cmd /c start` on Windows, and `xdg-open` on Linux.
  - **On WSL with interop enabled**, it tries `wslview`, then `explorer.exe`, then `cmd.exe /c start` and
    `powershell.exe Start-Process`, stopping at the first that works. It skips any that aren't installed.
    `cmd.exe` and `powershell.exe` run with `/mnt/c` as their working directory. The URL is always passed
    as an argument, never built into a shell string. `cmd.exe` is also skipped for URLs with characters
    it would reinterpret.
  - **On WSL with interop disabled**, no Windows opener can run, so none is tried. It uses `xdg-open` only
    if all of these hold:
    - a Linux GUI is available (`DISPLAY` or `WAYLAND_DISPLAY` is set);
    - `xdg-open` and `xdg-mime` are installed;
    - `xdg-mime` names a real https handler that isn't `wslview`.

    This is strict on purpose. Reporting "opened" for a browser that never appeared would make the tool
    wait on a form nobody can see.
  - If every opener fails, the tool returns the URL and a `sessionId` right away instead of blocking.
    The reason lists what was tried, for example: `WSL interop is disabled (…), so Windows openers
    (explorer.exe, cmd.exe, powershell.exe) cannot run; xdg-open is not installed; re-enable interop …`.
    Claude shows the link and calls `await_user_answers`.
- `link` never opens a browser and always returns the URL straight away.
- `elicitation` uses the client's native MCP form dialog, when the client advertises form elicitation.
  It suits small, flat interviews: one field per question, plus an "Other" field. It has no notes, no
  defer and no previews. If the client can't elicit, or the interview has a rank question, it falls back to `browser`. This mode is covered by
  tests with an SDK client only; it has not been tried in Claude Code's own dialog.

### WSL: when the browser never opens

If the tool always returns a link on WSL, interop is probably disabled: `/proc/sys/fs/binfmt_misc` has no
`WSLInterop` entry, so no `.exe` can run from Linux. A known cause is `systemd=true` in `/etc/wsl.conf`,
which can drop the binfmt registration. A commonly used fix is:

```bash
sudo sh -c 'echo ":WSLInterop:M::MZ::/init:PF" > /usr/lib/binfmt.d/WSLInterop.conf'
sudo systemctl restart systemd-binfmt   # or: wsl.exe --shutdown from Windows, then reopen
```

After the fix, check with `ls /proc/sys/fs/binfmt_misc | grep WSLInterop` and
`explorer.exe https://example.com`. Until then, the link fallback still works: open the URL by hand.

## Install, reinstall, uninstall

`claude mcp add` has no timeout flag, so the server is registered through `add-json` with the documented
`timeout` field (4 hours; see [Waiting, progress and timeouts](#waiting-progress-and-timeouts)).

**Option A: npx straight from GitHub** (no clone needed; npx caches the install):

```bash
claude mcp add-json --scope user ask-user-rich \
  '{"type":"stdio","command":"npx","args":["-y","github:PedroRF-tension/ask-user-rich"],"timeout":14400000}'
```

**Option B: a local clone** (pinned to what you checked out, and easy to hack on):

```bash
git clone https://github.com/PedroRF-tension/ask-user-rich.git ~/.claude/mcp-servers/ask-user-rich
cd ~/.claude/mcp-servers/ask-user-rich && npm ci && npm test
claude mcp add-json --scope user ask-user-rich \
  "{\"type\":\"stdio\",\"command\":\"$HOME/.claude/mcp-servers/ask-user-rich/run.sh\",\"args\":[],\"timeout\":14400000}"
```

`run.sh` uses `node` from `PATH`. If `PATH` has none, it falls back to the newest `~/.nvm` Node. You can
also pin one with `ASK_USER_RICH_NODE`. To update a clone: `git pull && npm ci`.

Check it with `claude mcp get ask-user-rich` (expect `Status: ✔ Connected, Timeout: 14400000ms`).

To reinstall after moving the directory or changing the timeout, or to uninstall:

```bash
claude mcp remove --scope user ask-user-rich
# then run the add-json command again, or delete the clone to uninstall
```

Other MCP clients: run `npx -y github:PedroRF-tension/ask-user-rich` (or `run.sh` from a clone) as a
stdio server, and give tool calls a long timeout, since a call waits for the user.

## Running it by hand

```bash
npm test                          # 39 tests: an SDK client driving the server over stdio, plus the opener plan
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
| `ASK_USER_RICH_HOST` | `127.0.0.1` | Bind address; comma-separated to bind several on the same port (e.g. `127.0.0.1,100.x.y.z` for loopback plus Tailscale) |
| `ASK_USER_RICH_PUBLIC_HOST` | `localhost` | Host of the public URL. When it is not loopback, every result carries `urls: { internal, public }` and the instructions tell the model to show both |
| `ASK_USER_RICH_PROGRESS_MS` | `15000` | Progress notification interval |
| `ASK_USER_RICH_LOG_DIR` | `logs/` in the package directory | Log and answer archive location |

Set these with `-e`/`env` on the MCP entry, or in the environment Claude Code starts with. The server
inherits Claude Code's environment.

## Logs

- `logs/server.log` records every call, session, browser-open result, progress tick, page view (with
  its user agent) and submit. The same lines go to stderr, which Claude Code captures in `claude --debug`
  output.
- `logs/answers/<timestamp>-<id>.json` archives every submitted interview, so answers survive even when
  the tool call that asked for them is gone.

## Security

- The server listens on loopback only, unless `ASK_USER_RICH_HOST` adds another address (keep that to a private network such as a tailnet).
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

## License

MIT. See [LICENSE](LICENSE).
