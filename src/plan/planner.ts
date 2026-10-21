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
 * - a header that carries its own title: "Plan: move the tests" — whatever
 *   follows the colon on that line is a title, never a step.
 *
 * Only the list that follows the header is read. A rule, a heading or a
 * paragraph *before* the first item is a separator; after it, the first such
 * line ends the plan, so a later "Preguntas:" section with its own numbered
 * items is not mistaken for steps. A bold-wrapped number ("**1.** step") is
 * still a number: plans are written that way.
 */
export function extractPlanSteps(message: string): PlanStep[] {
  const items: PlanStep[] = [];

  // "Plan", "## Plan:", "**Plan:**", "Plan: with a title" — but not "Planning".
  const headerMatch = message.match(
    /(?:^|\n)[ \t]*(?:#{1,6}[ \t]+)?\*{0,2}Plan\*{0,2}[ \t]*(?:[:：][^\n]*)?\n/i,
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

  const rule = /^[ \t]*(?:[-*_][ \t]*){3,}$/;
  const heading = /^[ \t]*(?:#{1,6}[ \t]+\S.*|\*{1,2}[^*\n]+\*{1,2}[ \t]*)$/;

  for (const line of lines) {
    // A bold-wrapped number is still a number.
    const numbered = line.match(
      /^[ \t]*(?:\*{1,2})?(\d+)[.)](?:\*{1,2})?[ \t]+(.+?)\*{0,2}$/,
    );
    if (numbered) {
      inList = true;
      push(numbered[2]);
      continue;
    }

    const bullet = line.match(/^[ \t]*[-*][ \t]+(.+)$/);
    if (bullet) {
      inList = true;
      push(bullet[1]);
      continue;
    }

    // Blank lines and rules separate anywhere; a heading only before the list.
    if (/^\s*$/.test(line) || rule.test(line)) continue;
    if (!inList && heading.test(line)) continue;

    // A wrapped continuation of the previous item, e.g. an indented line.
    if (inList && /^\s+/.test(line) && items.length > 0) {
      const last = items[items.length - 1];
      last.text = cleanStepText(`${last.text} ${line.trim()}`);
      continue;
    }

    // Anything else is a paragraph or a new section: the plan has ended.
    break;
  }

  return items;
}
