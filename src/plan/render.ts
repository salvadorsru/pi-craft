/**
 * Presentation helpers for the plan checklist.
 *
 * Everything here returns themed strings built from plain segments, so the
 * same shapes feed the live widget, the transcript cards and `/plan:status`.
 * No pi-tui import is needed: widths are measured on the segments before any
 * ANSI styling is applied, which keeps the module testable on its own.
 */

import type { PlanStep } from "./types.js";

/** The slice of pi's theme this module uses. */
export type PlanColor =
  | "accent"
  | "success"
  | "warning"
  | "muted"
  | "dim"
  | "text"
  | "borderMuted";

/** Structural subset of pi's `Theme`, so tests can pass a plain fake. */
export interface PlanTheme {
  fg(color: PlanColor, text: string): string;
  bold(text: string): string;
}

interface Segment {
  text: string;
  color?: PlanColor;
  bold?: boolean;
}

/** Width of one code point, accounting for the usual wide and combining ranges. */
export function charWidth(char: string): number {
  const cp = char.codePointAt(0) ?? 0;
  if (cp === 0x200d || cp === 0xfe0f) return 0; // ZWJ, variation selector
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining marks
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function textWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charWidth(char);
  return width;
}

/** "2m 14s" / "1h 03m" / "42s". Kept compact for the one-line surfaces. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function barSegments(completed: number, total: number, width: number): Segment[] {
  if (width <= 0) return [];
  const ratio = total > 0 ? completed / total : 0;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  const segments: Segment[] = [];
  if (filled > 0) segments.push({ text: "#".repeat(filled), color: "success" });
  if (filled < width) segments.push({ text: "-".repeat(width - filled), color: "dim" });
  return segments;
}

/** A progress bar narrow enough to sit in the footer or a header. */
export function progressBar(
  completed: number,
  total: number,
  width: number,
  theme: PlanTheme,
): string {
  return renderSegments(barSegments(completed, total, width), theme);
}

function styleSegment(segment: Segment, theme: PlanTheme): string {
  const text = segment.bold ? theme.bold(segment.text) : segment.text;
  return segment.color ? theme.fg(segment.color, text) : text;
}

function renderSegments(segments: Segment[], theme: PlanTheme): string {
  return segments.map((segment) => styleSegment(segment, theme)).join("");
}

/** Cut a styled line to `width` cells, marking the cut with an ellipsis. */
function truncateSegments(
  segments: Segment[],
  width: number,
  theme: PlanTheme,
): string {
  if (width <= 0) return "";
  if (segmentsWidth(segments) <= width) return renderSegments(segments, theme);

  const limit = Math.max(0, width - 1);
  const kept: Segment[] = [];
  let used = 0;
  outer: for (const segment of segments) {
    let text = "";
    for (const char of segment.text) {
      const next = used + charWidth(char);
      if (next > limit) {
        if (text) kept.push({ ...segment, text });
        break outer;
      }
      text += char;
      used = next;
    }
    if (text) kept.push({ ...segment, text });
  }
  kept.push({ text: "…", color: "dim" });
  return renderSegments(kept, theme);
}

function segmentsWidth(segments: Segment[]): number {
  return segments.reduce((sum, segment) => sum + textWidth(segment.text), 0);
}

/** Split styled text into lines no wider than `width`, breaking on spaces. */
function wrapSegments(segments: Segment[], width: number): Segment[][] {
  if (width <= 0) return [segments];

  const chars: Array<{ char: string; segment: Segment }> = [];
  for (const segment of segments) {
    for (const char of segment.text) chars.push({ char, segment });
  }

  const lines: Segment[][] = [];
  let start = 0;

  while (start < chars.length) {
    let cells = 0;
    let end = start;
    let lastSpace = -1;

    while (end < chars.length) {
      const next = cells + charWidth(chars[end].char);
      if (next > width) break;
      cells = next;
      if (chars[end].char === " ") lastSpace = end;
      end++;
    }

    if (end < chars.length && lastSpace > start) end = lastSpace;
    // A single character wider than the line must still be consumed, or the
    // outer loop would never advance.
    if (end === start) end = start + 1;

    while (end > start && chars[end - 1].char === " ") end--;
    lines.push(mergeSegments(chars.slice(start, end)));

    start = end;
    while (start < chars.length && chars[start].char === " ") start++;
  }

  return lines.length > 0 ? lines : [[]];
}

function mergeSegments(chars: Array<{ char: string; segment: Segment }>): Segment[] {
  const merged: Segment[] = [];
  for (const { char, segment } of chars) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.color === segment.color &&
      last.bold === segment.bold
    ) {
      last.text += char;
    } else {
      merged.push({ ...segment, text: char });
    }
  }
  return merged;
}

