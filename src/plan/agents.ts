/**
 * Subagent runner for plan execution.
 *
 * A batch of steps runs in its own in-process session, so the work happens in
 * a clean context while the parent keeps the plan, the widget and the mode.
 * Spawning `pi` per batch would add a process start and make aborting harder.
 */

import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

export interface StepResult {
  text: string;
  files: string[];
  stopReason?: string;
  usedTools: boolean;
}

/** Runs one batch of steps and reports what the child did. */
export type StepRunner = (prompt: string, signal?: AbortSignal) => Promise<StepResult>;

function stopReasonOf(messages: readonly unknown[]): string | undefined {
  const last = [...messages].reverse().find(
    (message) => (message as { role?: string } | null)?.role === "assistant",
  );
  return (last as { stopReason?: string } | undefined)?.stopReason;
}

/** Asking the parent is not work: only real tools count as progress. */
function isWork(toolName: string): boolean {
  return toolName !== "ask_question";
}

export function createRunner(cwd: string): StepRunner {
  return async (prompt, signal) => {
    if (signal?.aborted) {
      return { text: "", files: [], stopReason: "aborted", usedTools: false };
    }

    const { session } = await createAgentSession({
      cwd,
      sessionManager: SessionManager.inMemory(cwd),
    });

    const files = new Set<string>();
    let usedTools = false;

    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "tool_execution_start" || !isWork(event.toolName)) return;
      usedTools = true;
      const path = (event.args as { path?: unknown } | undefined)?.path;
      if (
        (event.toolName === "edit" || event.toolName === "write") &&
        typeof path === "string" &&
        path.length > 0
      ) {
        files.add(path);
      }
    });

    const abort = () => void session.abort();
    signal?.addEventListener("abort", abort, { once: true });

    let text = "";
    let stopReason: string | undefined;
    try {
      await session.prompt(prompt);
      text = session.getLastAssistantText() ?? "";
      stopReason = stopReasonOf(session.messages);
    } finally {
      signal?.removeEventListener("abort", abort);
      unsubscribe();
      session.dispose();
    }

    return { text, files: [...files].sort(), stopReason, usedTools };
  };
}
