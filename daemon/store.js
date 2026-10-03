// Threads: one per Claude Code conversation, persisted as one JSON document each. Every page and
// mod operation goes through this class; it knows nothing about HTTP.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildResult, summarize } from "../src/answers.js";
import { normalizeQuestion, RoundInputSchema, AppendRoundSchema, semanticProblems } from "../src/schema.js";

export const DAY_MS = 24 * 60 * 60 * 1000;
// A conversation whose mod has not polled for this long counts as not running.
export const ATTACHED_MS = 10_000;

export class InputError extends Error {}
export class ConflictError extends Error {
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra);
  }
}
export class NotFoundError extends Error {}
export class UnprocessableError extends Error {}

const token = () => crypto.randomBytes(18).toString("base64url");
const shortId = () => crypto.randomBytes(6).toString("hex");

function zodProblems(error) {
  return error.issues.map((issue) => `${issue.path.length ? issue.path.join(".") : "input"}: ${issue.message}`);
}

export class Store {
  constructor({ dir, archiveDir, now = () => Date.now(), keepDays = 7, attachedMs = ATTACHED_MS, onChange = () => {}, log = () => {} }) {
    this.attachedMs = attachedMs;
    this.dir = dir;
    this.archiveDir = archiveDir;
    this.now = now;
    this.keepMs = keepDays * DAY_MS;
    this.onChange = onChange;
    this.log = log;
    this.threads = new Map(); // id -> thread
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const thread = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        this.threads.set(thread.id, thread);
      } catch (error) {
        log("thread unreadable", { file, error: String(error) });
      }
    }
  }

  // ---- lookups -------------------------------------------------------------------

  bySession(session) {
    for (const thread of this.threads.values()) if (thread.session === session) return thread;
    return null;
  }

  byToken(value) {
    for (const thread of this.threads.values()) if (thread.token === value) return thread;
    return null;
  }

  requireToken(value) {
    const thread = this.byToken(value);
    if (!thread) throw new NotFoundError("Thread not found or expired.");
    return thread;
  }

  openRound(thread) {
    return thread.rounds.find((r) => r.state === "open") ?? null;
  }

  round(thread, n) {
    const round = thread.rounds.find((r) => r.n === n);
    if (!round) throw new NotFoundError(`Round ${n} not found.`);
    return round;
  }

  isAttached(thread) {
    return thread.lastSeen !== null && this.now() - thread.lastSeen < this.attachedMs;
  }

  /** working | waiting | idle | not-running: what the page's status line shows. */
  presenceOf(thread) {
    if (!this.isAttached(thread)) return "not-running";
    if (thread.presence.state === "working") return "working";
    return this.openRound(thread) ? "waiting" : "idle";
  }

  openRoundCount() {
    let count = 0;
    for (const thread of this.threads.values()) if (this.openRound(thread)) count += 1;
    return count;
  }

  // ---- persistence -----------------------------------------------------------------

  save(thread) {
    thread.lastActivity = this.now();
    thread.rev += 1;
    const file = path.join(this.dir, `${thread.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(thread));
    fs.renameSync(tmp, file);
    this.onChange(thread);
  }

  archive(result) {
    try {
      const stamp = result.submittedAt.replace(/[:.]/g, "-");
      const file = path.join(this.archiveDir, `${stamp}-${result.interviewId}.json`);
      fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
      return file;
    } catch (error) {
      this.log("archive failed", { error: String(error) });
      return null;
    }
  }

  /** Drops threads idle past the keep window; the answer archive is never pruned. */
  prune() {
    const cutoff = this.now() - this.keepMs;
    const gone = [];
    for (const thread of this.threads.values()) {
      if (thread.lastActivity >= cutoff) continue;
      this.threads.delete(thread.id);
      try {
        fs.unlinkSync(path.join(this.dir, `${thread.id}.json`));
      } catch {}
      gone.push(thread.id);
    }
    if (gone.length) this.log("threads pruned", { gone });
    return gone;
  }

  // ---- items -----------------------------------------------------------------------

  push(thread, item) {
    thread.seq += 1;
    const full = { seq: thread.seq, at: this.now(), ...item };
    thread.items.push(full);
    return full;
  }

  setState(thread, state, label, extra = {}) {
    if (thread.state === state) return;
    thread.state = state;
    this.push(thread, { kind: "divider", label, ...extra });
  }

  deliver(thread, delivery) {
    const full = { id: shortId(), createdAt: this.now(), deliveredAt: null, ...delivery };
    thread.deliveries.push(full);
    return full;
  }

  // ---- the mod's side --------------------------------------------------------------

  ensure(session, { project = null, cwd = null, title = null } = {}) {
    let thread = this.bySession(session);
    if (thread) return thread;
    thread = {
      id: shortId(),
      token: token(),
      session,
      project,
      cwd,
      title,
      createdAt: this.now(),
      lastActivity: this.now(),
      lastSeen: this.now(),
      state: "open",
      seq: 0,
      rev: 0,
      items: [],
      rounds: [],
      deliveries: [],
      presence: { state: "idle", chip: null, at: this.now() },
    };
    this.threads.set(thread.id, thread);
    return thread;
  }

  /** Opens a Round, or joins the open one under a new heading. */
  ask(session, input, context = {}) {
    const parsed = RoundInputSchema.safeParse(input);
    if (!parsed.success) throw new InputError(`Invalid interview:\n- ${zodProblems(parsed.error).join("\n- ")}`);
    const args = parsed.data;
    const thread = this.ensure(session, { ...context, title: args.title });
    if (!thread.title) thread.title = args.title;
    const open = this.openRound(thread);
    if (open) {
      const existing = open.spec.questions.length;
      const problems = semanticProblems({ questions: [...open.spec.questions, ...args.questions] }, { startIndex: existing });
      if (problems.length) throw new InputError(`Invalid interview:\n- ${problems.join("\n- ")}`);
      const heading = [`**${args.title}**`, args.intro].filter(Boolean).join("\n\n");
      this.appendTo(thread, open, args.questions, heading, args.title);
      this.reopen(thread, "model");
      this.save(thread);
      return { thread, round: open, joined: true };
    }
    const problems = semanticProblems(args);
    if (problems.length) throw new InputError(`Invalid interview:\n- ${problems.join("\n- ")}`);
    this.reopen(thread, "model");
    const round = {
      n: thread.rounds.length + 1,
      spec: { title: args.title, intro: args.intro, questions: args.questions.map(normalizeQuestion) },
      version: 1,
      note: null,
      sections: [],
      state: "open",
      createdAt: this.now(),
      draft: null,
      draftRev: 0,
      draftBy: null,
      result: null,
      submittedAt: null,
    };
    thread.rounds.push(round);
    this.push(thread, { kind: "round", n: round.n });
    this.save(thread);
    return { thread, round, joined: false };
  }

  appendTo(thread, round, questions, note, section = null) {
    round.spec.questions.push(...questions.map(normalizeQuestion));
    round.version += 1;
    if (note !== undefined && note !== null) round.note = { version: round.version, text: note };
    if (section) round.sections.push({ title: section, from: round.spec.questions.length - questions.length });
  }

  append(session, input) {
    const parsed = AppendRoundSchema.safeParse(input);
    if (!parsed.success) throw new InputError(`Invalid follow-up questions:\n- ${zodProblems(parsed.error).join("\n- ")}`);
    const thread = this.bySession(session);
    const round = thread && this.openRound(thread);
    if (!round) {
      throw new ConflictError("No Round is open in this conversation's Thread, so questions can no longer be appended. Ask them in a new ask_user_rich call.");
    }
    const existing = round.spec.questions.length;
    const problems = semanticProblems({ questions: [...round.spec.questions, ...parsed.data.questions] }, { startIndex: existing });
    if (problems.length) throw new InputError(`Invalid follow-up questions:\n- ${problems.join("\n- ")}`);
    this.appendTo(thread, round, parsed.data.questions, parsed.data.note);
    this.save(thread);
    return { thread, round, appended: parsed.data.questions.length };
  }

  reopen(thread, by) {
    if (thread.state === "closed") this.setState(thread, "open", "reopened", { by });
  }

  close(session, summary, by = "model") {
    const thread = this.bySession(session);
    if (!thread) throw new NotFoundError("This conversation has no Thread.");
    if (thread.state === "closed") return thread;
    this.setState(thread, "closed", "closed", { by, summary: summary ?? null });
    this.save(thread);
    return thread;
  }

  /** Mirrored conversation lines; dropped while the Thread is closed or absent. */
  mirror(session, messages) {
    const thread = this.bySession(session);
    if (!thread || thread.state !== "open") return { stored: 0 };
    let stored = 0;
    for (const m of messages) {
      const text = String(m.text ?? "").trim();
      if (!text) continue;
      if (m.kind === "chip") this.push(thread, { kind: "chip", text });
      else if (m.kind === "assistant" || m.kind === "user") this.push(thread, { kind: "message", role: m.kind, text });
      else continue;
      stored += 1;
    }
    if (stored) this.save(thread);
    return { stored };
  }

  presence(session, { state, chip = null }) {
    const thread = this.bySession(session);
    if (!thread) return null;
    if (state !== "working" && state !== "idle") throw new InputError(`presence must be working or idle, not ${state}`);
    thread.presence = { state, chip: state === "working" ? chip : null, at: this.now() };
    thread.lastSeen = this.now();
    this.save(thread);
    return thread;
  }

  /** The mod's poll: marks the conversation attached and returns what waits for it. */
  pending(session) {
    const thread = this.bySession(session);
    if (!thread) return { thread: null, deliveries: [] };
    const wasAttached = this.isAttached(thread);
    thread.lastSeen = this.now();
    // The heartbeat itself is not activity; only a change of attachment is shown.
    if (!wasAttached) this.save(thread);
    return { thread, deliveries: thread.deliveries.filter((d) => d.deliveredAt === null) };
  }

  ack(session, ids) {
    const thread = this.bySession(session);
    if (!thread) return 0;
    let count = 0;
    for (const d of thread.deliveries) {
      if (d.deliveredAt === null && ids.includes(d.id)) {
        d.deliveredAt = this.now();
        count += 1;
      }
    }
    if (count) this.save(thread);
    return count;
  }

  // ---- the page's side -------------------------------------------------------------

  submit(tokenValue, n, payload) {
    const thread = this.requireToken(tokenValue);
    const round = this.round(thread, n);
    if (round.state !== "open") throw new ConflictError(`Round ${n} was already submitted.`, { state: round.state });
    // Omitting specVersion is accepted, for callers that predate follow-ups.
    if (payload && payload.specVersion !== undefined && payload.specVersion !== round.version) {
      throw new ConflictError("new questions were added", { version: round.version });
    }
    let result;
    try {
      result = buildResult({ id: `${thread.id}-r${n}`, spec: round.spec, createdAt: round.createdAt }, payload, "browser");
    } catch (error) {
      throw new UnprocessableError(error.message);
    }
    result.round = n;
    const archived = this.archive(result);
    round.state = "submitted";
    round.result = result;
    round.submittedAt = this.now();
    round.draft = null;
    this.deliver(thread, { kind: "answers", round: n, summary: summarize(result), result });
    this.save(thread);
    this.log("round submitted", { thread: thread.id, round: n, counts: result.counts, archived: archived ?? "no" });
    return { thread, round, result };
  }

  draft(tokenValue, n, { draft, client = null }) {
    const thread = this.requireToken(tokenValue);
    const round = this.round(thread, n);
    if (round.state !== "open") throw new ConflictError(`Round ${n} was already submitted.`, { state: round.state });
    if (!draft || typeof draft !== "object") throw new InputError("draft must be an object");
    // Last write wins per question: a client sends only what it holds, merged over the stored draft.
    const merged = { ...(round.draft ?? {}), ...draft, answers: { ...(round.draft?.answers ?? {}), ...(draft.answers ?? {}) } };
    round.draft = merged;
    round.draftRev += 1;
    round.draftBy = client;
    this.save(thread);
    return { thread, round };
  }

  message(tokenValue, text) {
    const thread = this.requireToken(tokenValue);
    const body = String(text ?? "").trim();
    if (!body) throw new InputError("message is empty");
    this.reopen(thread, "page");
    const delivery = this.deliver(thread, { kind: "message", text: body });
    this.push(thread, { kind: "message", role: "composer", text: body, delivery: delivery.id });
    this.save(thread);
    return { thread, delivery };
  }

  end(tokenValue) {
    const thread = this.requireToken(tokenValue);
    if (thread.state === "closed") return { thread, delivery: null };
    this.setState(thread, "closed", "closed", { by: "page" });
    const delivery = this.deliver(thread, { kind: "end" });
    this.save(thread);
    return { thread, delivery };
  }

  // ---- views -------------------------------------------------------------------------

  /** The Thread as the page reads it: no tokens of other threads, no session ids. */
  view(thread) {
    return {
      id: thread.id,
      title: thread.title,
      project: thread.project,
      state: thread.state,
      rev: thread.rev,
      presence: { state: this.presenceOf(thread), chip: thread.presence.chip },
      items: thread.items.map((item) => {
        if (item.kind === "message" && item.delivery) {
          const d = thread.deliveries.find((x) => x.id === item.delivery);
          return { ...item, delivered: Boolean(d?.deliveredAt) };
        }
        return item;
      }),
      rounds: thread.rounds.map((r) => this.roundView(thread, r)),
    };
  }

  roundView(thread, round) {
    return {
      n: round.n,
      title: round.spec.title,
      state: round.state,
      version: round.version,
      total: round.spec.questions.length,
      sections: round.sections,
      submittedAt: round.submittedAt,
      lines: round.result ? summaryLines(round.result) : null,
    };
  }

  index() {
    return [...this.threads.values()]
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .map((t) => ({
        token: t.token,
        title: t.title,
        project: t.project,
        state: t.state,
        presence: this.presenceOf(t),
        waiting: Boolean(this.openRound(t)),
        rounds: t.rounds.length,
        lastActivity: t.lastActivity,
      }));
  }
}

/** One line per question of a submitted Round: `id -> answer`, as the card shows it collapsed. */
export function summaryLines(result) {
  return result.answers.map((a) => {
    let answer;
    if (a.status === "deferred") answer = "deferred";
    else if (a.status === "needs-info") answer = "needs more info";
    else if (a.status === "unanswered") answer = "unanswered";
    else if (a.rankedLabels) answer = a.rankedLabels.join(" > ");
    else answer = [...(a.selectedLabels ?? []), ...(a.other ? [`“${a.other}”`] : [])].join(" + ") || "answered";
    return { id: a.id, header: a.header, answer, status: a.status };
  });
}
