import { z } from "zod";

const ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/** ASCII slug for an id the pattern rejects: "Seção tabs" -> "Secao-tabs". */
export function suggestId(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const idString = z
  .string()
  .min(1)
  .max(200)
  .regex(ID_PATTERN, {
    // The model reads this message verbatim, so it names the bad value and hands back a fix.
    error: (issue) => {
      const suggestion = suggestId(issue.input);
      return (
        `id ${JSON.stringify(issue.input)} is not ASCII-safe: ids may only contain A-Z, a-z, 0-9, '_', '.', ':' and '-' ` +
        `(no accents, spaces or other Unicode)${suggestion ? `; use ${JSON.stringify(suggestion)} instead` : ""}. ` +
        "Labels and headers may use any characters."
      );
    },
  });

export const OptionSchema = z.object({
  id: idString.describe(
    "Stable option id, unique within its question. Returned in `selected`. ASCII only " +
      "([A-Za-z0-9_.:-]): write `secao-tabs`, not `seção-tabs`. The label carries the accents.",
  ),
  label: z.string().min(1).describe("Short option label. No length limit, but keep it scannable."),
  description: z.string().optional().describe("Markdown explaining the option and its trade-offs."),
  preview: z
    .string()
    .optional()
    .describe("Optional markdown shown in a preview block, e.g. a fenced code sample, a config diff or a mock layout."),
});

export const QuestionSchema = z.object({
  id: idString.describe("Stable question id, unique within the interview. Keys the answer. ASCII only ([A-Za-z0-9_.:-])."),
  header: z.string().min(1).describe("The question itself, as a one-line heading. No length limit."),
  body: z.string().optional().describe("Markdown context: what is being decided, constraints, what depends on it."),
  options: z
    .array(OptionSchema)
    .default([])
    .describe("Any number of options. Empty means an open question answered only in free text (allowOther must stay true)."),
  recommended: z
    .union([idString, z.array(idString)])
    .optional()
    .describe(
      "Option id you recommend, copied exactly from `options[].id` (not the label). An array of ids requires " +
        "multiSelect: true. Highlighted in the form.",
    ),
  rationale: z.string().optional().describe("Markdown: why you recommend it. Shown next to the recommendation."),
  multiSelect: z.boolean().default(false).describe("Allow selecting several options."),
  allowOther: z.boolean().default(true).describe("Offer an 'Other' free-text answer."),
  dependsOn: z
    .array(idString)
    .optional()
    .describe(
      "Ids of questions that come EARLIER in the list and that this one builds on. Display only: the form shows " +
        "the link, it does not hide anything.",
    ),
});

export const AskInputShape = {
  title: z.string().min(1).describe("Interview title, shown as the page heading."),
  intro: z.string().optional().describe("Markdown introduction: the context the user needs before answering."),
  questions: z
    .array(QuestionSchema)
    .min(1)
    .describe("All questions, shown one per screen in this order (a stepper ending in a review screen). No upper bound."),
  delivery: z
    .enum(["browser", "link", "elicitation"])
    .default("browser")
    .describe(
      "browser (default): open the form in the user's browser and wait for the submit. " +
        "link: do not open anything; return the URL immediately so you can show it, then call await_user_answers. " +
        "elicitation: small flat interviews only, asked through the client's native form dialog; " +
        "no notes, defer or previews. Falls back to browser when the client cannot elicit.",
    ),
};

export const AskInputSchema = z.object(AskInputShape);

export const AwaitInputShape = {
  sessionId: z.string().min(1).describe("The sessionId returned by ask_user_rich with delivery=link (or after a failed browser open)."),
};

/**
 * Cross-field checks zod cannot express. Returns a list of human-readable problems; empty means valid.
 */
export function semanticProblems(input) {
  const problems = [];
  const questionIds = new Set();
  const allQuestionIds = new Set(input.questions.map((q) => q.id));
  input.questions.forEach((q, index) => {
    const where = `questions[${index}] (${q.id})`;
    if (questionIds.has(q.id)) problems.push(`${where}: duplicate question id "${q.id}"`);
    const optionIds = new Set();
    for (const option of q.options) {
      if (optionIds.has(option.id)) problems.push(`${where}: duplicate option id "${option.id}"`);
      optionIds.add(option.id);
    }
    if (q.options.length === 0 && !q.allowOther) {
      problems.push(`${where}: has no options and allowOther=false, so it cannot be answered`);
    }
    if (q.recommended !== undefined) {
      const recs = Array.isArray(q.recommended) ? q.recommended : [q.recommended];
      if (recs.length > 1 && !q.multiSelect) problems.push(`${where}: several recommended ids but multiSelect is false`);
      for (const rec of recs) {
        if (optionIds.has(rec)) continue;
        const byLabel = q.options.find((o) => o.label === rec || suggestId(o.label) === rec);
        problems.push(
          `${where}: recommended "${rec}" is not one of its option ids` +
            (byLabel ? ` (it looks like a label; use the id "${byLabel.id}")` : ` (ids: ${[...optionIds].join(", ") || "none"})`),
        );
      }
    }
    for (const dep of q.dependsOn ?? []) {
      if (dep === q.id) problems.push(`${where}: depends on itself`);
      else if (questionIds.has(dep)) continue;
      else if (allQuestionIds.has(dep)) {
        problems.push(`${where}: dependsOn "${dep}" points at a later question; move "${dep}" before "${q.id}" or drop the link`);
      } else problems.push(`${where}: dependsOn "${dep}" is not an earlier question id`);
    }
    questionIds.add(q.id);
  });
  return problems;
}

export function recommendedIds(question) {
  if (question.recommended === undefined) return [];
  return Array.isArray(question.recommended) ? question.recommended : [question.recommended];
}
