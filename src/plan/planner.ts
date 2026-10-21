/**
 * Plan extraction from LLM output.
 * Extracts numbered plan steps from assistant messages.
 */

import type { PlanStep } from "./types.js";

/**
 * Clean step text by removing markdown formatting and normalizing.
 *
 * The full text is kept here: truncation is a display concern. A step that is
 * cut down to "src/foo.rs:5..." is useless both to the model executing the
 * plan and to the user reading it.
 */
export function cleanStepText(text: string): string {
  let cleaned = text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
    .replace(/`([^`]+)`/g, "$1") // Remove inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // Remove links, keep text
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  return cleaned;
}

/**
 * Shorten a step for a one-line surface (the widget, `/plan:status`). Never
 * call this before storing the step: `PlanStep.text` keeps the whole thing.
 */
export function displayStepText(text: string, max = 100): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

/** A question is not an implementation step. */
function looksLikeQuestion(text: string): boolean {
  if (/^¿.*\?$/.test(text)) return true;
  return /^(?:what|how|why|when|where|who|which|should|do|does|can|could|would|will|is|are|shall|may|might)\b.*\?$/i.test(
    text,
  );
}

/**
 * Extract plan steps from LLM output text.
 *
 * Supports multiple plan header formats:
 * - "Plan:" / "## Plan" / "### Plan" / "**Plan:**"
 *
 * Only the list that follows the header is read. The first heading or
 * paragraph after that list ends it, so a later "Preguntas:" / "Notes:"
 * section with its own numbered items is not mistaken for steps.
 */
export function extractPlanSteps(message: string): PlanStep[] {
  const items: PlanStep[] = [];

  // Match various "Plan:" header formats. The colon is optional so
  // "## Plan" (a heading without one) also works.
  const headerMatch = message.match(
    /(?:^|\n)\s*(?:#{1,3}\s+)?\*{0,2}Plan\*{0,2}\s*[:：]?\s*\*{0,2}\s*\n/i,
  );
  if (!headerMatch) return items;

  const startIndex = message.indexOf(headerMatch[0]) + headerMatch[0].length;
  const lines = message.slice(startIndex).split(/\r?\n/);

  let inList = false;

  const push = (raw: string): void => {
    const text = cleanStepText(raw);
    if (text.length < 4 || looksLikeQuestion(text)) return;
    items.push({ step: items.length + 1, text, completed: false });
  };

  for (const line of lines) {
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (numbered) {
      inList = true;
      push(numbered[2]);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      inList = true;
      push(bullet[1]);
      continue;
    }

    // Blank lines are allowed between items.
    if (/^\s*$/.test(line)) continue;

    // A wrapped continuation of the previous item, e.g. an indented line.
    if (inList && /^\s+/.test(line) && items.length > 0) {
      const last = items[items.length - 1];
      last.text = cleanStepText(`${last.text} ${line.trim()}`);
      continue;
    }

    // Anything else is a heading, a paragraph, or a new section: the plan
    // list has ended. Do not keep scanning the rest of the message.
    break;
  }

  return items;
}
