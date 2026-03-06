export type WorkItemState = "todo" | "in_progress" | "blocked" | "done";

export interface NormalizedWorkItem {
  id: string;
  identifier?: string;
  number?: number;
  title: string;
  body?: string;
  description?: string;
  state: WorkItemState;
  priority?: number | null;
  labels: string[];
  blocked_by?: string[];
  assignees: string[];
  created_at?: string;
  updated_at?: string;
  url?: string;
  // backward-compatible aliases
  updatedAt?: string;
}

const STATE_ALIAS: Record<string, WorkItemState> = {
  todo: "todo",
  backlog: "todo",
  "to do": "todo",
  in_progress: "in_progress",
  inprogress: "in_progress",
  "in progress": "in_progress",
  blocked: "blocked",
  done: "done",
  completed: "done",
  closed: "done",
};

export function normalizeState(value: string): WorkItemState {
  const normalized = value.trim().toLowerCase();
  const mapped = STATE_ALIAS[normalized];
  if (!mapped) {
    return "todo";
  }
  return mapped;
}

export function sanitizeWorkspaceKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
