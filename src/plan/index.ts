/**
 * Plan mode for pi-craft.
 *
 * Read-only exploration with a plan-then-execute workflow.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - /plan:status to view current plan and progress
 * - --plan flag to start in plan mode
 * - Read-only bash check shared with ask mode through the mode runtime
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers as an early completion signal during a step
 * - `/plan:done`: a step the parent finished itself, marked without re-running it
 * - One agent run per step: the checklist advances between runs, so it never
 *   waits for the final message
 * - Live checklist: progress bar, current step and completed ticks while the
 *   plan is running
 * - A re-statement of the plan keeps the ticks of the steps it repeats
 * - Final card with the whole completed checklist, duration and changed files
 * - Branch-aware state via session entries
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { ModeRegistry } from "../modes/index.js";
import { extractPlanSteps } from "./planner.js";
import { createRunner, type StepRunner } from "./agents.js";
import {
  carryCompletion,
  markCompletedSteps,
  getCompletionStats,
} from "./progress.js";
import {
  cardLines,
  statusText,
  summaryText,
  widgetLines,
} from "./render.js";
import {
  ASK_QUESTION_PARAMETERS,
  ASK_QUESTION_TOOL,
  answerText,
  askQuestion,
  questionCallLines,
  questionResultLines,
  type AskQuestionParams,
  type QuestionAnswer,
} from "./question.js";
import type { PlanStep, PlanMode, PlanState } from "./types.js";

// `ask_question` is active in both modes: planning needs it to gather context,
// and execution needs it to resolve a decision without leaving the plan.
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", ASK_QUESTION_TOOL];
// The plan context is the only hidden message the model needs: the step
// instructions travel in the visible `pi-plan-execute` message, which is also
// the last context message of every chained step run.
const PLAN_CONTEXT_TYPE = "pi-plan-context";
const PLAN_MARKER = "[PLAN MODE ACTIVE]";
/** Steps one subagent runs at once when nothing was configured. */
const DEFAULT_BATCH = 3;

const PLAN_PROMPT = `${PLAN_MARKER}
You are in plan mode — a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: read, bash, grep, find, ls
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to an allowlist of read-only commands

Instructions:
- Analyze the codebase and understand the task
- Ask clarifying questions if needed. When you need a decision or missing
  information, call the ask_question tool with short suggested options; the
  user picks one or writes their own answer. Do not end your turn with an open
  question in plain text
- If an answer is not essential, state your assumption and keep planning
- Output a detailed numbered plan under a "Plan:" header once the task is clear.
  One step per line: a plain "1. text" at the start of the line, and nothing
  else on the header line. That is the shape the list is read in.

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes — just describe what you would do.`;

/** Minimal component shape shared by widgets and message renderers. */
interface PlanComponent {
  render(width: number): string[];
  invalidate(): void;
}

interface PlanCardDetails {
  steps: PlanStep[];
  startedAt?: number;
  durationMs?: number;
  files?: string[];
}

/** Transcript component: padded card with a blank line around it. */
function cardComponent(
  build: (width: number) => string[],
  pad: number,
): PlanComponent {
  return {
    render(width: number) {
      const inner = Math.max(12, width - pad * 2);
      const body = build(inner).map((line) => " ".repeat(pad) + line);
      return ["", ...body, ""];
    },
    invalidate() {},
  };
}

/** Tool renderer for precomputed themed lines. */
function linesComponent(lines: string[]): PlanComponent {
  return {
    render: () => lines,
    invalidate() {},
  };
}

