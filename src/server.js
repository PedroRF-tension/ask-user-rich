#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AppendInputShape, AskInputShape, AwaitInputShape, normalizeQuestion, recommendedIds, semanticProblems } from "./schema.js";
import { buildResult, summarize } from "./answers.js";
import { InterviewHub } from "./hub.js";
import { archiveResult, log, logDir } from "./log.js";
import { openBrowser } from "./opener.js";

const VERSION = "0.3.0";
const PROGRESS_MS = Number(process.env.ASK_USER_RICH_PROGRESS_MS || 15000);
const ELICIT_TIMEOUT_MS = 6 * 60 * 60 * 1000;

const hub = new InterviewHub({
  host: process.env.ASK_USER_RICH_HOST || "127.0.0.1",
  port: Number(process.env.ASK_USER_RICH_PORT || 0),
  portSpan: Number(process.env.ASK_USER_RICH_PORT_SPAN || 10),
  publicHost: process.env.ASK_USER_RICH_PUBLIC_HOST || "localhost",
});
const HAS_PUBLIC = !["localhost", "127.0.0.1", "[::1]"].includes(process.env.ASK_USER_RICH_PUBLIC_HOST || "localhost");

/** The links block the model repeats to the user: internal always, public when configured. */
function linksText(session) {
  const { internal, public: pub } = hub.urls(session);
  return pub ? `- Internal (this machine): ${internal}\n- Public (other devices): ${pub}` : `- ${internal}`;
}

const mcp = new McpServer(
  { name: "ask-user-rich", version: VERSION },
  {
    instructions: [
      "ask_user_rich collects answers to a structured interview through a form in the user's browser: one question " +
        "per screen (a keyboard-driven stepper ending in a review screen), any number of questions and options, " +
        "markdown context, a highlighted recommendation with its rationale, free-text Other, per-question notes, and " +
        "defer / need-more-info. Prefer it over AskUserQuestion when you have more than 4 questions, more than 4 " +
        "options, long headers, code or layout previews, or a recommendation you want to argue for. The call blocks " +
        "until the user submits.",
      "",
      "Common mistakes (each one rejects the whole call):",
      "- Non-ASCII ids. Question and option ids must match [A-Za-z0-9_.:-]: no accents, cedillas, spaces or emoji. " +
        "Write `secao-tabs`, not `seção-tabs`. Labels, headers and bodies take any Unicode, so keep the accents there.",
      "- `recommended` holding a label instead of an option id, or an array of ids on a question without multiSelect: true.",
      "- `dependsOn` naming a question that comes later in the list (or the question itself). Order questions so " +
        "prerequisites come first.",
      "- A question with no options and allowOther: false, which can never be answered.",
      "- Duplicate question ids, or duplicate option ids within one question.",
      "- A rank question (kind: \"rank\") with fewer than 2 options, with multiSelect: true, or with a `recommended` " +
        "that is not an array holding every option id exactly once (the recommended order).",
      "",
      "Links:",
      "- Every result that carries a form link carries `urls: { internal, public }`. `internal` is the loopback URL " +
        "the local browser opens; `public` is the same form on the configured public host (another device, e.g. a " +
        "phone over Tailscale), or null when none is configured.",
      "- Whenever you mention a form in chat, show every non-null URL as its own clickable markdown link, labelled, " +
        "internal first:\n  - **Internal** (this machine): <internal>\n  - **Public** (other devices): <public>\n" +
        "  Never show only one of them when both exist.",
      ...(HAS_PUBLIC
        ? [
            "- A public host is configured, so the user may answer from another device. The browser-opening call " +
              "blocks before you can print anything, so prefer delivery: \"link\": show both links, then call " +
              "await_user_answers.",
          ]
        : []),
      "",
      "After the call:",
      "- If it returns status \"awaiting\" (delivery=link, or the browser could not be opened, e.g. WSL without " +
        "interop), show the user the links as above, then call await_user_answers with the sessionId. " +
        "Do not ask the questions again in chat.",
      "- To ask follow-ups while the form is still open (ask_user_rich returned \"awaiting\", or an ask_user_rich / " +
        "await_user_answers call is still waiting in the background), call append_questions with the sessionId " +
        "instead of opening a second form. The open form updates live.",
      "- Treat deferred and needs-info answers as open, not as consent: follow up on needs-info with the missing " +
        "context, and do not act on a deferred question.",
      "- Read the notes: users often put the real constraint there.",
    ].join("\n"),
  },
);

