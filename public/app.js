/* global marked, DOMPurify */
(() => {
  "use strict";

  const token = location.pathname.split("/").pop();
  const api = `/api/s/${token}`;
  const $ = (sel, root = document) => root.querySelector(sel);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });

  function md(text, className = "md") {
    const div = document.createElement("div");
    div.className = className;
    div.innerHTML = DOMPurify.sanitize(marked.parse(text ?? "", { gfm: true, breaks: false }));
    return div;
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const kbd = (key) => el("kbd", {}, key);

  /* Scroll following. Focus never scrolls natively (every focus() passes preventScroll); instead, focus that
     came from the keyboard glides into a comfort band between the sticky header and the fixed footer. */
  let lastInput = "keyboard";
  let followSuppressed = 0;
  let pendingScrollTop = null; // target of an in-flight smooth scroll, so rapid key presses chain instead of undershooting
  document.addEventListener("keydown", () => (lastInput = "keyboard"), true);
  document.addEventListener("pointerdown", () => (lastInput = "pointer"), true);
  window.addEventListener("scrollend", () => (pendingScrollTop = null));
  window.addEventListener("wheel", () => (pendingScrollTop = null), { passive: true });

  function visibleBand() {
    const top = $(".top").getBoundingClientRect().bottom;
    const bottom = $("#bottom").hidden ? innerHeight : $("#bottom").getBoundingClientRect().top;
    return { top, bottom, height: bottom - top };
  }

  function scrollToY(y, { smooth = true } = {}) {
    const max = document.documentElement.scrollHeight - innerHeight;
    const target = Math.max(0, Math.min(max, Math.round(y)));
    if (Math.abs(target - (pendingScrollTop ?? scrollY)) < 2) return;
    const behavior = smooth && !reduceMotion.matches ? "smooth" : "instant";
    pendingScrollTop = behavior === "smooth" ? target : null;
    window.scrollTo({ top: target, behavior });
  }

  /**
   * comfort: keep the element inside the middle half of the visible band (the page follows along as you move).
   * nearest: only scroll when it would leave the band (used while a textarea grows under the caret).
   */
  function follow(node, { mode = "comfort" } = {}) {
    if (!node?.getBoundingClientRect) return;
    const band = visibleBand();
    const base = pendingScrollTop ?? scrollY;
    const rect = node.getBoundingClientRect();
    const top = rect.top + scrollY - base; // where the element will sit once the pending scroll lands
    const bottom = top + rect.height;
    const margin = 16;
    let delta = 0;
    if (mode === "nearest") {
      if (top < band.top + margin) delta = top - (band.top + margin);
      else if (bottom > band.bottom - margin) delta = bottom - (band.bottom - margin);
    } else if (rect.height > band.height * 0.5) {
      delta = top - (band.top + band.height * 0.12); // tall option (big preview): pin its top near the header
    } else {
      const lo = band.top + band.height * 0.25;
      const hi = band.top + band.height * 0.75;
      if (top < lo) delta = top - lo;
      else if (bottom > hi) delta = bottom - hi;
    }
    if (delta) scrollToY(base + delta);
  }

  function quietly(fn) {
    followSuppressed += 1;
    try {
      return fn();
    } finally {
      followSuppressed -= 1;
    }
  }

  document.addEventListener("focusin", (event) => {
    if (followSuppressed || lastInput !== "keyboard" || !(event.target instanceof HTMLElement)) return;
    if (event.target.closest("#steps")) follow(event.target);
  });

  function autogrow(textarea) {
    const grow = () => {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight + 2, 480)}px`;
      if (document.activeElement === textarea && !followSuppressed) follow(textarea, { mode: "nearest" });
    };
    textarea.addEventListener("input", grow);
    textarea.grow = grow;
    requestAnimationFrame(grow);
  }

  /* Theme */
  const themeButton = $("#theme");
  function applyTheme(theme) {
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    themeButton.textContent = `Theme: ${theme}`;
  }
  let theme = localStorage.getItem("aur:theme") || "auto";
  applyTheme(theme);
  themeButton.addEventListener("click", () => {
    theme = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
    localStorage.setItem("aur:theme", theme);
    applyTheme(theme);
  });

  /* State */
  let spec = null;
  let sessionId = null;
  let finished = false;
  const state = {}; // question id -> { mode, selected: Set, otherOn, other, notes }
  const views = {}; // question id -> question view (see renderQuestion)
  let steps = []; // { kind: "intro" | "q" | "review", el, chip, q?, index? }
  let current = 0;
  let generalNotes = null;
  const draftKey = () => `aur:draft:${sessionId}`;

  const STATUS_TEXT = {
    unanswered: "Not answered yet",
    answered: "Answered",
    deferred: "Deferred",
    "needs-info": "Needs more info",
  };

  function statusOf(q) {
    const s = state[q.id];
    if (s.mode === "defer") return "deferred";
    if (s.mode === "needs-info") return "needs-info";
    if (q.kind === "rank") return s.ranked ? "answered" : "unanswered";
    return s.selected.size > 0 || (s.otherOn && s.other.trim()) ? "answered" : "unanswered";
  }

  function answerText(q) {
    const status = statusOf(q);
    if (status !== "answered") return status === "unanswered" ? "Not answered" : STATUS_TEXT[status];
    const s = state[q.id];
    if (q.kind === "rank") return s.ranked.map((id) => q.options.find((o) => o.id === id).label).join(" > ");
    const parts = q.options.filter((o) => s.selected.has(o.id)).map((o) => o.label);
    if (s.otherOn && s.other.trim()) parts.push(q.options.length ? `Other: “${s.other.trim()}”` : `“${s.other.trim()}”`);
    return parts.join(" + ");
  }

  function saveDraft() {
    if (!sessionId || finished) return;
    const draft = { step: current, generalNotes: generalNotes?.value ?? "", answers: {} };
    for (const [id, s] of Object.entries(state)) {
      draft.answers[id] = { mode: s.mode, selected: [...s.selected], otherOn: s.otherOn, other: s.other, notes: s.notes, order: s.order, ranked: s.ranked };
    }
    try {
      localStorage.setItem(draftKey(), JSON.stringify(draft));
    } catch {}
  }

  function loadDraft() {
    try {
      return JSON.parse(localStorage.getItem(draftKey()) || "null");
    } catch {
      return null;
    }
  }

  function refreshSummary() {
    const statuses = spec.questions.map(statusOf);
    const resolved = statuses.filter((s) => s !== "unanswered").length;
    const total = spec.questions.length;
    $("#progress").textContent = `${resolved} / ${total} resolved`;
    $("#bar-fill").style.width = `${(resolved / total) * 100}%`;
    const count = (s) => statuses.filter((x) => x === s).length;
    const parts = [`${count("answered")} answered`];
    if (count("deferred")) parts.push(`${count("deferred")} deferred`);
    if (count("needs-info")) parts.push(`${count("needs-info")} need info`);
    if (count("unanswered")) parts.push(`${count("unanswered")} open`);
    $("#footer-status").textContent = parts.join(" · ");
    for (const step of steps) {
      if (step.kind !== "q") continue;
      const status = statuses[step.index];
      step.chip.dataset.status = status;
      step.chip.title = `${step.index + 1}. ${step.q.header} (${STATUS_TEXT[status].toLowerCase()})`;
    }
    resetSubmitConfirm();
    if (steps[current]?.kind === "review" || view === "all") renderReview();
  }

  function changed(q) {
    views[q.id].sync();
    refreshSummary();
    saveDraft();
  }

  /* The parts every question screen shares: meta line, header, context, recommendation, mode switch, note. */
  function questionFrame(q, index, { kind, recText, content, clearButton }) {
    const s = state[q.id];
    const notes = el("textarea", { rows: 1, id: `notes-${index}`, "aria-label": `${q.header}: notes` });
    notes.value = s.notes;
    autogrow(notes);
    notes.addEventListener("input", () => {
      s.notes = notes.value;
      saveDraft();
    });

    const setMode = (mode) => {
      s.mode = mode;
      changed(q);
      if (mode === "needs-info") notes.focus({ preventScroll: true });
    };
    const modeButtons = [
      ["answer", "Answer", null],
      ["defer", "Defer", "D"],
      ["needs-info", "Need more info", "I"],
    ].map(([mode, label, key]) =>
      el("button", { type: "button", "data-mode": mode, onclick: () => setMode(mode) }, label, key ? kbd(key) : null),
    );

    const pill = el("span", { class: "pill" });
    const total = el("span", {});
    const setTotal = (n) => (total.textContent = `Question ${index + 1} of ${n}`);
    setTotal(spec.questions.length);
    const deps = (q.dependsOn ?? []).map((depId) => {
      const depIndex = spec.questions.findIndex((x) => x.id === depId);
      return el(
        "button",
        { type: "button", onclick: () => go(stepIndexOfQuestion(depIndex)) },
        `#${depIndex + 1} ${spec.questions[depIndex].header}`,
      );
    });

    const card = el(
      "article",
      { class: "card q" },
      el("div", { class: "q-meta" }, total, el("span", { class: "sep" }, "·"), el("span", {}, kind), pill),
      el("h2", { id: `q-title-${index}` }, q.header),
      deps.length ? el("div", { class: "deps" }, "Builds on ", deps.flatMap((a, i) => (i ? [", ", a] : [a]))) : null,
      q.body ? md(q.body, "md body") : null,
      recText || q.rationale
        ? el(
            "div",
            { class: "rec" },
            el("div", { class: "rec-title" }, recText ?? "Claude's view", recText ? el("span", { class: "take" }, "take it with", kbd("R")) : null),
            q.rationale ? md(q.rationale) : null,
          )
        : null,
      content,
      el("div", { class: "q-foot" }, el("div", { class: "seg", role: "group", "aria-label": "Answer mode" }, modeButtons), clearButton),
      el("div", { class: "notes-field" }, el("label", { class: "field-label", for: `notes-${index}` }, "Note for Claude", kbd("N")), notes),
    );

    const sync = () => {
      for (const button of modeButtons) button.setAttribute("aria-pressed", String(button.dataset.mode === s.mode));
      card.dataset.mode = s.mode;
      notes.placeholder =
        s.mode === "needs-info"
          ? "What do you need to know before deciding?"
          : s.mode === "defer"
            ? "Why defer, or when to come back to it (optional)"
            : "Anything Claude should know about this answer (optional)";
      const status = statusOf(q);
      pill.dataset.status = status;
      pill.textContent = STATUS_TEXT[status];
    };
    return { card, notes, setMode, sync, setTotal };
  }

  /* Rank screens: the user orders every option. Nothing is recorded until they move something or confirm. */
  function renderRank(q, index) {
    const s = state[q.id];
    const byId = new Map(q.options.map((o) => [o.id, o]));
    const recOrder = Array.isArray(q.recommended) ? q.recommended : null;
    const rows = new Map();
    const live = el("div", { class: "sr-only", "aria-live": "assertive" });
    const announce = (text) => (live.textContent = text);
    let grabbed = null; // { id, order, ranked } while a row is picked up from the keyboard
    let pivot = null; // the row that stays put in the DOM during the next reorder, so it keeps focus and pointer capture

    const list = el("ol", { class: "rank-list", "aria-labelledby": `q-title-${index}` });
    for (const option of q.options) {
      const row = el(
        "li",
        { class: "rank-row", tabindex: "-1", "data-id": option.id, "aria-roledescription": "sortable item" },
        el("span", { class: "rank-pos", "aria-hidden": "true" }),
        el("span", { class: "grip", "aria-hidden": "true" }, Array.from({ length: 6 }, () => el("i"))),
        el(
          "div",
          { class: "opt-main" },
          el("div", { class: "opt-label" }, option.label),
          option.description ? md(option.description, "md opt-desc") : null,
          option.preview ? md(option.preview, "md preview") : null,
        ),
      );
      row.addEventListener("focus", () => setRoving(option.id));
      row.addEventListener("pointerdown", (event) => startDrag(event, option.id));
      rows.set(option.id, row);
      list.append(row);
    }

    let roving = s.order[0];
    const setRoving = (id) => {
      roving = id;
      for (const [rid, row] of rows) row.setAttribute("tabindex", rid === id ? "0" : "-1");
    };

    // FLIP: measure, rearrange the other rows around the pivot, then play every row from where it was.
    const reconcile = ({ animate = true, skip = null } = {}) => {
      const domOrder = [...list.children].map((n) => n.dataset.id);
      if (domOrder.join("\n") !== s.order.join("\n")) {
        const first = new Map([...rows].map(([id, row]) => [id, row.getBoundingClientRect().top]));
        const anchor = rows.has(pivot) ? pivot : document.activeElement?.dataset?.id && rows.has(document.activeElement.dataset.id) ? document.activeElement.dataset.id : s.order[0];
        const anchorRow = rows.get(anchor);
        const at = s.order.indexOf(anchor);
        for (const id of s.order.slice(0, at)) list.insertBefore(rows.get(id), anchorRow);
        for (const id of s.order.slice(at + 1)) list.append(rows.get(id));
        if (animate && !reduceMotion.matches) {
          for (const [id, row] of rows) {
            if (id === skip) continue;
            const dy = first.get(id) - row.getBoundingClientRect().top;
            if (Math.abs(dy) > 0.5) {
              row.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 240, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
            }
          }
        }
      }
      pivot = null;
      s.order.forEach((id, i) => {
        const row = rows.get(id);
        row.querySelector(".rank-pos").textContent = i + 1;
        row.setAttribute("aria-label", `${byId.get(id).label}, position ${i + 1} of ${s.order.length}`);
      });
    };

    const commit = () => {
      s.ranked = [...s.order];
      s.mode = "answer";
      changed(q);
    };

    const moveTo = (id, to) => {
      const from = s.order.indexOf(id);
      to = Math.max(0, Math.min(s.order.length - 1, to));
      if (from === to) return false;
      const order = [...s.order];
      order.splice(from, 1);
      order.splice(to, 0, id);
      s.order = order;
      pivot = id;
      announce(`${byId.get(id).label}: position ${to + 1} of ${order.length}`);
      if (grabbed) reconcile();
      else commit();
      rows.get(id).focus({ preventScroll: true });
      follow(rows.get(id));
      return true;
    };

    const drop = () => {
      if (!grabbed) return false;
      rows.get(grabbed.id).classList.remove("is-grabbed");
      announce(`Dropped ${byId.get(grabbed.id).label} at position ${s.order.indexOf(grabbed.id) + 1}`);
      grabbed = null;
      commit();
      return true;
    };
    const cancelGrab = () => {
      if (!grabbed) return false;
      rows.get(grabbed.id).classList.remove("is-grabbed");
      s.order = grabbed.order;
      s.ranked = grabbed.ranked;
      pivot = grabbed.id;
      announce(`Cancelled; ${byId.get(grabbed.id).label} is back at position ${s.order.indexOf(grabbed.id) + 1}`);
      grabbed = null;
      changed(q);
      return true;
    };
    list.addEventListener("focusout", (event) => {
      if (grabbed && !list.contains(event.relatedTarget)) drop();
    });

    function startDrag(event, id) {
      if (event.button !== 0 || event.target.closest(".preview, a")) return;
      if (grabbed) drop();
      const row = rows.get(id);
      event.preventDefault();
      row.focus({ preventScroll: true });
      row.setPointerCapture(event.pointerId);
      const startY = event.clientY;
      const grabOffset = event.clientY - row.getBoundingClientRect().top;
      const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
      let moved = false;
      const onMove = (ev) => {
        if (!moved && Math.abs(ev.clientY - startY) < 4) return;
        if (!moved) {
          moved = true;
          row.classList.add("is-dragging");
        }
        // Slot the row where its centre falls among the others, measured without it.
        const listTop = list.getBoundingClientRect().top;
        const centre = ev.clientY - listTop - grabOffset + row.offsetHeight / 2;
        const others = s.order.filter((x) => x !== id);
        let y = 0;
        let target = 0;
        for (const other of others) {
          const h = rows.get(other).offsetHeight;
          if (centre > y + h / 2) target += 1;
          y += h + gap;
        }
        if (target !== s.order.indexOf(id)) {
          others.splice(target, 0, id);
          s.order = others;
          pivot = id;
          reconcile({ skip: id });
        }
        // What the pointer holds is exactly the pointer: offset from the row's slot, not from where it started.
        row.style.transform = `translateY(${ev.clientY - listTop - grabOffset - row.offsetTop}px)`;
      };
      const onUp = () => {
        row.removeEventListener("pointermove", onMove);
        row.removeEventListener("pointerup", onUp);
        row.removeEventListener("pointercancel", onUp);
        if (!moved) return;
        const settle = row.style.transform;
        row.style.transform = "";
        row.classList.remove("is-dragging");
        if (!reduceMotion.matches) {
          row.animate([{ transform: settle }, { transform: "none" }], { duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
        }
        announce(`${byId.get(id).label}: position ${s.order.indexOf(id) + 1} of ${s.order.length}`);
        commit();
      };
      row.addEventListener("pointermove", onMove);
      row.addEventListener("pointerup", onUp);
      row.addEventListener("pointercancel", onUp);
    }

    const applyRec = () => {
      if (!recOrder) return false;
      s.order = [...recOrder];
      commit();
      return true;
    };
    const clear = () => {
      if (grabbed) cancelGrab();
      s.order = q.options.map((o) => o.id);
      s.ranked = null;
      if (s.mode !== "answer") s.mode = "answer";
      changed(q);
    };
    const confirmButton = el("button", { type: "button", class: "ghost keep-order", onclick: () => commit() }, "Keep this order", kbd("C"));
    const clearButton = el("button", { type: "button", class: "linkish", onclick: clear }, "Reset order", kbd("X"));

    const frame = questionFrame(q, index, {
      kind: "Rank all",
      recText: recOrder ? `Recommended order: ${recOrder.map((id) => byId.get(id).label).join(" > ")}` : null,
      clearButton,
      content: el(
        "div",
        { class: "rank" },
        el("div", { class: "rank-hint" }, "Drag to reorder, or ", kbd("Space"), " to pick up, ", kbd("↑"), kbd("↓"), " to move, ", kbd("Space"), " to drop. ", kbd("Shift"), "+", kbd("↑"), kbd("↓"), " moves directly; ", kbd("1"), "–", kbd("9"), " sends it to that place."),
        list,
        confirmButton,
        live,
      ),
    });
    const { card, notes, setMode } = frame;

    const sync = () => {
      reconcile();
      card.classList.toggle("is-ranked", Boolean(s.ranked));
      confirmButton.hidden = Boolean(s.ranked) || s.mode !== "answer";
      clearButton.hidden = !s.ranked && s.order.join() === q.options.map((o) => o.id).join();
      frame.sync();
    };

    const focusedId = () => (rows.has(document.activeElement?.dataset?.id) ? document.activeElement.dataset.id : null);
    views[q.id] = {
      root: card,
      sync,
      setMode,
      clear,
      applyRec,
      setTotal: frame.setTotal,
      chooseOther: () => {},
      focusNotes: () => notes.focus({ preventScroll: true }),
      confirmOrder: () => (commit(), true),
      cancelGrab,
      isGrabbing: () => Boolean(grabbed),
      drop,
      chooseIndex(i) {
        const id = focusedId() ?? roving;
        moveTo(id, i);
      },
      shiftMove(delta) {
        const id = focusedId() ?? roving;
        return moveTo(id, s.order.indexOf(id) + delta);
      },
      move(delta) {
        if (grabbed) return void moveTo(grabbed.id, s.order.indexOf(grabbed.id) + delta);
        const at = s.order.indexOf(focusedId() ?? roving);
        const next = s.order[Math.max(0, Math.min(s.order.length - 1, focusedId() ? at + delta : at))];
        setRoving(next);
        rows.get(next).focus({ preventScroll: true });
      },
      toggleFocused() {
        const id = focusedId();
        if (!id) return false;
        if (grabbed) return drop();
        grabbed = { id, order: [...s.order], ranked: s.ranked ? [...s.ranked] : null };
        rows.get(id).classList.add("is-grabbed");
        announce(`Picked up ${byId.get(id).label}, position ${s.order.indexOf(id) + 1}. Arrow keys move it, Space drops it, Escape cancels.`);
        return true;
      },
      confirmFocused() {},
      focusPrimary() {
        setRoving(rows.has(roving) ? roving : s.order[0]);
        rows.get(roving).focus({ preventScroll: true });
      },
    };
    setRoving(s.order[0]);
    return card;
  }

  /* Question screens */
  function renderQuestion(q, index) {
    const s = state[q.id];
    const recs = new Set(q.recommended === undefined ? [] : [].concat(q.recommended));
    const freeOnly = q.options.length === 0;
    const role = q.multiSelect ? "checkbox" : "radio";
    const optionRows = [];

    const choose = (optionId) => {
      if (q.multiSelect) {
        if (s.selected.has(optionId)) s.selected.delete(optionId);
        else s.selected.add(optionId);
      } else {
        s.selected = new Set([optionId]);
        s.otherOn = false;
      }
      s.mode = "answer";
      changed(q);
    };

    q.options.forEach((option, i) => {
      const row = el(
        "div",
        { class: `opt${recs.has(option.id) ? " is-rec" : ""}`, role, tabindex: "-1", "aria-checked": "false" },
        el("span", { class: `ind ${q.multiSelect ? "check" : "radio"}`, "aria-hidden": "true" }),
        el(
          "div",
          { class: "opt-main" },
          el("div", { class: "opt-label" }, option.label, recs.has(option.id) ? el("span", { class: "badge" }, "Recommended") : null),
          option.description ? md(option.description, "md opt-desc") : null,
          option.preview ? md(option.preview, "md preview") : null,
        ),
        i < 9 ? el("kbd", { "aria-hidden": "true" }, i + 1) : el("span"),
      );
      row.addEventListener("click", (event) => {
        // Selecting text or scrolling inside a preview should not flip the answer.
        if (event.target.closest(".preview") && getSelection().toString()) return;
        choose(option.id);
      });
      optionRows.push({ option, row });
    });

    let otherText = null;
    let otherRow = null;
    const chooseOther = ({ focusText = true } = {}) => {
      if (q.multiSelect && s.otherOn && !focusText) s.otherOn = false;
      else {
        s.otherOn = true;
        if (!q.multiSelect) s.selected.clear();
      }
      s.mode = "answer";
      changed(q);
      if (s.otherOn && focusText) otherText.focus({ preventScroll: true });
    };
    if (q.allowOther) {
      otherText = el("textarea", {
        rows: freeOnly ? 4 : 1,
        placeholder: freeOnly ? "Your answer" : "Describe your own answer",
        "aria-label": `${q.header}: ${freeOnly ? "answer" : "other answer"}`,
      });
      otherText.value = s.other;
      autogrow(otherText);
      otherText.addEventListener("input", () => {
        s.other = otherText.value;
        const on = s.other.trim() !== "";
        if (freeOnly) s.otherOn = on;
        else if (on && !s.otherOn) {
          s.otherOn = true;
          if (!q.multiSelect) s.selected.clear();
        }
        if (on) s.mode = "answer";
        changed(q);
      });
      if (freeOnly) {
        otherRow = el("div", { class: "free" }, otherText);
      } else {
        otherRow = el(
          "div",
          { class: "opt other", role, tabindex: "-1", "aria-checked": "false" },
          el("span", { class: `ind ${q.multiSelect ? "check" : "radio"}`, "aria-hidden": "true" }),
          el("div", { class: "opt-main" }, el("div", { class: "opt-label" }, "Other"), otherText),
          el("kbd", { "aria-hidden": "true" }, "O"),
        );
        otherRow.addEventListener("click", (event) => {
          if (event.target === otherText) {
            if (!s.otherOn) chooseOther();
            return;
          }
          chooseOther({ focusText: !s.otherOn });
        });
      }
    }

    // Roving tabindex: the option list is one Tab stop; arrows move inside it.
    const focusables = [...optionRows.map((r) => r.row), ...(otherRow && !freeOnly ? [otherRow] : [])];
    let roving = 0;
    const setRoving = (i) => {
      roving = Math.max(0, Math.min(focusables.length - 1, i));
      focusables.forEach((node, j) => node.setAttribute("tabindex", j === roving ? "0" : "-1"));
    };
    focusables.forEach((node, i) => node.addEventListener("focus", () => setRoving(i)));
    const selectedIndex = () => {
      const i = optionRows.findIndex((r) => s.selected.has(r.option.id));
      if (i >= 0) return i;
      return s.otherOn && otherRow && !freeOnly ? focusables.length - 1 : 0;
    };

    const clear = () => {
      s.selected.clear();
      s.otherOn = false;
      s.other = "";
      if (otherText) {
        otherText.value = "";
        otherText.grow();
      }
      if (s.mode !== "answer") s.mode = "answer";
      changed(q);
    };
    const clearButton = el("button", { type: "button", class: "linkish", onclick: clear }, "Clear answer", kbd("X"));

    const applyRec = () => {
      if (!recs.size) return false;
      s.selected = new Set(recs);
      s.otherOn = false;
      s.mode = "answer";
      changed(q);
      return true;
    };

    const recLabels = q.options.filter((o) => recs.has(o.id)).map((o) => o.label);
    const frame = questionFrame(q, index, {
      kind: freeOnly ? "Free text" : q.multiSelect ? "Pick any" : "Pick one",
      recText: recLabels.length ? `Recommended: ${recLabels.join(" + ")}` : null,
      clearButton,
      content: el(
        "div",
        { class: "options", role: freeOnly ? null : q.multiSelect ? "group" : "radiogroup", "aria-labelledby": `q-title-${index}` },
        optionRows.map((r) => r.row),
        otherRow,
      ),
    });
    const { card, notes, setMode } = frame;

    const sync = () => {
      for (const { option, row } of optionRows) {
        const on = s.selected.has(option.id);
        row.setAttribute("aria-checked", String(on));
        row.classList.toggle("is-selected", on);
      }
      if (otherRow && !freeOnly) {
        otherRow.setAttribute("aria-checked", String(s.otherOn));
        otherRow.classList.toggle("is-selected", s.otherOn);
      }
      clearButton.hidden = !(s.selected.size || s.otherOn || s.other);
      frame.sync();
    };

    views[q.id] = {
      root: card,
      sync,
      setMode,
      clear,
      applyRec,
      setTotal: frame.setTotal,
      chooseOther: () => (otherText ? chooseOther() : undefined),
      focusNotes: () => notes.focus({ preventScroll: true }),
      chooseIndex(i) {
        if (i < optionRows.length) {
          choose(optionRows[i].option.id);
          optionRows[i].row.focus({ preventScroll: true });
        }
      },
      move(delta) {
        if (!focusables.length) return;
        const at = focusables.indexOf(document.activeElement);
        const from = at >= 0 ? at : delta > 0 ? roving - 1 : roving + 1;
        setRoving(from + delta);
        focusables[roving].focus({ preventScroll: true });
      },
      toggleFocused() {
        const at = focusables.indexOf(document.activeElement);
        if (at < 0) return false;
        if (at < optionRows.length) choose(optionRows[at].option.id);
        else chooseOther({ focusText: !s.otherOn });
        return true;
      },
      // Enter on a single-choice question with nothing chosen picks the focused option before advancing.
      confirmFocused() {
        if (q.multiSelect || statusOf(q) !== "unanswered") return;
        const at = focusables.indexOf(document.activeElement);
        if (at >= 0 && at < optionRows.length) choose(optionRows[at].option.id);
      },
      focusPrimary() {
        if (freeOnly && otherText) return otherText.focus({ preventScroll: true });
        setRoving(selectedIndex());
        focusables[roving]?.focus({ preventScroll: true });
      },
    };
    setRoving(selectedIndex());
    return card;
  }

  /* Intro and review screens */
  function renderIntro() {
    return el(
      "article",
      { class: "card intro-card" },
      md(spec.intro),
      el(
        "div",
        { class: "start-hint" },
        `${spec.questions.length} question${spec.questions.length === 1 ? "" : "s"}, one per screen. Press`,
        kbd("Enter"),
        "to start, or",
        kbd("?"),
        "for every shortcut.",
      ),
    );
  }

  let reviewList = null;
  let reviewCounts = null;
  let acceptAllButton = null;
  function buildReview() {
    reviewList = el("ol", { class: "review-list" });
    reviewCounts = el("div", { class: "review-counts" });
    acceptAllButton = el("button", { type: "button", class: "ghost", onclick: acceptAll }, "Accept every recommendation on unanswered questions ", kbd("A"));
    generalNotes = el("textarea", { id: "general-notes", rows: 2, placeholder: "Optional notes about the interview as a whole" });
    autogrow(generalNotes);
    generalNotes.addEventListener("input", saveDraft);
    return el(
      "article",
      { class: "card review" },
      el("h2", {}, "Review your answers"),
      reviewCounts,
      el("div", { class: "review-tools" }, acceptAllButton),
      reviewList,
      el("div", { class: "general" }, el("label", { class: "field-label", for: "general-notes" }, "Anything else Claude should know?"), generalNotes),
    );
  }

  function renderReview() {
    const statuses = spec.questions.map(statusOf);
    const open = statuses.filter((s) => s === "unanswered").length;
    reviewCounts.textContent =
      open === 0 ? "Every question is resolved. Submit when ready." : `${open} question${open === 1 ? " is" : "s are"} still open. Click one to go back to it.`;
    acceptAllButton.hidden = !spec.questions.some((q, i) => q.recommended !== undefined && statuses[i] === "unanswered");
    reviewList.replaceChildren(
      ...spec.questions.map((q, i) => {
        const notes = state[q.id].notes.trim();
        return el(
          "li",
          {},
          el(
            "button",
            { type: "button", class: "review-row", onclick: () => go(stepIndexOfQuestion(i)) },
            el("span", { class: "chip", "data-status": statuses[i], "aria-hidden": "true" }, i + 1),
            el(
              "div",
              {},
              el("div", { class: "review-q" }, q.header),
              el("div", { class: "review-a", "data-status": statuses[i] }, answerText(q)),
              notes ? el("div", { class: "review-note" }, `Note: ${notes.length > 160 ? `${notes.slice(0, 159)}…` : notes}`) : null,
            ),
          ),
        );
      }),
    );
  }

  function acceptAll() {
    for (const q of spec.questions) {
      if (q.recommended === undefined || statusOf(q) !== "unanswered") continue;
      state[q.id].selected = new Set([].concat(q.recommended));
      state[q.id].otherOn = false;
      state[q.id].mode = "answer";
      views[q.id].sync();
    }
    refreshSummary();
    saveDraft();
  }

  /* Step engine */
  const stepIndexOfQuestion = (qIndex) => steps.findIndex((s) => s.kind === "q" && s.index === qIndex);
  const prevButton = $("#prev");
  const nextButton = $("#next");

  function focusStep() {
    const step = steps[current];
    if (step.kind === "q") views[step.q.id].focusPrimary();
    else if (step.kind === "review") nextButton.focus({ preventScroll: true });
    else step.el.focus({ preventScroll: true });
  }

  function updateNav() {
    const step = steps[current];
    steps.forEach((s, i) => (i === current ? s.chip.setAttribute("aria-current", "step") : s.chip.removeAttribute("aria-current")));
    step.chip.classList.remove("is-new");
    prevButton.disabled = current === 0;
    resetSubmitConfirm();
    document.title = step.kind === "q" ? `${step.index + 1}/${spec.questions.length} · ${spec.title}` : spec.title;
  }

  /* View: "stepper" shows one screen at a time; "all" stacks every screen and scrolls between them. */
  const viewButton = $("#view");
  let view = localStorage.getItem("aur:view") === "all" ? "all" : "stepper";
  let spyPaused = false;
  let spyTimer = null;
  const growAll = (root) => quietly(() => root.querySelectorAll("textarea").forEach((t) => t.grow?.()));
  // Where the window must scroll for a screen's top to sit just under the sticky header.
  const stepScrollY = (step) => step.el.getBoundingClientRect().top + scrollY - visibleBand().top - 14;

  function pauseSpy() {
    spyPaused = true;
    clearTimeout(spyTimer);
    spyTimer = setTimeout(() => (spyPaused = false), 1500); // no scrollend fires when the scroll was a no-op
  }
  window.addEventListener("scrollend", () => {
    spyPaused = false;
    clearTimeout(spyTimer);
  });

  function applyView() {
    document.body.dataset.view = view;
    viewButton.replaceChildren(view === "all" ? "One by one" : "Show all", kbd("V"));
    viewButton.setAttribute("aria-pressed", String(view === "all"));
    steps.forEach((s, i) => {
      s.el.hidden = view === "stepper" && i !== current;
      s.el.classList.remove("enter-fwd", "enter-back");
    });
    growAll($("#steps"));
    if (view === "all") {
      renderReview();
      pauseSpy();
      scrollToY(stepScrollY(steps[current]), { smooth: false });
    } else scrollToY(0, { smooth: false });
    updateNav();
  }

  function toggleView() {
    view = view === "all" ? "stepper" : "all";
    try {
      localStorage.setItem("aur:view", view);
    } catch {}
    applyView();
    quietly(focusStep);
  }
  viewButton.addEventListener("click", toggleView);

  let spyFrame = 0;
  window.addEventListener(
    "scroll",
    () => {
      if (view !== "all" || spyPaused || finished || !steps.length || spyFrame) return;
      spyFrame = requestAnimationFrame(() => {
        spyFrame = 0;
        const band = visibleBand();
        const line = band.top + band.height * 0.3;
        let index = 0;
        steps.forEach((s, i) => {
          if (s.el.getBoundingClientRect().top <= line) index = i;
        });
        if (innerHeight + scrollY >= document.documentElement.scrollHeight - 2) index = steps.length - 1;
        if (index !== current) {
          current = index;
          updateNav();
          saveDraft();
        }
      });
    },
    { passive: true },
  );
  // In the stacked view, clicking or tabbing into another screen makes it the current one.
  document.addEventListener("focusin", (event) => {
    if (view !== "all" || !(event.target instanceof Node)) return;
    const index = steps.findIndex((s) => s.el.contains(event.target));
    if (index >= 0 && index !== current) {
      current = index;
      updateNav();
      saveDraft();
    }
  });

  function go(to, { animate = true, focus = true } = {}) {
    to = Math.max(0, Math.min(steps.length - 1, to));
    if (view === "all") {
      current = to;
      pauseSpy();
      scrollToY(stepScrollY(steps[to]), { smooth: animate });
      updateNav();
      if (focus) quietly(focusStep);
      saveDraft();
      return;
    }
    if (to === current && steps[to].el.hidden === false) {
      if (focus) quietly(focusStep);
      return;
    }
    const from = steps[current];
    const dir = to > current ? "fwd" : "back";
    from.el.hidden = true;
    from.el.classList.remove("enter-fwd", "enter-back");
    current = to;
    const step = steps[current];
    if (step.kind === "review") renderReview();
    step.el.hidden = false;
    step.el.classList.remove("enter-fwd", "enter-back");
    if (animate && !reduceMotion.matches) {
      void step.el.offsetWidth; // restart the animation when re-entering the same screen
      step.el.classList.add(`enter-${dir}`);
    }
    // Textareas measured while hidden report 0 height.
    growAll(step.el);
    // A new screen starts at the top at once; only then does the focused option glide into the comfort band.
    scrollToY(0, { smooth: false });
    updateNav();
    if (focus) {
      quietly(focusStep);
      if (lastInput === "keyboard" && step.kind === "q") follow(document.activeElement);
    }
    saveDraft();
  }

  const next = () => go(current + 1);
  const prev = () => go(current - 1);
  prevButton.addEventListener("click", prev);
  nextButton.addEventListener("click", () => (steps[current].kind === "review" ? submit() : next()));

  function initState(q, d) {
    const ids = q.options.map((o) => o.id);
    const isPermutation = (list) => Array.isArray(list) && list.length === ids.length && ids.every((id) => list.includes(id));
    state[q.id] = {
      mode: d?.mode ?? "answer",
      selected: new Set((d?.selected ?? []).filter((id) => ids.includes(id))),
      otherOn: Boolean(d?.otherOn),
      other: d?.other ?? "",
      notes: d?.notes ?? "",
      order: isPermutation(d?.order) ? [...d.order] : ids,
      ranked: isPermutation(d?.ranked) ? [...d.ranked] : null,
    };
  }

  const renderStep = (q, index) => (q.kind === "rank" ? renderRank(q, index) : renderQuestion(q, index));

  // Creates the screen element and its rail chip, placed before `before` (a step) or at the end.
  function mountStep(step, before = null) {
    step.el = el("section", { class: "step", tabindex: "-1", hidden: true }, step.body);
    $("#steps").insertBefore(step.el, before?.el ?? null);
    const label = step.kind === "intro" ? "Intro" : step.kind === "review" ? "Review" : String(step.index + 1);
    step.chip = el(
      "button",
      {
        type: "button",
        class: `chip${step.kind === "q" ? "" : " wide"}`,
        tabindex: "-1",
        "aria-label": step.kind === "q" ? `Question ${step.index + 1}` : label,
        title: label,
        onclick: () => go(steps.indexOf(step)),
      },
      label,
    );
    $("#rail").insertBefore(step.chip, before?.chip ?? null);
  }

  /* Live follow-ups: Claude can append questions to this open form (append_questions). */
  let specVersion = 1;
  let firstNewStep = null;

  function showNotice(markdown, { action } = {}) {
    const notice = $("#notice");
    notice.replaceChildren(
      md(markdown, "md notice-text"),
      action ? el("button", { type: "button", class: "ghost", onclick: action.run }, action.label, action.key ? kbd(action.key) : null) : null,
      el("button", { type: "button", class: "linkish notice-close", "aria-label": "Dismiss", onclick: () => (notice.hidden = true) }, "Dismiss"),
    );
    notice.hidden = false;
  }

  async function integrateUpdate() {
    const response = await fetch(api, { cache: "no-store" });
    if (!response.ok) return false;
    const data = await response.json();
    if (!data.version || data.version <= specVersion) return false;
    const known = new Set(spec.questions.map((q) => q.id));
    const added = data.spec.questions.filter((q) => !known.has(q.id));
    spec = data.spec;
    specVersion = data.version;
    const review = steps[steps.length - 1];
    const onReview = current === steps.length - 1;
    const created = added.map((q) => {
      initState(q);
      const index = spec.questions.findIndex((x) => x.id === q.id);
      const step = { kind: "q", q, index, body: renderStep(q, index) };
      mountStep(step, review);
      step.el.hidden = view === "stepper";
      step.chip.classList.add("is-new");
      views[q.id].sync();
      return step;
    });
    steps.splice(steps.length - 1, 0, ...created);
    if (onReview) current = steps.length - 1;
    for (const q of spec.questions) views[q.id].setTotal(spec.questions.length);
    if (created.length) {
      firstNewStep = created[0];
      growAll($("#steps"));
      refreshSummary();
      updateNav();
      saveDraft();
      const count = `${created.length} follow-up question${created.length === 1 ? "" : "s"}`;
      const note = data.note && data.note.version === specVersion && data.note.text ? `\n\n${data.note.text}` : "";
      showNotice(`**Claude added ${count}.**${note}`, {
        action: { label: "Go to them", key: "G", run: goToNew },
      });
    }
    return created.length > 0;
  }

  function goToNew() {
    $("#notice").hidden = true;
    if (firstNewStep) go(steps.indexOf(firstNewStep));
  }

  function render() {
    document.title = spec.title;
    $("#title").textContent = spec.title;
    const draft = loadDraft();
    for (const q of spec.questions) initState(q, draft?.answers?.[q.id]);

    steps = [];
    if (spec.intro) steps.push({ kind: "intro", body: renderIntro() });
    spec.questions.forEach((q, index) => steps.push({ kind: "q", q, index, body: renderStep(q, index) }));
    steps.push({ kind: "review", body: buildReview() });
    if (draft?.generalNotes) generalNotes.value = draft.generalNotes;

    $("#rail").replaceChildren();
    for (const step of steps) mountStep(step);

    for (const q of spec.questions) views[q.id].sync();
    refreshSummary();
    current = Number.isInteger(draft?.step) ? Math.min(draft.step, steps.length - 1) : 0;
    applyView();
    quietly(focusStep);
  }

  /* Keyboard */
  const help = $("#help");
  const openHelp = () => {
    if (!help.open) help.showModal();
  };
  $("#help-open").addEventListener("click", openHelp);
  $("#help-close").addEventListener("click", () => help.close());
  help.addEventListener("click", (event) => {
    if (event.target === help) help.close(); // backdrop click
  });
  help.addEventListener("close", () => focusStep());

  document.addEventListener("keydown", (event) => {
    if (finished || !spec) return;
    if (help.open) {
      if (event.key === "?") {
        event.preventDefault();
        help.close();
      }
      return;
    }
    const target = event.target;
    const typing = target instanceof HTMLElement && target.matches("textarea, input, select, [contenteditable]");
    const step = steps[current];
    const view = step.kind === "q" ? views[step.q.id] : null;
    const key = event.key;

    if ((event.ctrlKey || event.metaKey) && key === "Enter") {
      event.preventDefault();
      if (step.kind === "review") submit();
      else next();
      return;
    }
    if (typing) {
      if (key === "Escape") {
        event.preventDefault();
        target.blur();
        // A free-text question's primary focus is this very textarea, so Esc parks focus on the screen instead.
        if (view && !target.closest(".free")) view.focusPrimary();
        else step.el.focus({ preventScroll: true });
      }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const onButton = target instanceof HTMLElement && Boolean(target.closest("button, a"));
    if (view?.isGrabbing?.() && (key === "Enter" || key === " " || key === "Escape")) {
      event.preventDefault();
      if (key === "Escape") view.cancelGrab();
      else view.drop();
      return;
    }
    if (event.shiftKey && view?.shiftMove && ["ArrowUp", "ArrowDown", "K", "J"].includes(key)) {
      event.preventDefault();
      view.shiftMove(key === "ArrowUp" || key === "K" ? -1 : 1);
      return;
    }

    const handled = (() => {
      switch (key) {
        case "ArrowRight":
        case "l":
          next();
          return true;
        case "ArrowLeft":
        case "h":
          prev();
          return true;
        case "Home":
          go(0);
          return true;
        case "End":
          go(steps.length - 1);
          return true;
        case "?":
          openHelp();
          return true;
        case "v":
        case "V":
          toggleView();
          return true;
        case "g":
        case "G":
          if ($("#notice").hidden || !firstNewStep) return false;
          goToNew();
          return true;
        case "Enter":
          if (onButton) return false; // let the focused button do its own thing
          if (step.kind === "review") submit();
          else {
            view?.confirmFocused();
            next();
          }
          return true;
      }
      if (step.kind === "review") {
        if (key === "a" || key === "A") {
          acceptAll();
          return true;
        }
        return false;
      }
      if (!view) return false;
      switch (key) {
        case "ArrowDown":
        case "j":
          view.move(1);
          return true;
        case "ArrowUp":
        case "k":
          view.move(-1);
          return true;
        case " ":
          if (onButton) return false;
          return view.toggleFocused();
        case "o":
        case "O":
          view.chooseOther();
          return true;
        case "n":
        case "N":
          view.focusNotes();
          return true;
        case "r":
        case "R":
          view.applyRec();
          return true;
        case "c":
        case "C":
          return view.confirmOrder ? view.confirmOrder() : false;
        case "d":
        case "D":
          view.setMode(state[step.q.id].mode === "defer" ? "answer" : "defer");
          return true;
        case "i":
        case "I":
          if (state[step.q.id].mode === "needs-info") view.setMode("answer");
          else view.setMode("needs-info");
          return true;
        case "x":
        case "X":
        case "Backspace":
        case "Delete":
          view.clear();
          return true;
      }
      if (/^[1-9]$/.test(key)) {
        view.chooseIndex(Number(key) - 1);
        return true;
      }
      return false;
    })();
    if (handled) event.preventDefault();
  });

  /* Submit */
  let confirmArmed = false;
  function resetSubmitConfirm() {
    confirmArmed = false;
    nextButton.classList.remove("confirm");
    const step = steps[current];
    if (!step) return;
    if (step.kind === "review") nextButton.textContent = "Submit answers";
    else {
      nextButton.replaceChildren(
        step.kind === "intro" ? "Start " : steps[current + 1]?.kind === "review" ? "Review " : "Next ",
        el("span", { "aria-hidden": "true" }, "→"),
      );
    }
  }

  function payload() {
    const answers = {};
    for (const q of spec.questions) {
      const s = state[q.id];
      answers[q.id] =
        q.kind === "rank"
          ? { status: s.mode, ...(s.ranked ? { ranked: s.ranked } : {}), notes: s.notes }
          : { status: s.mode, selected: [...s.selected], other: s.otherOn ? s.other : "", notes: s.notes };
    }
    return { answers, generalNotes: generalNotes?.value ?? "", specVersion };
  }

  function showDone(title, text) {
    finished = true;
    $("#main").hidden = true;
    $("#bottom").hidden = true;
    $("#rail").hidden = true;
    $("#done-title").textContent = title;
    $("#done-text").textContent = text;
    $("#done").hidden = false;
    window.scrollTo(0, 0);
  }

  async function submit() {
    if (finished) return;
    if (steps[current].kind !== "review") return go(steps.length - 1);
    const open = spec.questions.filter((q) => statusOf(q) === "unanswered").length;
    if (open > 0 && !confirmArmed) {
      confirmArmed = true;
      nextButton.classList.add("confirm");
      nextButton.textContent = `Submit with ${open} unanswered?`;
      return;
    }
    nextButton.disabled = true;
    nextButton.textContent = "Sending…";
    try {
      const response = await fetch(`${api}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 409 && typeof body.version === "number" && body.version > specVersion) {
        nextButton.disabled = false;
        await integrateUpdate();
        resetSubmitConfirm();
        showNotice("**Claude added questions while you were answering.** Look at them, then submit again.", {
          action: { label: "Go to them", key: "G", run: goToNew },
        });
        return;
      }
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      try {
        localStorage.removeItem(draftKey());
      } catch {}
      showDone(
        "Answers sent",
        body.delivered
          ? "Claude has your answers. You can close this tab."
          : `Saved. Claude was not waiting on this form, so ask it to collect them with await_user_answers (session ${sessionId}).`,
      );
    } catch (error) {
      nextButton.disabled = false;
      resetSubmitConfirm();
      showBanner(`Could not submit: ${error.message}. Your answers are still here; try again.`);
    }
  }

  function showBanner(text) {
    const banner = $("#banner");
    banner.textContent = text;
    banner.hidden = !text;
  }

  /* Liveness: tell the user when Claude stopped waiting or the server went away. */
  let notWaiting = 0;
  async function poll() {
    if (finished) return;
    try {
      const response = await fetch(`${api}/state`, { cache: "no-store" });
      if (response.status === 404) return showBanner("This interview has expired on the server. Your draft is kept in this browser.");
      const { state: s, waiting, version } = await response.json();
      if (typeof version === "number" && version > specVersion) await integrateUpdate();
      if (s === "submitted") return showDone("Already submitted", "These answers were already sent to Claude.");
      if (s === "cancelled") return showBanner("Claude cancelled this interview. Your draft is kept in this browser.");
      notWaiting = waiting ? 0 : notWaiting + 1;
      showBanner(
        notWaiting >= 2
          ? `Claude is not waiting on this form right now. You can still submit: the answers are saved and Claude can collect them with await_user_answers (session ${sessionId}).`
          : "",
      );
    } catch {
      showBanner("Lost contact with the ask-user-rich server (was the Claude Code session closed?). Your draft is kept in this browser.");
    }
  }

  async function boot() {
    try {
      const response = await fetch(api, { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 404 ? "This interview was not found or has expired." : `HTTP ${response.status}`);
      const data = await response.json();
      spec = data.spec;
      sessionId = data.id;
      specVersion = typeof data.version === "number" ? data.version : 1;
      if (data.state === "submitted") return showDone("Already submitted", "These answers were already sent to Claude.");
      render();
      setInterval(poll, 2500);
      poll();
    } catch (error) {
      $("#title").textContent = "Interview unavailable";
      showBanner(error.message);
      $("#bottom").hidden = true;
    }
  }
  boot();
})();