function stepSegments(
  step: PlanStep,
  options: { completed: boolean; current: boolean; final?: boolean },
): Segment[] {
  const marker: Segment = options.completed
    ? { text: "[x] ", color: "success", bold: true }
    : options.current
      ? { text: "[>] ", color: "accent", bold: true }
      : { text: "[ ] ", color: "dim" };

  const number: Segment = {
    text: `${step.step}. `,
    color: options.completed
      ? options.final
        ? "muted"
        : "dim"
      : options.current
        ? "accent"
        : "muted",
  };

  const text: Segment = options.completed
    ? { text: step.text, color: options.final ? "text" : "dim" }
    : options.current
      ? { text: step.text, bold: true }
      : { text: step.text, color: "muted" };

  return [marker, number, text];
}

/** The footer counter: `2/3`. */
export function statusText(
  completed: number,
  total: number,
  theme: PlanTheme,
): string {
  return theme.fg("accent", `${completed}/${total}`);
}

/**
 * Checklist for the widget above the editor.
 *
 * A window of at most `MAX_STEPS` steps around the current one, so the widget
 * stays at `MAX_STEPS + 3` lines at most however long the plan is. The current
 * step is highlighted, completed steps stay readable but recede, and long text
 * is cut to the available width instead of wrapping.
 */
export function widgetLines(
  steps: PlanStep[],
  theme: PlanTheme,
  width: number,
  options: { progress?: boolean; current?: boolean } = {},
): string[] {
  if (steps.length === 0) return [];

  const completed = steps.filter((s) => s.completed).length;
  const total = steps.length;
  const showProgress = options.progress ?? true;
  const currentIndex =
    (options.current ?? true) ? steps.findIndex((s) => !s.completed) : -1;

  const header: Segment[] = [{ text: "Plan", color: "accent", bold: true }];

  if (showProgress) {
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
    const barWidth = Math.max(6, Math.min(18, width - 24));
    header.push(
      { text: "  " },
      ...barSegments(completed, total, barWidth),
      { text: `  ${completed}/${total}`, color: "muted" },
      { text: ` · ${percentage}%`, color: "dim" },
    );
  } else {
    header.push({ text: ` · ${total} step${total === 1 ? "" : "s"}`, color: "muted" });
  }

  // A window around the current step keeps the widget from growing to the
  // height of the plan: five rows are always enough to read the progress.
  const MAX_STEPS = 5;
  const anchor = currentIndex === -1 ? 0 : currentIndex;
  const start = Math.max(0, Math.min(anchor - 2, total - MAX_STEPS));
  const visible = steps.slice(start, start + MAX_STEPS);
  const above = start;
  const below = total - start - visible.length;

  const lines = [truncateSegments(header, width, theme)];

  if (above > 0) {
    lines.push(
      truncateSegments([{ text: `… ${above} above`, color: "dim" }], width, theme),
    );
  }

  visible.forEach((step, index) => {
    lines.push(
      truncateSegments(
        stepSegments(step, {
          completed: step.completed,
          current: start + index === currentIndex,
        }),
        width,
        theme,
      ),
    );
  });

  if (below > 0) {
    lines.push(
      truncateSegments([{ text: `… ${below} below`, color: "dim" }], width, theme),
    );
  }

  return lines;
}

export interface PlanCardOptions {
  title?: string;
  summary?: string;
  /** Paths touched while executing; shown only when expanded. */
  files?: string[];
  expanded?: boolean;
  /** Final card: completed steps stay in the normal text colour. */
  final?: boolean;
}

/**
 * Checklist for the transcript (plan preview, execution start, final card).
 *
 * Unlike the widget, step text wraps: this surface has room for the whole
 * step, so the completed list is what the user actually reads at the end.
 */
export function cardLines(
  steps: PlanStep[],
  theme: PlanTheme,
  width: number,
  options: PlanCardOptions = {},
): string[] {
  const lines: string[] = [];
  if (options.title) lines.push(theme.fg("accent", theme.bold(options.title)));
  if (options.summary) lines.push(theme.fg("muted", options.summary));

  const currentIndex = steps.findIndex((step) => !step.completed);

  if (steps.length > 0) {
    if (lines.length > 0) lines.push("");
    steps.forEach((step, index) => {
      const wrapped = wrapSegments(
        stepSegments(step, {
          completed: step.completed,
          current: index === currentIndex,
          final: options.final,
        }),
        width,
      );
      for (const line of wrapped) lines.push(renderSegments(line, theme));
    });
  }

  const files = options.files ?? [];
  if (files.length > 0 && options.expanded) {
    lines.push("");
    lines.push(theme.fg("muted", `${files.length} file${files.length === 1 ? "" : "s"} changed`));
    for (const file of files) lines.push(theme.fg("dim", `  ${file}`));
  }

  return lines;
}

/** `3/3 steps · 2m 14s · 4 files changed`. */
export function summaryText(
  completed: number,
  total: number,
  durationMs?: number,
  fileCount = 0,
): string {
  const parts = [`${completed}/${total} step${total === 1 ? "" : "s"}`];
  if (durationMs !== undefined) parts.push(formatDuration(durationMs));
  if (fileCount > 0) {
    parts.push(`${fileCount} file${fileCount === 1 ? "" : "s"} changed`);
  }
  return parts.join(" · ");
}