function errorResult(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

function answersResult(result) {
  const summary = summarize(result);
  return {
    content: [
      { type: "text", text: summary },
      { type: "text", text: JSON.stringify(result, null, 2) },
    ],
    // Claude Code hands the model structuredContent instead of the text blocks when both are present
    // (observed with v2.1.280), so the summary travels inside it too.
    structuredContent: { summary, ...result },
  };
}

function pendingResult(session, url, reason) {
  const structured = { status: "awaiting", sessionId: session.id, url, urls: hub.urls(session), reason };
  return {
    content: [
      {
        type: "text",
        text:
          `${reason}\nThe interview "${session.spec.title}" is waiting at:\n${linksText(session)}\n\n` +
          `Show these links to the user (every one, labelled), then call await_user_answers with sessionId "${session.id}" to wait for the submit.`,
      },
    ],
    structuredContent: structured,
  };
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Blocks until the form is submitted, sending a progress notification every PROGRESS_MS so the client
 * does not treat the call as idle.
 */
async function waitWithProgress(session, extra, url) {
  const progressToken = extra._meta?.progressToken;
  log("waiting", { id: session.id, url, progressToken: progressToken === undefined ? "none" : "present" });
  // The spec requires progress to increase on every notification, so it counts ticks; the message carries the time.
  let ticks = 0;
  const pub = hub.urls(session).public;
  const tick = async () => {
    if (progressToken === undefined) return;
    const elapsed = Date.now() - session.createdAt;
    ticks += 1;
    await extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: ticks,
        message: `Waiting for answers to "${session.spec.title}" at ${url}${pub ? ` (public: ${pub})` : ""} (${formatElapsed(elapsed)} elapsed)`,
      },
    });
    log("progress sent", { id: session.id, tick: ticks });
  };
  await tick().catch((error) => log("tick failed", { error: String(error) }));
  try {
    const result = await hub.wait(session, { signal: extra.signal, tickMs: PROGRESS_MS, onTick: tick });
    return answersResult(result);
  } catch (error) {
    if (error.name !== "AbortError") throw error;
    // The form stays open: whatever the user submits later is archived and await_user_answers can still fetch it.
    log("wait ended without answers", { id: session.id, reason: error.message, state: session.state });
    return errorResult(
      `Stopped waiting for "${session.spec.title}" (${error.message}). The form stays open at:\n${linksText(session)}\n` +
        `call await_user_answers with sessionId "${session.id}" to collect the answers later.`,
    );
  }
}

function elicitationSchema(spec) {
  const properties = {};
  const required = [];
  for (const q of spec.questions) {
    const recs = recommendedIds(q);
    const recLabels = recs.map((id) => q.options.find((o) => o.id === id).label);
    const description = [
      q.body,
      recLabels.length ? `Recommended: ${recLabels.join(", ")}${q.rationale ? ` - ${q.rationale}` : ""}` : null,
    ]
      .filter(Boolean)
      .join("\n\n");
    const choices = q.options.map((o) => ({
      const: o.id,
      title: recs.includes(o.id) ? `${o.label} (recommended)` : o.label,
    }));
    if (choices.length > 0) {
      properties[q.id] = q.multiSelect
        ? { type: "array", title: q.header, description, items: { anyOf: choices }, ...(recs.length ? { default: recs } : {}) }
        : { type: "string", title: q.header, description, oneOf: choices, ...(recs.length ? { default: recs[0] } : {}) };
    }
    if (q.allowOther) {
      properties[`${q.id}__other`] = {
        type: "string",
        title: choices.length > 0 ? `${q.header} - Other (optional)` : q.header,
        ...(choices.length === 0 && description ? { description } : {}),
      };
    }
  }
  return { type: "object", properties, required };
}

