// The root index: every live Thread, the ones waiting on you first.
import { el, themeToggle } from "./md.js";

themeToggle(document.querySelector("#theme"));
const list = document.querySelector("#threads");

const PRESENCE = { working: "Claude is working", waiting: "Waiting for you", idle: "Idle", "not-running": "Session not running" };

function ago(ms) {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

async function refresh() {
  try {
    const { threads } = await (await fetch("/api/threads", { cache: "no-store" })).json();
    const sorted = [...threads].sort((a, b) => Number(b.waiting) - Number(a.waiting) || b.lastActivity - a.lastActivity);
    const waiting = sorted.filter((t) => t.waiting).length;
    document.title = `${waiting ? `(${waiting}) ` : ""}Threads`;
    list.replaceChildren(
      ...(sorted.length
        ? sorted.map((t) =>
            el(
              "li",
              { class: `t-index-row${t.waiting ? " is-waiting" : ""}` },
              el(
                "a",
                { href: `/c/${t.token}` },
                el("span", { class: "t-index-title" }, t.title ?? "Thread"),
                el("span", { class: "t-index-meta muted" }, [t.project, `${t.rounds} round${t.rounds === 1 ? "" : "s"}`, t.state === "closed" ? "closed" : PRESENCE[t.presence], ago(t.lastActivity)].filter(Boolean).join(" · ")),
                t.waiting ? el("span", { class: "pill t-waiting" }, "Waiting for you") : null,
              ),
            ),
          )
        : [el("li", { class: "t-empty muted" }, "No Threads yet.")]),
    );
  } catch {
    list.replaceChildren(el("li", { class: "t-empty muted" }, "Lost contact with the ask-user-rich daemon; retrying…"));
  }
}

refresh();
setInterval(refresh, 4000);