export function registerPlan(
  pi: ExtensionAPI,
  modes: ModeRegistry,
  options: { run?: StepRunner } = {},
): void {
  let steps: PlanStep[] = [];
  let startedAt: number | undefined;
  let filesTouched = new Set<string>();
  // Consecutive steps one subagent runs: the plan order is the dependency
  // order, so a batch never splits a step from the one it needs.
  let batch = DEFAULT_BATCH;
  // Set while a subagent is working, so /plan:stop can cut it short.
  let running: AbortController | undefined;
  // The step `/plan:skip` asked to drop from the batch in flight.
  let skipped: number | undefined;

  // --- Mode state ---------------------------------------------------------

  // Plan and execution are modes of the shared runtime; ask mode lives there
  // too, so only one of them is ever active.

  modes.define({
    id: "plan",
    label: "Plan mode",
    readOnly: true,
    tools: PLAN_MODE_TOOLS,
    flag: "plan",
    marker: PLAN_MARKER,
    contextType: PLAN_CONTEXT_TYPE,
    prompt: PLAN_PROMPT,
    keepNewestContext: true,
    onEnter: () => resetExecution(),
    onLeave: (_ctx, to) => {
      // Moving into execution must keep the steps; leaving for any other mode
      // starts clean.
      if (to !== "execute") resetExecution();
    },
  });

  modes.define({
    id: "execute",
    label: "Plan execution",
  });

  // Sessions from 0.3 and earlier stored the mode inside the `pi-plan` entry.
  modes.registerLegacy("pi-plan", (data) => {
    const mode = (data as PlanState | undefined)?.mode;
    return mode === "plan" ? "plan" : mode === "execute" ? "execute" : undefined;
  });

  // --- Helpers ---

  function persistState(): void {
    pi.appendEntry("pi-plan", {
      mode: (modes.current() as PlanMode | undefined) ?? "normal",
      steps,
      startedAt,
      files: [...filesTouched],
      batch,
    } satisfies PlanState);
  }

  function resetExecution(): void {
    steps = [];
    startedAt = undefined;
    filesTouched = new Set();
    running = undefined;
    skipped = undefined;
  }

  /** The cursor is the first unfinished step, so it is persisted with `steps`. */
  function currentStep(): PlanStep | undefined {
    return steps.find((step) => !step.completed);
  }

  /** The next `batch` unfinished steps, in plan order. */
  function nextBatch(): PlanStep[] {
    return steps.filter((step) => !step.completed).slice(0, batch);
  }

  function stepContext(batchSteps: PlanStep[]): string {
    const remaining = steps.filter((s) => !s.completed);
    const todoList = remaining.map((s) => `${s.step}. ${s.text}`).join("\n");
    const work = batchSteps.map((s) => `${s.step}. ${s.text}`).join("\n");
    const first = batchSteps[0].step;
    const last = batchSteps[batchSteps.length - 1].step;
    const range =
      first === last
        ? `step ${first} of ${steps.length}`
        : `steps ${first}-${last} of ${steps.length}`;
    const markers = batchSteps.map((s) => `[DONE:${s.step}]`).join(" ");
    return `[EXECUTING PLAN — ${range}]

Remaining steps:
${todoList}

Work on these steps only, in order:
${work}

Do not start any other step. Stop as soon as the batch is done: the next batch
starts when this run ends. Include ${markers} in your reply for each step you
finish, and include the marker alone when a step needs no tool calls. If a step
needs a decision you cannot take, stop and say what you need.`;
  }

  function updateUI(ctx: ExtensionContext): void {
    if (modes.is("execute") && steps.length > 0) {
      const { completed, total } = getCompletionStats(steps);
      ctx.ui.setStatus("pi-plan", statusText(completed, total, ctx.ui.theme));

      // Snapshot: the component outlives this call, and `steps` is replaced
      // when the plan ends.
      const snapshot = steps;
      showChecklist(ctx, snapshot, { progress: true, current: true });
      return;
    }

    if (modes.is("plan")) {
      ctx.ui.setStatus("pi-plan", ctx.ui.theme.fg("warning", "plan"));

      if (steps.length > 0) {
        showChecklist(ctx, steps, { progress: false, current: false });
      } else {
        ctx.ui.setWidget("pi-plan-todos", undefined);
      }
      return;
    }

    ctx.ui.setStatus("pi-plan", undefined);
    ctx.ui.setWidget("pi-plan-todos", undefined);
  }

  // The shared runtime owns the transitions; every change repaints the badge
  // and the checklist.
  modes.onChange((_to, _from, ctx) => updateUI(ctx));

  /**
   * The TUI gets a component, so the checklist can be cut to the real terminal
   * width. Every other client can only receive lines, and a fixed budget is
   * better than no checklist at all.
   */
  function showChecklist(
    ctx: ExtensionContext,
    snapshot: PlanStep[],
    options: { progress: boolean; current: boolean },
  ): void {
    if (ctx.mode !== "tui") {
      ctx.ui.setWidget(
        "pi-plan-todos",
        widgetLines(snapshot, ctx.ui.theme, 100, options),
      );
      return;
    }

    ctx.ui.setWidget("pi-plan-todos", (_tui: unknown, theme: Theme) => ({
      render: (width: number) =>
        widgetLines(snapshot, theme, Math.max(12, width - 2), options),
      invalidate() {},
    }));
  }

  /** Run the plan batch by batch until it ends, stops or fails. */
  async function beginStep(ctx: ExtensionContext): Promise<void> {
    while (modes.is("execute")) {
      const batchSteps = nextBatch();
      if (batchSteps.length === 0) {
        finishPlan(ctx);
        return;
      }

      updateUI(ctx);
      persistState();

      const prompt = stepContext(batchSteps);
      pi.sendMessage(
        {
          customType: "pi-plan-execute",
          content: prompt,
          display: true,
          details: {
            steps: steps.map((s) => ({ ...s })),
            startedAt,
          } satisfies PlanCardDetails,
        },
        { triggerTurn: false },
      );

      const controller = new AbortController();
      running = controller;

      let result;
      try {
        const run = options.run ?? createRunner(ctx.cwd);
        result = await run(prompt, controller.signal);
      } catch (error) {
        running = undefined;
        ctx.ui.notify(
          `Subagent failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        updateUI(ctx);
        persistState();
        return;
      }
      running = undefined;

      // /plan:stop left the mode while this batch was in flight: report
      // nothing, the steps must stay where they were.
      if (!modes.is("execute")) return;

      const skip = skipped;
      skipped = undefined;
      if (skip !== undefined) {
        const step = steps.find((s) => s.step === skip);
        if (step) step.completed = true;
        updateUI(ctx);
        persistState();
        continue;
      }

      for (const file of result.files) filesTouched.add(file);

      const marked = markCompletedSteps(result.text, steps);
      const cut =
        result.stopReason === "aborted" ||
        result.stopReason === "error" ||
        result.stopReason === "length";

      // A batch that did nothing leaves its steps open: /plan:retry can pick
      // them up instead of hiding work that never happened.
      if (cut || (!result.usedTools && marked === 0)) {
        updateUI(ctx);
        persistState();
        return;
      }

      // Models often finish a batch without emitting [DONE:n] markers. Treat a
      // successful run as completing the batch instead of leaving it stuck.
      if (marked === 0) {
        for (const step of batchSteps) {
          const item = steps.find((s) => s.step === step.step);
          if (item) item.completed = true;
        }
      }

      for (const step of batchSteps) step.completed = true;
      updateUI(ctx);
      persistState();
    }
  }

  /**
   * Every step is done: show the final card, and leave execute mode if that is where
   * the plan ran. A plan closed by hand (`/plan:done`) closes the same way.
   */
  function finishPlan(ctx: ExtensionContext): void {
    if (steps.length === 0 || currentStep()) return;
    const { completed, total } = getCompletionStats(steps);
    const durationMs = startedAt ? Date.now() - startedAt : undefined;
    const files = [...filesTouched].sort();
    const completedList = steps
      .map((s) => `- [x] ${s.step}. ${s.text}`)
      .join("\n");
    const summary = summaryText(completed, total, durationMs, files.length);

    pi.sendMessage(
      {
        customType: "pi-plan-complete",
        content: `**Plan complete** — ${summary}\n\n${completedList}`,
        display: true,
        details: {
          steps: steps.map((step) => ({ ...step })),
          startedAt,
          durationMs,
          files,
        } satisfies PlanCardDetails,
      },
      { triggerTurn: false },
    );

    if (modes.is("execute")) modes.leave(ctx);
    // The card already carries the finished list: drop it so a later
    // `/plan:status` does not report a plan that is over.
    resetExecution();
    persistState();
    updateUI(ctx);
  }

  function setPlanMode(ctx: ExtensionContext, on: boolean): void {
    if (on) {
      if (modes.is("plan")) {
        ctx.ui.notify("Plan mode is already on.", "info");
        return;
      }
      modes.enter("plan", ctx);
      ctx.ui.notify(`Plan mode enabled. Tools: ${PLAN_MODE_TOOLS.join(", ")}`);
    } else {
      if (!modes.is("plan")) {
        ctx.ui.notify("Plan mode is off.", "info");
        return;
      }
      modes.leave(ctx);
      ctx.ui.notify("Plan mode disabled. Full access restored.");
    }
    persistState();
    updateUI(ctx);
  }

  function togglePlanMode(ctx: ExtensionContext): void {
    // Turning on plan mode (from normal or execute); off never resets a step
    // list, that is what `resetExecution` is for.
    setPlanMode(ctx, !modes.is("plan"));
  }

  // --- Transcript renderers ---

  // A plan is a checklist, not prose: render the stored steps instead of the
  // plain markdown fallback, so the list keeps its numbers and ticks.
  pi.registerMessageRenderer<PlanCardDetails>(
    "pi-plan-todo-list",
    (message, { outputPad }, theme) => {
      const details = message.details as PlanCardDetails | undefined;
      const list = details?.steps ?? [];
      // A message stored before 0.3 has no details: let pi render it as it did.
      if (list.length === 0) return undefined;
      return cardComponent(
        (width) =>
          cardLines(list, theme, width, {
            title: "Plan",
            summary: `${list.length} step${list.length === 1 ? "" : "s"} · ready to execute`,
          }),
        outputPad,
      );
    },
  );

  pi.registerMessageRenderer<PlanCardDetails>(
    "pi-plan-execute",
    (message, { outputPad }, theme) => {
      const details = message.details as PlanCardDetails | undefined;
      const list = details?.steps ?? [];
      if (list.length === 0) return undefined;
      const remaining = list.filter((step) => !step.completed).length;
      return cardComponent(
        (width) =>
          cardLines(list, theme, width, {
            title: "Executing plan",
            summary: `${remaining} of ${list.length} step${list.length === 1 ? "" : "s"} remaining`,
          }),
        outputPad,
      );
    },
  );

  pi.registerMessageRenderer<PlanCardDetails>(
    "pi-plan-complete",
    (message, { expanded, outputPad }, theme) => {
      const details = message.details as PlanCardDetails | undefined;
      const list = details?.steps ?? [];
      if (list.length === 0) return undefined;
      const completed = list.filter((step) => step.completed).length;
      return cardComponent(
        (width) =>
          cardLines(list, theme, width, {
            title: "Plan complete",
            summary: summaryText(
              completed,
              list.length,
              details?.durationMs,
              details?.files?.length ?? 0,
            ),
            files: details?.files,
            expanded,
            final: true,
          }),
        outputPad,
      );
    },
  );

  // --- Clarifying questions ---

  // The model asks, the user answers in a selector (with a free-text option),
  // and the answer comes back as the tool result in the same run. This keeps
  // plan mode interactive without posting a question as plain text and then
  // interrupting with the "what next?" dialog.
  pi.registerTool({
    name: ASK_QUESTION_TOOL,
    label: "Ask question",
    description:
      "Ask the user a question and wait for the answer. Use it during planning when you need a decision, missing context or approval before writing the plan. Provide short suggested options: the user picks one or writes their own answer. Do not end your turn with an open question in plain text.",
    promptSnippet:
      "Ask the user a clarifying question with suggested options and wait for the answer",
    promptGuidelines: [
      "When you need input from the user, call ask_question instead of ending your turn with an open question in plain text.",
      "Keep ask_question options short (2-4) and mutually exclusive; the user can always write their own answer.",
      "Only ask when the answer changes the plan. Otherwise state your assumption and continue.",
    ],
    exposure: "model-only",
    // Two dialogs from parallel tool calls would fight for the terminal.
    executionMode: "sequential",
    // Asking is neither destructive nor open-world: permission extensions do
    // not need to confirm the question before the user sees it.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    // Pi accepts plain JSON Schema for custom tools (MCP tools use it too);
    // TypeBox's `TSchema` is only a compile-time shape.
    parameters: ASK_QUESTION_PARAMETERS as any,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const input = params as AskQuestionParams;
      const question = input?.question?.trim() ?? "";
      const result: QuestionAnswer = ctx.hasUI
        ? await askQuestion(ctx.ui, input, signal)
        : { question, cancelled: true, unavailable: true };

      return {
        content: [{ type: "text", text: answerText(result) }],
        details: result,
      };
    },
    renderCall(args, theme, { expanded }) {
      return linesComponent(
        questionCallLines(args as unknown as AskQuestionParams, theme, expanded),
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as QuestionAnswer | undefined;
      if (!details) {
        const text = result.content.find((item) => item.type === "text");
        return linesComponent([text?.type === "text" ? text.text : ""]);
      }
      return linesComponent(questionResultLines(details, theme, expanded));
    },
  });

  // --- CLI flag ---

  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only exploration)",
    type: "boolean",
    default: false,
  });

  // --- Commands ---

  pi.registerCommand("plan", {
    description: "Toggle plan mode. Also /plan on|off|status",
    handler: async (args, ctx) => {
      const word = args.trim().toLowerCase();
      if (word === "on") return setPlanMode(ctx, true);
      if (word === "off") return setPlanMode(ctx, false);
      if (word === "status") {
        const mode = modes.current() ?? "normal";
        const progress =
          steps.length > 0
            ? ` ${getCompletionStats(steps).completed}/${steps.length} steps done.`
            : "";
        ctx.ui.notify(`Plan mode is ${mode}.${progress}`, "info");
        return;
      }
      togglePlanMode(ctx);
    },
  });

  pi.registerCommand("plan:batch", {
    description: `Steps one subagent runs at once (default ${DEFAULT_BATCH})`,
    handler: async (args, ctx) => {
      const size = Number.parseInt(args.trim(), 10);
      if (!Number.isInteger(size) || size < 1) {
        ctx.ui.notify(
          `Each subagent runs up to ${batch} step${batch === 1 ? "" : "s"}. Use /plan:batch <n> to change it.`,
          "info",
        );
        return;
      }
      batch = size;
      persistState();
      ctx.ui.notify(
        `Each subagent now runs up to ${batch} step${batch === 1 ? "" : "s"}.`,
        "info",
      );
    },
  });

  pi.registerCommand("plan:status", {
    description: "Show current plan and progress",
    handler: async (_args, ctx) => {
      if (steps.length === 0) {
        ctx.ui.notify("No active plan. Use /plan to start.", "info");
        return;
      }
      const { completed, total } = getCompletionStats(steps);
      const list = steps
        .map((s) => `${s.completed ? "[x]" : "[ ]"} ${s.step}. ${s.text}`)
        .join("\n");
      ctx.ui.notify(
        `Plan (${modes.current() ?? "normal"}) — ${completed}/${total}\n\n${list}`,
        "info",
      );
    },
  });

  pi.registerCommand("plan:skip", {
    description: "Mark the current step done and move on",
    handler: async (_args, ctx) => {
      if (!modes.is("execute")) {
        ctx.ui.notify("No step is running.", "info");
        return;
      }
      const step = currentStep();
      if (!step) {
        finishPlan(ctx);
        return;
      }
      // The batch in flight belongs to one subagent: aborting it and marking
      // only this step is the closest thing to skipping one task.
      if (running) {
        skipped = step.step;
        running.abort();
        return;
      }
      step.completed = true;
      persistState();
      updateUI(ctx);
      await beginStep(ctx);
    },
  });

  pi.registerCommand("plan:done", {
    description: "Mark a step done without running it (default: the current one)",
    handler: async (args, ctx) => {
      if (steps.length === 0) {
        ctx.ui.notify("No plan to close. Use /plan to start one.", "info");
        return;
      }
      if (running) {
        // The batch in flight claims its steps when it ends: marking one now would
        // leave the runner and the checklist disagreeing about what it did.
        ctx.ui.notify("A subagent is working on the plan.", "info");
        return;
      }
      const asked = Number.parseInt(args.trim(), 10);
      const step = Number.isInteger(asked)
        ? steps.find((s) => s.step === asked)
        : currentStep();
      if (!step) {
        ctx.ui.notify(
          Number.isInteger(asked)
            ? `There is no step ${asked}.`
            : "Every step is done.",
          "info",
        );
        return;
      }
      // The plan can be finished by the main agent, not only by the batch runner:
      // this is the door for a step whose work happened outside `beginStep`.
      step.completed = true;
      persistState();
      updateUI(ctx);
      ctx.ui.notify(`Step ${step.step} marked done.`, "info");
      if (!currentStep()) finishPlan(ctx);
    },
  });

  pi.registerCommand("plan:stop", {
    description: "Leave the execution and keep the plan",
    handler: async (_args, ctx) => {
      const step = modes.is("execute") ? currentStep() : undefined;
      if (!step) {
        ctx.ui.notify("No step is running.", "info");
        return;
      }
      running?.abort();
      skipped = undefined;
      modes.leave(ctx);
      // Leaving keeps `steps` in memory, so persist them under `normal`:
      // `/plan:status` still shows the plan and `/plan:retry` resumes it.
      persistState();
      ctx.ui.notify(
        `Plan stopped at step ${step.step}; /plan:status to review.`,
        "info",
      );
    },
  });

  pi.registerCommand("plan:retry", {
    description: "Run the open step again",
    handler: async (_args, ctx) => {
      if (steps.length === 0) {
        ctx.ui.notify("No plan to run. Use /plan to start one.", "info");
        return;
      }
      if (!currentStep()) {
        ctx.ui.notify("Every step is done.", "info");
        return;
      }
      if (running) {
        ctx.ui.notify("A subagent is working on the plan.", "info");
        return;
      }
      // A step left open by an aborted or failed run has no other way back.
      if (!modes.is("execute")) modes.enter("execute", ctx);
      await beginStep(ctx);
    },
  });

  // --- Shortcut ---

  pi.registerShortcut("ctrl+alt+p", {
    description: "Toggle plan mode",
    handler: async (ctx) => togglePlanMode(ctx),
  });

  // --- After agent finishes: extract the plan ---

  pi.on("agent_end", async (event, ctx) => {
    if (!modes.is("plan") || !ctx.hasUI) return;

    // Extract todos from last assistant message
    const messages = event.messages as Array<{
      role: string;
      content?: unknown;
    }>;
    const lastAssistant = [...messages].reverse().find(
      (m) => m.role === "assistant" && Array.isArray(m.content)
    ) as { role: string; content: Array<{ type: string; text?: string }> } | undefined;

    if (lastAssistant) {
      const text = lastAssistant.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const extracted = extractPlanSteps(text);
      if (extracted.length > 0) {
        // A re-statement of the same plan keeps the ticks of the steps it repeats:
        // rewriting the list must not undo what is already done.
        steps = carryCompletion(steps, extracted);
        persistState();
        updateUI(ctx);
      }
    }

    // No plan yet means the assistant was still gathering context, most likely
    // by asking a question. Let the user answer in the editor instead of
    // interrupting with the execute dialog; once the answer produces a plan,
    // the next `agent_end` shows it with the usual choices.
    if (steps.length === 0) return;

    // Show plan and prompt for next action
    pi.sendMessage(
      {
        customType: "pi-plan-todo-list",
        content: `**Plan Steps (${steps.length}):**\n\n${steps
          .map((s) => `${s.step}. ${s.text}`)
          .join("\n")}`,
        display: true,
        details: {
          steps: steps.map((step) => ({ ...step })),
        } satisfies PlanCardDetails,
      },
      { triggerTurn: false }
    );

    const choice = await ctx.ui.select("Plan mode — what next?", [
      "Execute the plan",
      "Stay in plan mode",
      "Refine the plan",
    ]);

    if (choice === "Execute the plan") {
      startedAt = Date.now();
      filesTouched = new Set();
      modes.enter("execute", ctx);
      persistState();
      updateUI(ctx);

      // One batch at a time: the plan runs to the end, and each batch repaints
      // the checklist, so progress shows up between batches.
      await beginStep(ctx);
    } else if (choice === "Refine the plan") {
      const refinement = await ctx.ui.editor("Refine the plan:", "");
      if (refinement?.trim()) {
        // The refinement may replace the plan or ask a question of its own.
        // Clearing the steps keeps `agent_end` from offering the old plan
        // again before the model has replied.
        steps = [];
        persistState();
        updateUI(ctx);
        pi.sendUserMessage(refinement.trim());
      }
    }
  });

  // --- Restore state on session start/resume ---

  pi.on("session_start", async (_event, ctx) => {
    // The shared runtime already restored the mode and the tool set; this only
    // rebuilds the plan-specific state from the branch.
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type === "custom" &&
        (entry as { customType?: string }).customType === "pi-plan"
      ) {
        const data = (entry as { data?: PlanState }).data;
        if (data) {
          steps = data.steps ?? steps;
          startedAt = data.startedAt;
          filesTouched = new Set(data.files ?? []);
          if (data.batch) batch = data.batch;
        }
      }
    }

    // On resume in execute mode: the completed steps are already in the
    // persisted entry. Only a plan whose last batch died before the final card
    // needs closing here.
    if (modes.is("execute") && steps.length > 0 && !currentStep()) {
      finishPlan(ctx);
      return;
    }

    updateUI(ctx);
  });
}