async function askByElicitation(spec, extra) {
  const session = { id: `elicit-${Date.now().toString(36)}`, spec, createdAt: Date.now() };
  const response = await mcp.server.elicitInput(
    {
      mode: "form",
      message: [spec.title, spec.intro].filter(Boolean).join("\n\n"),
      requestedSchema: elicitationSchema(spec),
    },
    { signal: extra.signal, timeout: ELICIT_TIMEOUT_MS },
  );
  const content = response.content ?? {};
  const answers = {};
  if (response.action === "accept") {
    for (const q of spec.questions) {
      const value = content[q.id];
      answers[q.id] = {
        status: "answer",
        selected: value === undefined || value === "" ? [] : Array.isArray(value) ? value : [value],
        other: content[`${q.id}__other`],
      };
    }
  }
  const result = buildResult(session, { answers }, "elicitation");
  if (response.action !== "accept") result.status = response.action === "decline" ? "declined" : "cancelled";
  archiveResult(result);
  log("elicitation finished", { id: session.id, action: response.action, counts: result.counts });
  return answersResult(result);
}

function clientCanElicitForms() {
  const elicitation = mcp.server.getClientCapabilities()?.elicitation;
  if (!elicitation) return false;
  // An empty elicitation capability predates modes and means form support.
  return Object.keys(elicitation).length === 0 || Boolean(elicitation.form);
}

mcp.registerTool(
  "ask_user_rich",
  {
    title: "Ask the user a structured interview",
    description:
      "Ask the user any number of questions at once in a rich browser form and wait for their answers. " +
      "Use it instead of AskUserQuestion for grilling rounds, design reviews and any decision set with more than " +
      "4 questions or 4 options, long headers, markdown context, code/layout previews, or recommendations you want " +
      "to argue for.\n\n" +
      "Each question has an id, a header, a markdown body, options (id, label, markdown description, optional " +
      "markdown/code preview), an optional recommended option id plus rationale, multiSelect, allowOther " +
      "(free text, default true) and dependsOn (earlier question ids, display only). Set kind: \"rank\" to have the " +
      "user order every option by priority instead of picking (returns `ranked`; `recommended` is then the full " +
      "recommended order). The user can also defer a question, mark it as needing more info, and leave notes.\n\n" +
      "Blocks until the user submits (it may take minutes; in Claude Code a long call continues as a background " +
      "task). Returns `summary` (one line per question) plus, for each question, its status " +
      "(answered | deferred | needs-info | unanswered), selected option ids and labels, ranked ids and labels " +
      "(rank questions), other text, notes, and " +
      "whether the recommendation was followed. Act on deferred and needs-info items instead of assuming answers. " +
      "If the browser cannot be opened, returns the URL and a sessionId: show the URL, then call await_user_answers.\n\n" +
      "Ids (question and option) are ASCII only, [A-Za-z0-9_.:-]: `secao-tabs`, never `seção-tabs`. " +
      "`recommended` takes option ids, not labels. `dependsOn` may only name earlier questions.",
    inputSchema: AskInputShape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (args, extra) => {
    const problems = semanticProblems(args);
    if (problems.length > 0) return errorResult(`Invalid interview:\n- ${problems.join("\n- ")}`);
    args.questions = args.questions.map(normalizeQuestion);
    log("ask_user_rich called", { title: args.title, questions: args.questions.length, delivery: args.delivery });

    if (args.delivery === "elicitation") {
      // Native forms have no ordering control, so a rank question needs the browser form.
      if (args.questions.some((q) => q.kind === "rank")) log("elicitation cannot rank; falling back to browser");
      else if (clientCanElicitForms()) return askByElicitation(args, extra);
      else log("elicitation unsupported by client; falling back to browser");
    }

    await hub.start();
    const session = hub.create(args);
    const url = hub.url(session);
    log("session created", { id: session.id, url });

    if (args.delivery === "link") return pendingResult(session, url, "Browser opening was skipped (delivery=link).");

    const open = await openBrowser(url);
    log("browser open", { id: session.id, ...open });
    if (!open.opened) return pendingResult(session, url, `Could not open the browser (${open.error}).`);
    return waitWithProgress(session, extra, url);
  },
);

mcp.registerTool(
  "await_user_answers",
  {
    title: "Wait for a pending interview",
    description:
      "Wait for the user to submit an interview that ask_user_rich left pending (delivery=link, a failed browser " +
      "open, or an earlier call that stopped waiting). Returns the same summary and JSON as ask_user_rich; " +
      "returns immediately if the user already submitted.",
    inputSchema: AwaitInputShape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ sessionId }, extra) => {
    const session = hub.get(sessionId);
    if (!session) return errorResult(`No interview with sessionId "${sessionId}" (it may have expired or the server restarted).`);
    if (session.state === "submitted") return answersResult(session.result);
    if (session.state === "cancelled") return errorResult(`Interview "${sessionId}" was cancelled.`);
    return waitWithProgress(session, extra, hub.url(session));
  },
);

