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
  changes?: unknown[];
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
  name: string | null;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  status: unknown;
  turns: Turn[];
  modelProvider?: string;
  gitInfo?: { branch?: string; repositoryUrl?: string } | null;
}

export interface ServerRequest {
  id: string | number;
  method: string;
  params: JsonObject;
}

export type ConnectionState = "connecting" | "ready" | "closed" | "error";
