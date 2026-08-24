import { mkdir, mkdtemp, readFile, readdir, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import type { AppServerClient } from "./app-server-client.js";

export const allowedMethods = new Set([
  "account/read", "account/rateLimits/read", "model/list",
  "project/list", "project/read", "project/create", "project/update",
  "thread/list", "thread/read", "thread/start", "thread/resume", "thread/archive", "thread/unarchive", "thread/delete",
  "thread/name/set", "thread/goal/set", "thread/goal/get", "thread/goal/clear", "thread/search", "thread/rollback",
  "thread/metadata/update", "thread/fork", "turn/start", "turn/steer", "turn/interrupt",
]);

export function createLocalRpcHandler(appServer: AppServerClient): (method: string, params?: unknown) => Promise<unknown> {
  const chatWorkspaceRoot = resolve(tmpdir(), "codex-mesh-chat-workspaces");

  return async (method, params) => {
    if (method === "bridge/session/start") {
      const input = (params ?? {}) as Record<string, unknown>;
      await mkdir(chatWorkspaceRoot, { recursive: true, mode: 0o700 });
      const cwd = await mkdtemp(join(chatWorkspaceRoot, "session-"));
      const threadParams: Record<string, unknown> = {
        cwd,
        approvalPolicy: input.approvalPolicy ?? "on-request",
        sandbox: input.sandbox ?? "workspace-write",
      };
      if (typeof input.model === "string" && input.model) threadParams.model = input.model;
      return appServer.request("thread/start", threadParams);
    }
    if (method.startsWith("bridge/fs/")) return handleFileRpc(appServer, method, params);
    if (!allowedMethods.has(method)) throw new Error(`Method is not exposed: ${method}`);
    return appServer.request(method, params);
  };
}

async function handleFileRpc(appServer: AppServerClient, method: string, params: unknown): Promise<unknown> {
  const input = (params ?? {}) as { threadId?: unknown; path?: unknown };
  if (typeof input.threadId !== "string") throw new Error("threadId is required");
  if (input.path !== undefined && typeof input.path !== "string") throw new Error("path must be a string");
  const requestedPath = input.path || ".";
  const { absolutePath, relativePath } = await resolveThreadPath(appServer, input.threadId, requestedPath);

  if (method === "bridge/fs/readDirectory") {
    const entries = await readdir(absolutePath, { withFileTypes: true });
    const data = await Promise.all(entries.slice(0, 500).map(async (entry) => {
      const childPath = resolve(absolutePath, entry.name);
      const metadata = await stat(childPath).catch(() => undefined);
      return {
        name: entry.name,
        path: relativePath === "." ? entry.name : `${relativePath}/${entry.name}`,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        size: metadata?.size ?? null,
        modifiedAt: metadata ? Math.floor(metadata.mtimeMs / 1000) : null,
      };
    }));
    return { path: relativePath, entries: data.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1)) };
  }

  if (method === "bridge/fs/readFile") {
    const metadata = await stat(absolutePath);
    if (!metadata.isFile()) throw new Error("Path is not a file");
    const extension = extname(absolutePath).toLowerCase();
    const mimeType = imageMimeType(extension);
    const limit = mimeType ? 8 * 1024 * 1024 : 1024 * 1024;
    if (metadata.size > limit) throw new Error(`File exceeds preview limit (${Math.floor(limit / 1024 / 1024)} MB)`);
    const data = await readFile(absolutePath);
    if (mimeType) return { path: relativePath, kind: "image", mimeType, size: metadata.size, dataUrl: `data:${mimeType};base64,${data.toString("base64")}` };
    if (data.includes(0)) return { path: relativePath, kind: "binary", size: metadata.size };
    return { path: relativePath, kind: "text", size: metadata.size, content: data.toString("utf8") };
  }

  throw new Error(`Unknown bridge file method: ${method}`);
}

async function resolveThreadPath(appServer: AppServerClient, threadId: string, requestedPath: string): Promise<{ absolutePath: string; relativePath: string }> {
  const result = await appServer.request("thread/read", { threadId, includeTurns: false }) as { thread?: { cwd?: string } };
  if (!result.thread?.cwd) throw new Error("Thread working directory is unavailable");
  const root = await realpath(result.thread.cwd);
  const target = await realpath(resolve(root, requestedPath));
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) throw new Error("File path is outside the thread working directory");
  return { absolutePath: target, relativePath: fromRoot || "." };
}

function imageMimeType(extension: string): string | undefined {
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".avif": "image/avif" } as Record<string, string>)[extension];
}
