import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { AppServerClient } from "./app-server-client.js";
import type { BridgeMessage, BrowserMessage, RpcRequest } from "./protocol.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);
const token = process.env.REMOTE_WEB_TOKEN ?? "";
const codexBin = process.env.CODEX_BIN ?? "codex";
const codexCwd = process.env.CODEX_CWD;
const configuredAppServerUrl = process.env.CODEX_APP_SERVER_URL;
const codexHome = process.env.CODEX_HOME ?? resolve(homedir(), ".codex");
const daemonSocket = resolve(codexHome, "app-server-control/app-server-control.sock");
const appServerUrl = configuredAppServerUrl ?? (existsSync(daemonSocket) ? `unix://${daemonSocket}` : undefined);
const chatWorkspaceRoot = resolve(tmpdir(), "codex-remote-chat-workspaces");
const bridgeVersion = "0.2.0";
const bridgeCapabilities = ["bridge/session/start", "bridge/fs/readDirectory", "bridge/fs/readFile"];

if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && token.length < 24) {
  throw new Error("REMOTE_WEB_TOKEN must contain at least 24 characters when HOST is not loopback");
}

const allowedMethods = new Set([
  "account/read",
  "account/rateLimits/read",
  "model/list",
  "project/list",
  "project/read",
  "project/create",
  "project/update",
  "thread/list",
  "thread/read",
  "thread/start",
  "thread/resume",
  "thread/archive",
  "thread/unarchive",
  "thread/delete",
  "thread/name/set",
  "thread/goal/set",
  "thread/goal/get",
  "thread/goal/clear",
  "thread/search",
  "thread/rollback",
  "thread/metadata/update",
  "thread/fork",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
]);

const appServer = new AppServerClient(codexBin, codexCwd, appServerUrl, !configuredAppServerUrl);
appServer.on("stderr", (value) => process.stderr.write(`[app-server] ${value}`));

const app = express();
app.disable("x-powered-by");
app.get("/api/health", (_request, response) => {
  response.json({ ok: true, version: bridgeVersion, capabilities: bridgeCapabilities, appServer: Boolean(appServer.initialized) });
});

const currentDir = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(currentDir, "../../web/dist");
if (existsSync(staticDir)) {
  app.use(express.static(staticDir, { index: false, maxAge: "1h" }));
  app.get("/{*path}", (_request, response) => response.sendFile(resolve(staticDir, "index.html")));
}

const server = createServer(app);
const sockets = new Set<WebSocket>();
const aliveSockets = new WeakSet<WebSocket>();
const pendingServerRequests = new Set<string>();
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
});