mcp.registerTool(
  "append_questions",
  {
    title: "Add follow-up questions to an open interview",
    description:
      "Append follow-up questions to an interview whose form is still open, instead of opening a second form. " +
      "Use it after ask_user_rich returned status \"awaiting\", or while a backgrounded ask_user_rich / " +
      "await_user_answers call is still waiting: the open form updates live, shows the optional `note` as a " +
      "banner, and the user answers everything in one submit.\n\n" +
      "Questions take the same shape and rules as in ask_user_rich. Ids must be unique across the whole " +
      "interview; dependsOn may name any existing question or an earlier one in this call. Returns at once; " +
      "the answers arrive through the call that is already waiting, or through await_user_answers. Fails once " +
      "the user has submitted: then ask a new interview.",
    inputSchema: AppendInputShape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ sessionId, questions, note }) => {
    const session = hub.get(sessionId);
    if (!session) return errorResult(`No interview with sessionId "${sessionId}" (it may have expired or the server restarted).`);
    if (session.state !== "pending") {
      return errorResult(
        `Interview "${sessionId}" is already ${session.state}, so questions can no longer be appended. ` +
          "Ask the follow-ups in a new ask_user_rich call.",
      );
    }
    const existing = session.spec.questions.length;
    const problems = semanticProblems({ questions: [...session.spec.questions, ...questions] }, { startIndex: existing });
    if (problems.length > 0) return errorResult(`Invalid follow-up questions:\n- ${problems.join("\n- ")}`);

    const version = hub.append(session, questions.map(normalizeQuestion), note);
    const total = session.spec.questions.length;
    const url = hub.url(session);
    log("questions appended", { id: session.id, appended: questions.length, total, version, note: note ? "yes" : "no" });
    return {
      content: [
        {
          type: "text",
          text:
            `Appended ${questions.length} question(s) to "${session.spec.title}" (now ${total}, version ${version}). ` +
            `The open form updates live at:\n${linksText(session)}\n` +
            `Keep waiting for the submit: an ask_user_rich or await_user_answers call that is already waiting returns ` +
            `once the user submits; otherwise call await_user_answers with sessionId "${session.id}".`,
        },
      ],
      structuredContent: { status: "appended", sessionId: session.id, appended: questions.length, total, version, url, urls: hub.urls(session) },
    };
  },
);

let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down", { reason });
  await hub.stop().catch(() => {});
  process.exit(0);
}

process.stdin.on("close", () => shutdown("stdin closed"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

await mcp.connect(new StdioServerTransport());
log("mcp server started", { version: VERSION, node: process.version, logDir });
