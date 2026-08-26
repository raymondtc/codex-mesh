import { mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { AppServerClient } from "./app-server-client.js";

export const allowedMethods = new Set([
  "account/read", "account/rateLimits/read", "model/list",
  "project/list", "project/read", "project/create", "project/update",
  "thread/list", "thread/read", "thread/start", "thread/resume", "thread/archive", "thread/unarchive", "thread/delete",
  "thread/name/set", "thread/goal/set", "thread/goal/get", "thread/goal/clear", "thread/search", "thread/rollback",
  "thread/metadata/update", "thread/fork", "turn/start", "turn/steer", "turn/interrupt",
]);
const execFileAsync = promisify(execFile);

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
    if (method === "bridge/git/worktree/create") return createGitWorktree(appServer, params);
    if (method.startsWith("bridge/fs/")) return handleFileRpc(appServer, method, params);
    if (!allowedMethods.has(method)) throw new Error(`Method is not exposed: ${method}`);
    return appServer.request(method, params);
  };
}

async function createGitWorktree(appServer: AppServerClient, params: unknown): Promise<unknown> {
  const input = (params ?? {}) as { threadId?: unknown; branch?: unknown };
  if (typeof input.threadId !== "string") throw new Error("threadId is required");
  if (typeof input.branch !== "string" || !validBranch(input.branch)) throw new Error("分支名无效");
  const result = await appServer.request("thread/read", { threadId: input.threadId, includeTurns: false }) as { thread?: { cwd?: string } };
  if (!result.thread?.cwd) throw new Error("Thread working directory is unavailable");
  const cwd = await realpath(result.thread.cwd);
  const { stdout: rootOutput } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  const sourceRoot = (await realpath(rootOutput.trim()));
  const { stdout: worktrees } = await execFileAsync("git", ["-C", sourceRoot, "worktree", "list", "--porcelain"]);
  const mainEntry = worktrees.split(/\r?\n/).find((line) => line.startsWith("worktree "));
  const mainRoot = await realpath(mainEntry?.slice(9) || sourceRoot);
  const base = join(dirname(mainRoot), ".codex-mesh-worktrees", basename(mainRoot));
  const worktreePath = join(base, input.branch.replaceAll("/", "-").replaceAll(".", "-"));
  await mkdir(base, { recursive: true, mode: 0o700 });
  await execFileAsync("git", ["-C", sourceRoot, "worktree", "add", "-b", input.branch, worktreePath, "HEAD"]);
  return { sourceRoot, mainRoot, worktreePath, branch: input.branch };
}

function validBranch(value: string): boolean {
  return value.length <= 100 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.includes("..") && !value.includes("@{") && !value.endsWith("/") && !value.endsWith(".");
}

async function handleFileRpc(appServer: AppServerClient, method: string, params: unknown): Promise<unknown> {
  const input = (params ?? {}) as { threadId?: unknown; path?: unknown; dataBase64?: unknown; overwrite?: unknown };
  if (typeof input.threadId !== "string") throw new Error("threadId is required");
  if (input.path !== undefined && typeof input.path !== "string") throw new Error("path must be a string");
  const requestedPath = input.path || ".";
  if (method === "bridge/fs/writeFile") {
    const data = decodeUpload(input.dataBase64);
    const { absolutePath, relativePath } = await resolveNewThreadPath(appServer, input.threadId, requestedPath);
    await writeFile(absolutePath, data, { flag: input.overwrite === true ? "w" : "wx", mode: 0o600 });
    return { path: relativePath, absolutePath, size: data.length };
  }
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

  if (method === "bridge/fs/downloadFile") {
    const metadata = await stat(absolutePath);
    if (!metadata.isFile()) throw new Error("Path is not a file");
    if (metadata.size > 8 * 1024 * 1024) throw new Error("File exceeds download limit (8 MB)");
    const data = await readFile(absolutePath);
    return { path: relativePath, size: metadata.size, dataBase64: data.toString("base64"), mimeType: imageMimeType(extname(absolutePath).toLowerCase()) ?? "application/octet-stream" };
  }

  throw new Error(`Unknown bridge file method: ${method}`);
}

async function resolveNewThreadPath(appServer: AppServerClient, threadId: string, requestedPath: string): Promise<{ absolutePath: string; relativePath: string }> {
  if (!requestedPath || requestedPath === "." || requestedPath.startsWith("/") || requestedPath.split(/[\\/]/).includes("..")) throw new Error("Invalid upload path");
  const result = await appServer.request("thread/read", { threadId, includeTurns: false }) as { thread?: { cwd?: string } };
  if (!result.thread?.cwd) throw new Error("Thread working directory is unavailable");
  const root = await realpath(result.thread.cwd);
  if (dirname(requestedPath) === ".codex-mesh-uploads") await mkdir(resolve(root, ".codex-mesh-uploads"), { recursive: true, mode: 0o700 });
  const parent = await realpath(resolve(root, dirname(requestedPath)));
  assertWithinRoot(root, parent);
  const absolutePath = resolve(parent, basename(requestedPath));
  return { absolutePath, relativePath: relative(root, absolutePath) };
}

async function resolveThreadPath(appServer: AppServerClient, threadId: string, requestedPath: string): Promise<{ absolutePath: string; relativePath: string }> {
  const result = await appServer.request("thread/read", { threadId, includeTurns: false }) as { thread?: { cwd?: string } };
  if (!result.thread?.cwd) throw new Error("Thread working directory is unavailable");
  const root = await realpath(result.thread.cwd);
  const target = await realpath(resolve(root, requestedPath));
  const fromRoot = relative(root, target);
  assertWithinRoot(root, target);
  return { absolutePath: target, relativePath: fromRoot || "." };
}

function assertWithinRoot(root: string, target: string): void {
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) throw new Error("File path is outside the thread working directory");
}

function decodeUpload(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("dataBase64 must be valid base64");
  const data = Buffer.from(value, "base64");
  if (data.length === 0 || data.length > 8 * 1024 * 1024) throw new Error("Upload must be between 1 byte and 8 MB");
  return data;
}

function imageMimeType(extension: string): string | undefined {
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".avif": "image/avif" } as Record<string, string>)[extension];
}