wss.on("connection", (ws) => {
  aliveSockets.add(ws);
  ws.on("pong", () => aliveSockets.add(ws));
  let authenticated = token.length === 0;
  const authTimer = setTimeout(() => ws.close(4401, "Authentication timeout"), 5_000);

  if (authenticated) {
    clearTimeout(authTimer);
    finishAuth(ws);
  }

  ws.on("message", async (raw) => {
    let message: BrowserMessage;
    try {
      message = JSON.parse(String(raw)) as BrowserMessage;
    } catch {
      ws.close(4400, "Invalid JSON");
      return;
    }

    if (!authenticated) {
      if (message.type !== "auth" || !safeTokenEqual(token, message.token)) {
        ws.close(4401, "Invalid token");
        return;
      }
      authenticated = true;
      clearTimeout(authTimer);
      finishAuth(ws);
      return;
    }

    if (message.type === "rpc") {
      if (message.method === "bridge/session/start") {
        try {
          const result = await startChatSession(message.params);
          send(ws, { type: "rpcResult", id: message.id, result });
        } catch (error) {
          send(ws, { type: "rpcResult", id: message.id, error: { message: error instanceof Error ? error.message : String(error) } });
        }
        return;
      }
      if (message.method.startsWith("bridge/fs/")) {
        try {
          const result = await handleFileRpc(message.method, message.params);
          send(ws, { type: "rpcResult", id: message.id, result });
        } catch (error) {
          send(ws, { type: "rpcResult", id: message.id, error: { message: error instanceof Error ? error.message : String(error) } });
        }
        return;
      }
      if (!allowedMethods.has(message.method)) {
        send(ws, { type: "rpcResult", id: message.id, error: { message: `Method is not exposed: ${message.method}` } });
        return;
      }
      try {
        const result = await appServer.request(message.method, message.params);
        send(ws, { type: "rpcResult", id: message.id, result });
      } catch (error) {
        send(ws, {
          type: "rpcResult",
          id: message.id,
          error: { message: error instanceof Error ? error.message : String(error) },
        });
      }
      return;
    }

    if (message.type === "serverResponse") {
      const requestId = String(message.id);
      if (!pendingServerRequests.delete(requestId)) return;
      appServer.respond(message.id, message.result, message.error);
      broadcast({ type: "event", method: "bridge/serverRequestResolved", params: { id: message.id } });
    }
  });

  ws.on("close", () => {
    clearTimeout(authTimer);
    sockets.delete(ws);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of sockets) {
    if (!aliveSockets.has(ws)) {
      ws.terminate();
      continue;
    }
    aliveSockets.delete(ws);
    ws.ping();
  }
}, 25_000);
heartbeat.unref();

function finishAuth(ws: WebSocket): void {
  sockets.add(ws);
  send(ws, { type: "ready", version: bridgeVersion, capabilities: bridgeCapabilities, initialized: appServer.initialized });
}

function safeTokenEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(ws: WebSocket, message: BridgeMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function broadcast(message: BridgeMessage): void {
  for (const ws of sockets) send(ws, message);
}

async function startChatSession(params: unknown): Promise<unknown> {
  const input = (params ?? {}) as Record<string, unknown>;
  await mkdir(chatWorkspaceRoot, { recursive: true, mode: 0o700 });
  const cwd = await mkdtemp(join(chatWorkspaceRoot, "session-"));
  const threadParams: Record<string, unknown> = {
    cwd,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  };
  if (typeof input.model === "string" && input.model) threadParams.model = input.model;
  return appServer.request("thread/start", threadParams);
}

async function handleFileRpc(method: string, params: unknown): Promise<unknown> {
  const input = (params ?? {}) as { threadId?: unknown; path?: unknown };
  if (typeof input.threadId !== "string") throw new Error("threadId is required");
  if (input.path !== undefined && typeof input.path !== "string") throw new Error("path must be a string");
  const requestedPath = input.path || ".";
  const { absolutePath, relativePath } = await resolveThreadPath(input.threadId, requestedPath);

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

async function resolveThreadPath(threadId: string, requestedPath: string): Promise<{ absolutePath: string; relativePath: string }> {
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

appServer.on("notification", (notification: { method: string; params?: unknown }) => {
  broadcast({ type: "event", method: notification.method, params: notification.params });
});

appServer.on("serverRequest", (request: RpcRequest) => {
  if (request.method === "currentTime/read") {
    appServer.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
    return;
  }
  if (sockets.size === 0) {
    appServer.respond(request.id, undefined, { message: "No authenticated reviewer is connected" });
    return;
  }
  pendingServerRequests.add(String(request.id));
  broadcast({ type: "serverRequest", id: request.id, method: request.method, params: request.params });
});

appServer.on("exit", (error: Error) => broadcast({ type: "fatal", message: error.message }));

async function main(): Promise<void> {
  await appServer.start();
  server.listen(port, host, () => {
    console.log(`Codex Remote Web listening on http://${host}:${port}`);
    if (!token) console.warn("No REMOTE_WEB_TOKEN is set; access is allowed because the server is loopback-only.");
  });
}

function shutdown(): void {
  clearInterval(heartbeat);
  for (const ws of sockets) ws.close(1001, "Server shutting down");
  server.close();
  appServer.stop();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
