/**
 * Structured questions for plan mode.
 *
 * The model asks with the `ask_question` tool; the extension shows the question
 * in the terminal UI — a selector with suggested answers plus a free-text
 * escape hatch — and returns the user's answer as the tool result. This is the
 * same flow opencode uses for clarifying questions: the answer arrives in the
 * same run, so plan mode never interrupts with the execute dialog while the
 * agent is still gathering context.
 */

import type { PlanTheme } from "./render.js";

export const ASK_QUESTION_TOOL = "ask_question";

/** Always appended to the suggestions, unless the caller opts out. */
export const OTHER_OPTION = "Other — write my own answer";

const FREE_TEXT_PLACEHOLDER = "Type your answer…";

export interface AskQuestionParams {
  question: string;
  options?: string[];
  allowOther?: boolean;
  multiple?: boolean;
}

export interface QuestionAnswer {
  question: string;
  answer?: string;
  cancelled: boolean;
  unavailable?: boolean;
}

/** The slice of `ctx.ui` the question flow needs. */
export interface QuestionUI {
  select(
    title: string,
    options: string[],
    opts?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  input(
    title: string,
    placeholder?: string,
    opts?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  confirm(
    title: string,
    message: string,
    opts?: { signal?: AbortSignal },
  ): Promise<boolean>;
}

/**
 * Parameters as JSON Schema. Pi accepts plain JSON Schema for custom tools
 * (MCP tools use it too), so the extension needs no runtime TypeBox import
 * just to describe one selector.
 */
export const ASK_QUESTION_PARAMETERS = {
  type: "object",
  properties: {
    question: {
      type: "string",
      description:
        "The question to ask the user. Keep it short and specific: it is shown as the dialog title.",
    },
    options: {
      type: "array",
      items: { type: "string" },
      description:
        "Suggested answers, shown as a selectable list. Omit it to ask for a free-text answer.",
    },
    allowOther: {
      type: "boolean",
      description:
        "Add an option so the user can write an answer that is not in the list. Defaults to true.",
    },
    multiple: {
      type: "boolean",
      description:
        "Allow choosing more than one option. Defaults to false (a single answer).",
    },
  },
  required: ["question"],
  additionalProperties: false,
} as const;

function dialogOptions(
  signal?: AbortSignal,
): { signal?: AbortSignal } | undefined {
  return signal ? { signal } : undefined;
}

/** Drop blanks and duplicates, and never collide with the "Other" entry. */
function uniqueOptions(options: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  for (const raw of options ?? []) {
    const option = raw.trim();
    if (!option || option === OTHER_OPTION || seen.has(option)) continue;
    seen.add(option);
  }
  return [...seen];
}

async function askFreeText(
  ui: QuestionUI,
  question: string,
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  const text = await ui.input(
    question,
    FREE_TEXT_PLACEHOLDER,
    dialogOptions(signal),
  );
  if (signal?.aborted) return undefined;
  const answer = text?.trim();
  return answer ? [answer] : undefined;
}

async function askWithOptions(
  ui: QuestionUI,
  question: string,
  options: string[],
  allowOther: boolean,
  multiple: boolean,
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  const choices = allowOther ? [...options, OTHER_OPTION] : options;
  const picked: string[] = [];

  for (;;) {
    const choice = await ui.select(question, choices, dialogOptions(signal));
    if (choice === undefined || signal?.aborted) return undefined;

    let answer = choice;
    if (allowOther && choice === OTHER_OPTION) {
      const text = await ui.input(
        question,
        FREE_TEXT_PLACEHOLDER,
        dialogOptions(signal),
      );
      if (signal?.aborted) return undefined;
      answer = text?.trim() ?? "";
      if (!answer) return undefined;
    }

    if (!picked.includes(answer)) picked.push(answer);
    if (!multiple) return picked;

    const another = await ui.confirm(
      "Add another answer?",
      `Selected: ${picked.join("; ")}`,
      dialogOptions(signal),
    );
    if (signal?.aborted) return undefined;
    if (!another) return picked;
  }
}

/**
 * Ask one question and wait for the answer. Returns `cancelled: true` when the
 * user dismissed the dialog, so the model never mistakes a dismissal for an
 * answer.
 */
export async function askQuestion(
  ui: QuestionUI,
  params: AskQuestionParams,
  signal?: AbortSignal,
): Promise<QuestionAnswer> {
  const question = params.question?.trim();
  if (!question) {
    throw new Error("ask_question requires a non-empty question.");
  }

  if (signal?.aborted) return { question, cancelled: true };

  const options = uniqueOptions(params.options);
  const answers =
    options.length === 0
      ? await askFreeText(ui, question, signal)
      : await askWithOptions(
          ui,
          question,
          options,
          params.allowOther ?? true,
          params.multiple ?? false,
          signal,
        );

  if (!answers || answers.length === 0 || signal?.aborted) {
    return { question, cancelled: true };
  }

  const answer =
    answers.length === 1
      ? answers[0]
      : answers.map((item) => `- ${item}`).join("\n");
  return { question, answer, cancelled: false };
}

/** The tool result the model reads. Never fabricates an answer. */
export function answerText(result: QuestionAnswer): string {
  if (result.unavailable) {
    return "No interactive UI is available in this session, so the question could not be shown. Ask the user in plain text and stop.";
  }
  if (result.cancelled || !result.answer) {
    return "The user dismissed the question without answering. Do not assume an answer: ask again, or state the assumption explicitly and continue.";
  }
  return `The user answered:\n\n${result.answer}`;
}

/** One line per answer, with the question repeated when expanded. */
export function questionResultLines(
  result: QuestionAnswer,
  theme: PlanTheme,
  expanded: boolean,
): string[] {
  if (result.unavailable) {
    return [theme.fg("warning", "⚠ no interactive UI — ask in plain text")];
  }
  if (result.cancelled || !result.answer) {
    return [theme.fg("warning", "⚠ question dismissed")];
  }

  const answerLines = result.answer.split("\n");
  const lines = [theme.fg("success", "> ") + theme.fg("text", answerLines[0])];
  for (const line of answerLines.slice(1)) lines.push(`  ${line}`);
  if (expanded) lines.unshift(theme.fg("muted", `? ${result.question}`));
  return lines;
}

/** The call row: the question, plus the suggestions when expanded. */
export function questionCallLines(
  params: AskQuestionParams,
  theme: PlanTheme,
  expanded: boolean,
): string[] {
  const lines = [
    theme.fg("accent", "? ") + theme.fg("muted", params.question ?? ""),
  ];
  const options = uniqueOptions(params.options);
  if (expanded) {
    for (const option of options) lines.push(theme.fg("dim", `  • ${option}`));
    if (params.allowOther ?? true) {
      lines.push(theme.fg("dim", `  • ${OTHER_OPTION}`));
    }
  } else if (options.length > 0) {
    lines.push(
      theme.fg(
        "dim",
        `  ${options.length} suggested answer${options.length === 1 ? "" : "s"}`,
      ),
    );
  }
  return lines;
}
