// The Thread page: one conversation's Rounds and messages, live.
import { composer } from "./composer.js";
import { follow } from "./live.js";
import { el, themeToggle } from "./md.js";
import { reconcile, rows } from "./stream.js";

const token = location.pathname.split("/")[2];
const api = `/api/c/${token}`;
const $ = (sel) => document.querySelector(sel);

const PRESENCE = {
  working: { text: "Claude is working", tone: "busy" },
  waiting: { text: "Waiting for you", tone: "wait" },
  idle: { text: "Idle", tone: "idle" },
  "not-running": { text: "Session not running · what you send is kept until it resumes", tone: "off" },
};

let view = null;
let fetching = null;
let again = false;

themeToggle($("#theme"));

function banner(text) {
  const node = $("#banner");
  node.textContent = text ?? "";
  node.hidden = !text;
}

function nearBottom() {
  return window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
}

function openRound() {
  return view?.rounds.find((r) => r.state === "open") ?? null;
}

function drawPresence() {
  const p = PRESENCE[view.presence.state] ?? PRESENCE.idle;
  const chip = view.presence.state === "working" && view.presence.chip ? el("span", { class: "t-chip" }, view.presence.chip) : null;
  $("#presence").replaceChildren(el("span", { class: `t-dot is-${p.tone}`, "aria-hidden": "true" }), el("span", {}, p.text), chip);
}

function draw(previousOpen) {
  const stick = nearBottom();
  document.title = `${openRound() ? "(1) " : ""}${view.title ?? "Thread"}`;
  $("#title").textContent = view.title ?? "Thread";
  $("#eyebrow").textContent = [view.project, view.state === "closed" ? "closed" : null].filter(Boolean).join(" · ") || "Thread";
  $("#end").disabled = view.state === "closed";
  drawPresence();
  const added = reconcile($("#stream"), rows(view, token));
  const open = openRound();
  if (open && open.n !== previousOpen) {
    const card = document.querySelector(`[data-round="${open.n}"]`);
    card?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  } else if (added.length && stick) {
    window.scrollTo({ top: document.body.scrollHeight });
  }
  if (!view.items.length) $("#stream").replaceChildren(el("li", { class: "t-empty muted" }, "Nothing here yet."));
}

async function refresh() {
  if (fetching) {
    again = true;
    return fetching;
  }
  fetching = (async () => {
    try {
      const response = await fetch(api, { cache: "no-store" });
      if (response.status === 404) return banner("This Thread is no longer on the server (Threads are kept 7 days after their last activity).");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const previousOpen = openRound()?.n ?? null;
      view = await response.json();
      banner("");
      draw(previousOpen);
    } catch {
      banner("Lost contact with the ask-user-rich daemon; retrying…");
    } finally {
      fetching = null;
      if (again) {
        again = false;
        refresh();
      }
    }
  })();
  return fetching;
}

async function post(path, body) {
  const response = await fetch(`${api}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

composer({
  form: $("#composer"),
  field: $("#message"),
  button: $("#send"),
  send: async (text) => {
    try {
      await post("/messages", { text });
      await refresh();
    } catch (error) {
      banner(`Could not send: ${error.message}`);
      throw error;
    }
  },
});

$("#end").addEventListener("click", async () => {
  if ($("#end").dataset.armed !== "1") {
    $("#end").dataset.armed = "1";
    $("#end").textContent = "End the Thread?";
    setTimeout(() => {
      $("#end").dataset.armed = "";
      $("#end").textContent = "End";
    }, 3000);
    return;
  }
  $("#end").dataset.armed = "";
  $("#end").textContent = "End";
  try {
    await post("/end", {});
    await refresh();
  } catch (error) {
    banner(`Could not end the Thread: ${error.message}`);
  }
});

// Enter, outside a field, opens the Round waiting for an answer.
document.addEventListener("keydown", (event) => {
  const tag = document.activeElement?.tagName;
  if (event.key !== "Enter" || event.ctrlKey || event.metaKey || tag === "TEXTAREA" || tag === "INPUT" || tag === "A" || tag === "BUTTON" || tag === "SUMMARY") return;
  const open = openRound();
  if (!open) return;
  event.preventDefault();
  location.assign(`/c/${token}/r/${open.n}`);
});

follow(token, (change) => {
  if (!change || !view || change.rev !== view.rev || change.presence !== view.presence.state || (change.chip ?? null) !== (view.presence.chip ?? null)) refresh();
});
refresh();
