// Draws the Thread's items: Messages, tool chips, Round cards and dividers, keyed by seq so a redraw
// only touches what changed.
import { el, md, timeOf } from "./md.js";

const ROLE = { assistant: "Claude", user: "You · terminal", composer: "You · page" };

function message(item) {
  const who = el("div", { class: "t-who" }, ROLE[item.role] ?? item.role, el("span", { class: "t-time" }, timeOf(item.at)));
  const body = item.role === "assistant" ? md(item.text, "md t-text") : el("div", { class: "t-text t-plain" }, item.text);
  const mark = item.role === "composer" ? el("div", { class: `t-mark${item.delivered ? " is-done" : ""}` }, item.delivered ? "Delivered" : "Waiting for the session…") : null;
  return el("li", { class: `t-item t-msg t-${item.role}` }, who, body, mark);
}

function chips(items) {
  return el(
    "li",
    { class: "t-item t-chips" },
    items.map((item) => el("span", { class: "t-chip", title: timeOf(item.at) }, item.text)),
  );
}

function divider(item) {
  const by = item.by === "page" ? "from the page" : item.by === "model" ? "by Claude" : "";
  const text = item.label === "closed" ? `Thread closed ${by}` : `Thread reopened ${by}`;
  return el(
    "li",
    { class: `t-item t-divider is-${item.label}` },
    el("span", { class: "t-divider-text" }, text.trim(), el("span", { class: "t-time" }, timeOf(item.at))),
    item.summary ? md(item.summary, "md t-summary") : null,
  );
}

function roundCard(item, round, token) {
  const href = `/c/${token}/r/${round.n}`;
  if (round.state === "open") {
    return el(
      "li",
      { class: "t-item t-round is-open", "data-round": round.n },
      el(
        "div",
        { class: "t-round-head" },
        el("div", {}, el("div", { class: "eyebrow" }, `Round ${round.n} · waiting for you`), el("h2", { class: "t-round-title" }, round.title)),
        el("a", { class: "primary t-answer", href }, "Answer ", el("kbd", {}, "↵")),
      ),
      el("div", { class: "t-round-meta muted" }, `${round.total} question${round.total === 1 ? "" : "s"}`, round.sections.length ? ` · ${round.sections.length + 1} parts` : ""),
    );
  }
  const counts = round.lines ? round.lines.filter((l) => l.status === "answered").length : 0;
  return el(
    "li",
    { class: "t-item t-round is-done", "data-round": round.n },
    el(
      "details",
      {},
      el(
        "summary",
        {},
        el("span", { class: "t-round-check", "aria-hidden": "true" }, "✓"),
        el("span", { class: "t-round-title" }, `Round ${round.n} · ${round.title}`),
        el("span", { class: "muted t-round-count" }, `${counts} of ${round.total} answered`),
      ),
      el(
        "ul",
        { class: "t-lines" },
        (round.lines ?? []).map((l) => el("li", { class: `t-line is-${l.status}` }, el("span", { class: "t-line-q" }, l.header), el("span", { class: "t-line-a" }, l.answer))),
      ),
    ),
  );
}

/** Groups consecutive chips; returns [key, signature, node builder] per row. */
export function rows(view, token) {
  const out = [];
  const rounds = new Map(view.rounds.map((r) => [r.n, r]));
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const group = run;
    out.push({ key: `chips-${group[0].seq}`, sig: group.map((i) => i.seq).join(","), build: () => chips(group) });
    run = [];
  };
  for (const item of view.items) {
    if (item.kind === "chip") {
      run.push(item);
      continue;
    }
    flush();
    if (item.kind === "message") out.push({ key: `m-${item.seq}`, sig: `${item.delivered ?? ""}`, build: () => message(item) });
    else if (item.kind === "divider") out.push({ key: `d-${item.seq}`, sig: "", build: () => divider(item) });
    else if (item.kind === "round") {
      const round = rounds.get(item.n);
      if (round) out.push({ key: `r-${round.n}`, sig: `${round.state}:${round.version}:${round.total}`, build: () => roundCard(item, round, token) });
    }
  }
  flush();
  return out;
}

/** Reconciles the list with `next` rows: keeps unchanged nodes, replaces changed ones, appends new ones. */
export function reconcile(list, next) {
  const existing = new Map([...list.children].map((node) => [node.dataset.key, node]));
  const added = [];
  let previous = null;
  for (const row of next) {
    let node = existing.get(row.key);
    if (!node || node.dataset.sig !== row.sig) {
      const fresh = row.build();
      fresh.dataset.key = row.key;
      fresh.dataset.sig = row.sig;
      if (node) {
        // A submitted Round keeps its details open state across a redraw.
        node.replaceWith(fresh);
      } else added.push(fresh);
      node = fresh;
    }
    existing.delete(row.key);
    const after = previous ? previous.nextSibling : list.firstChild;
    if (node !== after) list.insertBefore(node, after);
    previous = node;
  }
  for (const stale of existing.values()) stale.remove();
  return added;
}
