import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
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

if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && token.length < 24) {
  throw new Error("REMOTE_WEB_TOKEN must contain at least 24 characters when HOST is not loopback");
}

const allowedMethods = new Set([
  "account/read",
  "account/rateLimits/read",
  "model/list",
  "project/list",
  "thread/list",
  "thread/read",
  "thread/start",
  "thread/resume",
  "thread/archive",
  "thread/unarchive",
  "thread/name/set",
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
  response.json({ ok: true, appServer: Boolean(appServer.initialized) });
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
  send(ws, { type: "ready", version: "0.1.0", initialized: appServer.initialized });
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
