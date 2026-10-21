/**
 * Core types for plan-mode extension.
 */

export type PlanMode = "normal" | "plan" | "execute";

export interface PlanStep {
  step: number;
  text: string;
  completed: boolean;
}

export interface PlanState {
  mode: PlanMode;
  steps: PlanStep[];
  /** When execution started, so the final card can show how long it took. */
  startedAt?: number;
  /** Paths touched by edit/write while executing. */
  files?: string[];
}
