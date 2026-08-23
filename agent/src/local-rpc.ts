import { mkdir, mkdtemp, readFile, readdir, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import type { AppServerClient } from "./app-server-client.js";

const allowedMethods = new Set(["account/read", "account/rateLimits/read", "model/list", "project/list", "project/read", "project/create", "project/update", "thread/list", "thread/read", "thread/start", "thread/resume", "thread/archive", "thread/unarchive", "thread/delete", "thread/name/set", "thread/goal/set", "thread/goal/get", "thread/goal/clear", "thread/search", "thread/rollback", "thread/metadata/update", "thread/fork", "turn/start", "turn/steer", "turn/interrupt"]);
const imageTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".avif": "image/avif" };

export function createLocalRpcHandler(appServer: AppServerClient) {
  return async (method: string, params?: unknown): Promise<unknown> => {
    if (method === "bridge/session/start") {
      const input = (params ?? {}) as Record<string, unknown>;
      const root = resolve(tmpdir(), "codex-mesh-chat-workspaces");
      await mkdir(root, { recursive: true, mode: 0o700 });
      const cwd = await mkdtemp(join(root, "session-"));
      return appServer.request("thread/start", { cwd, approvalPolicy: "on-request", sandbox: "workspace-write", ...(typeof input.model === "string" ? { model: input.model } : {}) });
    }
    if (method.startsWith("bridge/fs/")) return fileRpc(appServer, method, params);
    if (!allowedMethods.has(method)) throw new Error(`Method is not exposed: ${method}`);
    return appServer.request(method, params);
  };
}

async function fileRpc(appServer: AppServerClient, method: string, params: unknown): Promise<unknown> {
  const input = (params ?? {}) as { threadId?: unknown; path?: unknown };
  if (typeof input.threadId !== "string") throw new Error("threadId is required");
  if (input.path !== undefined && typeof input.path !== "string") throw new Error("path must be a string");
  const thread = await appServer.request("thread/read", { threadId: input.threadId, includeTurns: false }) as { thread?: { cwd?: string } };
  if (!thread.thread?.cwd) throw new Error("Thread working directory is unavailable");
  const root = await realpath(thread.thread.cwd);
  const target = await realpath(resolve(root, input.path || "."));
  const path = relative(root, target);
  if (path === ".." || path.startsWith(`..${sep}`)) throw new Error("File path is outside the thread working directory");
  if (method === "bridge/fs/readDirectory") {
    const entries = await readdir(target, { withFileTypes: true });
    return { path: path || ".", entries: await Promise.all(entries.slice(0, 500).map(async (entry) => { const metadata = await stat(resolve(target, entry.name)).catch(() => undefined); return { name: entry.name, path: path ? `${path}/${entry.name}` : entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other", size: metadata?.size ?? null, modifiedAt: metadata ? Math.floor(metadata.mtimeMs / 1000) : null }; })) };
  }
  if (method === "bridge/fs/readFile") {
    const metadata = await stat(target);
    if (!metadata.isFile()) throw new Error("Path is not a file");
    const mimeType = imageTypes[extname(target).toLowerCase()];
    const limit = mimeType ? 8 * 1024 * 1024 : 1024 * 1024;
    if (metadata.size > limit) throw new Error("File exceeds preview limit");
    const data = await readFile(target);
    if (mimeType) return { path: path || ".", kind: "image", mimeType, size: metadata.size, dataUrl: `data:${mimeType};base64,${data.toString("base64")}` };
    if (data.includes(0)) return { path: path || ".", kind: "binary", size: metadata.size };
    return { path: path || ".", kind: "text", size: metadata.size, content: data.toString("utf8") };
  }
  throw new Error(`Unknown bridge method: ${method}`);
}
