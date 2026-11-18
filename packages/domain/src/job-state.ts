import type { JobStatus } from "@jansee/contracts";

const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["inspecting", "failed", "cancelled"],
  inspecting: ["planning", "failed", "cancelled"],
  planning: ["rendering", "failed", "cancelled"],
  rendering: ["quality-check", "failed", "cancelled"],
  "quality-check": ["completed", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransitionJob(from, to)) {
    throw new Error(`Invalid job state transition: ${from} -> ${to}`);
  }
}

export function getAllowedJobTransitions(status: JobStatus): readonly JobStatus[] {
  return TRANSITIONS[status];
}
