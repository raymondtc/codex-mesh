export type JsonObject = Record<string, unknown>;

export interface ThreadItem {
  id?: string;
  type: string;
  text?: string;
  content?: Array<{ type: string; text?: string; url?: string; path?: string }>;
  summary?: string[];
  command?: string;
  cwd?: string;
  status?: unknown;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  changes?: Array<{ path: string; kind: string | { type?: string; move_path?: string | null }; diff: string }>;
  server?: string;
  tool?: unknown;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

export interface Turn {
  id: string;
  items: ThreadItem[];
  status: string;
  error?: { message?: string } | null;
}

export interface Thread {
  id: string;
  sessionId?: string;
  forkedFromId?: string | null;
  name: string | null;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  status: unknown;
  turns: Turn[];
  projectId?: string | null;
  meshId?: string;
  machineId?: string;
  modelProvider?: string;
  gitInfo?: { sha?: string | null; branch?: string | null; originUrl?: string | null } | null;
  conversationKind?: "standard" | "side" | "fork" | "worktree";
  parentRemoteThreadId?: string | null;
  mainRoot?: string | null;
  worktreePath?: string | null;
  branch?: string | null;
}

export interface Machine {
  id: string;
  tenantId: string;
  name: string;
  kind: "local" | "ssh";
  online: boolean;
  codexVersion?: string | null;
  capabilities: string[];
  lastSeenAt?: string | null;
  sshHost?: string | null;
  sshPort?: number | null;
  sshUsername?: string | null;
  sshPublicKey?: string | null;
  sshHostKeySha256?: string | null;
  connectionMode?: "direct" | "reverse-ssh";
  tunnelPublicKey?: string | null;
}

export interface Project {
  id: string;
  name: string;
  roots: Array<{ path: string }>;
  metadata: Record<string, string | undefined>;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface ServerRequest {
  id: string | number;
  method: string;
  params: JsonObject;
}

export type ConnectionState = "connecting" | "ready" | "closed" | "error";

export interface ThreadGoal {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}
