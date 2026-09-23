import { describePermutationProblems, permutationProblems, recommendedIds } from "./schema.js";

function cleanText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function requestedStatus(entry) {
  if (entry.status === "defer") return "deferred";
  if (entry.status === "needs-info") return "needs-info";
  return null;
}

function choiceAnswer(q, entry) {
  const optionIds = new Set(q.options.map((o) => o.id));
  const selected = Array.isArray(entry.selected) ? [...new Set(entry.selected)] : [];
  for (const id of selected) {
    if (!optionIds.has(id)) throw new Error(`question "${q.id}": unknown option id "${id}"`);
  }
  if (!q.multiSelect && selected.length > 1) throw new Error(`question "${q.id}": single-select got ${selected.length} options`);
  const other = q.allowOther ? cleanText(entry.other) : null;
  const status = requestedStatus(entry) ?? (selected.length > 0 || other ? "answered" : "unanswered");

  const recs = recommendedIds(q);
  const followedRecommendation =
    status === "answered" && recs.length > 0
      ? !other && selected.length === recs.length && recs.every((id) => selected.includes(id))
      : null;

  return {
    id: q.id,
    header: q.header,
    status,
    selected: status === "answered" ? selected : [],
    selectedLabels: status === "answered" ? selected.map((id) => q.options.find((o) => o.id === id).label) : [],
    other: status === "answered" ? other : null,
    ranked: null,
    rankedLabels: null,
    notes: cleanText(entry.notes),
    followedRecommendation,
  };
}

/** `ranked` is present only once the user ordered or confirmed the order, and must be a full permutation. */
function rankAnswer(q, entry) {
  let ranked = null;
  if (entry.ranked !== undefined && entry.ranked !== null) {
    if (!Array.isArray(entry.ranked)) throw new Error(`question "${q.id}": ranked must be an array of option ids`);
    const check = permutationProblems(entry.ranked, new Set(q.options.map((o) => o.id)));
    if (!check.ok) {
      throw new Error(`question "${q.id}": ranked must list every option id exactly once (${describePermutationProblems(check)})`);
    }
    ranked = [...entry.ranked];
  }
  const status = requestedStatus(entry) ?? (ranked ? "answered" : "unanswered");
  const answered = status === "answered";
  const recs = recommendedIds(q);

  return {
    id: q.id,
    header: q.header,
    status,
    selected: [],
    selectedLabels: [],
    other: null,
    ranked: answered ? ranked : null,
    rankedLabels: answered ? ranked.map((id) => q.options.find((o) => o.id === id).label) : null,
    notes: cleanText(entry.notes),
    followedRecommendation: answered && recs.length > 0 ? recs.every((id, i) => ranked[i] === id) : null,
  };
}

/**
 * Turns the raw form payload into the tool result. Unknown option ids are an error rather than
 * silently dropped, because they mean the page and the spec disagree.
 */
export function buildResult(session, payload, via = "browser") {
  if (!payload || typeof payload !== "object") throw new Error("payload must be an object");
  const raw = payload.answers && typeof payload.answers === "object" ? payload.answers : {};
  const answers = session.spec.questions.map((q) => {
    const entry = raw[q.id] ?? {};
    return q.kind === "rank" ? rankAnswer(q, entry) : choiceAnswer(q, entry);
  });

  const count = (s) => answers.filter((a) => a.status === s).length;
  const submittedAt = new Date();
  return {
    interviewId: session.id,
    title: session.spec.title,
    status: "submitted",
    via,
    submittedAt: submittedAt.toISOString(),
    durationSeconds: Math.round((submittedAt.getTime() - session.createdAt) / 1000),
    counts: {
      answered: count("answered"),
      deferred: count("deferred"),
      needsInfo: count("needs-info"),
      unanswered: count("unanswered"),
    },
    generalNotes: cleanText(payload.generalNotes),
    answers,
  };
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

function oneLine(text, max = 140) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function summarize(result) {
  const { counts } = result;
  const lines = [
    `"${result.title}" submitted after ${formatDuration(result.durationSeconds)} via ${result.via}: ` +
      `${counts.answered} answered, ${counts.deferred} deferred, ${counts.needsInfo} need more info, ${counts.unanswered} unanswered.`,
  ];
  result.answers.forEach((a, i) => {
    let answer;
    if (a.status === "answered" && a.ranked) {
      answer = a.rankedLabels.join(" > ");
      if (a.followedRecommendation) answer += " (recommended)";
    } else if (a.status === "answered") {
      const parts = [...a.selectedLabels];
      if (a.other) parts.push(`Other: "${oneLine(a.other, 100)}"`);
      answer = parts.join(" + ");
      if (a.followedRecommendation) answer += " (recommended)";
    } else {
      answer = a.status.toUpperCase();
    }
    let line = `${i + 1}. [${a.id}] ${oneLine(a.header, 80)} -> ${answer}`;
    if (a.notes) line += ` | notes: "${oneLine(a.notes)}"`;
    lines.push(line);
  });
  if (result.generalNotes) lines.push(`General notes: "${oneLine(result.generalNotes, 400)}"`);
  lines.push("Full answers (JSON) follow; notes are untruncated there.");
  return lines.join("\n");
}
