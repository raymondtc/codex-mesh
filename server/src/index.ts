import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import express, { type Request } from "express";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { WebSocket, WebSocketServer } from "ws";
import { auth, type AuthSession } from "./auth.js";
import { AppServerClient } from "./app-server-client.js";
import { closeDatabase, databaseKind, migrateDatabase } from "./db/database.js";
import { createLocalRpcHandler } from "./local-rpc.js";
import { AgentMachineTransport, LocalMachineTransport, MachineRegistry, type MachineTransport } from "./machine-registry.js";
import {
  authenticateMachine, createMachineEnrollment, ensureFirstUserAdmin, ensureLocalMachine, getUserRole, listMachines, listUsers,
  machineBelongsToUser, redeemMachineEnrollment, resolveConversation, revokeMachine, updateMachinePresence,
  updateUserRole, upsertConversation, getUserSettings, updateUserSettings, type MachineRecord, type UserSettings,
} from "./repository.js";
import type { BridgeMessage, BrowserMessage, RpcRequest } from "./protocol.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);
const codexBin = process.env.CODEX_BIN ?? "codex";
const codexCwd = process.env.CODEX_CWD;
const configuredAppServerUrl = process.env.CODEX_APP_SERVER_URL;
const codexHome = process.env.CODEX_HOME ?? resolve(homedir(), ".codex");
const daemonSocket = resolve(codexHome, "app-server-control/app-server-control.sock");
const appServerUrl = configuredAppServerUrl ?? (existsSync(daemonSocket) ? `unix://${daemonSocket}` : undefined);
const localMachineEnabled = process.env.CODEX_LOCAL_MACHINE !== "off";
const bridgeVersion = "0.3.0";
const bridgeCapabilities = ["bridge/session/start", "bridge/fs/readDirectory", "bridge/fs/readFile", "bridge/machine/list", "bridge/machine/select", "bridge/machine/enrollment/create", "bridge/conversation/resolve"];
const trustedOrigins = new Set((process.env.TRUSTED_ORIGINS ?? process.env.BETTER_AUTH_URL ?? `http://127.0.0.1:${port}`).split(",").map((value) => value.trim()).filter(Boolean));

interface BrowserContext { userId: string; machineId?: string }
interface AgentContext { machine: MachineRecord }

const appServer = new AppServerClient(codexBin, codexCwd, appServerUrl, !configuredAppServerUrl);
const localTransport = new LocalMachineTransport(appServer, createLocalRpcHandler(appServer));
const registry = new MachineRegistry();
const browserContexts = new Map<WebSocket, BrowserContext>();
const machineOwners = new Map<string, string>();
const pendingServerRequests = new Map<string, { machineId: string; requestId: string | number }>();
const browserSessionBySocket = new WeakMap<WebSocket, AuthSession>();
const agentContextBySocket = new WeakMap<WebSocket, AgentContext>();
const aliveSockets = new WeakSet<WebSocket>();
const pairingAttempts = new Map<string, { count: number; resetAt: number }>();

appServer.on("stderr", (value) => process.stderr.write(`[app-server] ${value}`));

const app = express();
app.disable("x-powered-by");
app.all("/api/auth/*splat", toNodeHandler(auth));
app.use(express.json({ limit: "256kb" }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, version: bridgeVersion, database: databaseKind, capabilities: bridgeCapabilities, localAppServer: localMachineEnabled ? Boolean(appServer.initialized) : false });
});

app.get("/api/me", async (request, response) => {
  const session = await requestSession(request);
  if (!session) return response.status(401).json({ error: "Unauthorized" });
  await ensureFirstUserAdmin(session.user.id);
  return response.json({ ...session, user: { ...session.user, role: await getUserRole(session.user.id) } });
});

app.get("/api/settings", async (request, response) => {
  const session = await requestSession(request);
  if (!session) return response.status(401).json({ error: "Unauthorized" });
  const settings = await getUserSettings(session.user.id);
  return settings ? response.json(settings) : response.status(404).json({ error: "User not found" });
});

app.patch("/api/settings", async (request, response) => {
  const session = await requestSession(request);
  if (!session) return response.status(401).json({ error: "Unauthorized" });
  const permission = request.body?.defaultPermission;
  const model = request.body?.defaultModel;
  const effort = request.body?.defaultReasoningEffort;
  if (!["read-only", "workspace-write", "full-access"].includes(permission)) return response.status(400).json({ error: "Invalid default permission" });
  if (model !== null && (typeof model !== "string" || model.length > 128)) return response.status(400).json({ error: "Invalid default model" });
  if (!["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) return response.status(400).json({ error: "Invalid reasoning effort" });
  const settings: UserSettings = { defaultPermission: permission, defaultModel: model || null, defaultReasoningEffort: effort };
  const updated = await updateUserSettings(session.user.id, settings);
  return updated ? response.json(updated) : response.status(404).json({ error: "User not found" });
});

app.get("/api/users", async (request, response) => {
  const session = await requestSession(request);
  if (!session) return response.status(401).json({ error: "Unauthorized" });
  await ensureFirstUserAdmin(session.user.id);
  if (await getUserRole(session.user.id) !== "admin") return response.status(403).json({ error: "Admin access required" });
  return response.json({ data: await listUsers() });
});

app.patch("/api/users/:id/role", async (request, response) => {
  const session = await requestSession(request);
  if (!session) return response.status(401).json({ error: "Unauthorized" });
  await ensureFirstUserAdmin(session.user.id);
  if (await getUserRole(session.user.id) !== "admin") return response.status(403).json({ error: "Admin access required" });
  const role = request.body?.role;
  if (role !== "admin" && role !== "user") return response.status(400).json({ error: "role must be admin or user" });
  if (request.params.id === session.user.id && role !== "admin") return response.status(400).json({ error: "You cannot remove your own admin role" });
  return response.json({ updated: await updateUserRole(request.params.id, role) });
});

app.post("/api/agent/pair", async (request, response) => {
  if (!consumePairingAttempt(request.ip ?? "unknown")) return response.status(429).json({ error: "Too many pairing attempts" });
  try {
    const result = await redeemMachineEnrollment(String(request.body?.code ?? ""), String(request.body?.name ?? "Codex Machine"));
    return response.json({ machineId: result.machine.id, credential: result.credential });
  } catch (error) {
    return response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const currentDir = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(currentDir, "../../web/dist");
if (existsSync(staticDir)) {
  app.use(express.static(staticDir, { index: false, maxAge: "1h" }));
  app.get("/{*path}", (_request, response) => response.sendFile(resolve(staticDir, "index.html")));
}

const server = createServer(app);
const browserWss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
const agentWss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

server.on("upgrade", (request, socket, head) => {
  void handleUpgrade(request, socket, head).catch(() => rejectUpgrade(socket, 500, "Internal Server Error"));
});

browserWss.on("connection", (ws) => {
  const session = browserSessionBySocket.get(ws);
  if (!session) return ws.close(4401, "Unauthorized");
  aliveSockets.add(ws);
  ws.on("pong", () => aliveSockets.add(ws));
  void initializeBrowser(ws, session);
  ws.on("message", (raw) => void handleBrowserMessage(ws, raw));
  ws.on("close", () => browserContexts.delete(ws));
});

agentWss.on("connection", (ws) => {
  const context = agentContextBySocket.get(ws);
  if (!context) return ws.close(4401, "Unauthorized");
  aliveSockets.add(ws);
  ws.on("pong", () => aliveSockets.add(ws));
  const transport = new AgentMachineTransport(ws);
  registerMachine(context.machine, transport);
  void updateMachinePresence(context.machine.id);
  transport.on("hello", (hello: { agentVersion?: string; codexVersion?: string; capabilities?: string[] }) => {
    void updateMachinePresence(context.machine.id, { agentVersion: hello.agentVersion, codexVersion: hello.codexVersion, capabilities: Array.isArray(hello.capabilities) ? hello.capabilities : [] });
  });
  ws.send(JSON.stringify({ type: "ready", version: bridgeVersion, machineId: context.machine.id }));
});

const heartbeat = setInterval(() => {
  for (const ws of [...browserContexts.keys(), ...agentWss.clients]) {
    if (!aliveSockets.has(ws)) { ws.terminate(); continue; }
    aliveSockets.delete(ws);
    ws.ping();
  }
}, 25_000);
heartbeat.unref();

async function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname === "/agent/ws") {
    const credential = parseAgentAuthorization(request.headers.authorization);
    if (!credential) return rejectUpgrade(socket, 401, "Unauthorized");
    const machine = await authenticateMachine(credential.machineId, credential.secret);
    if (!machine) return rejectUpgrade(socket, 401, "Unauthorized");
    agentWss.handleUpgrade(request, socket, head, (ws) => {
      agentContextBySocket.set(ws, { machine });
      agentWss.emit("connection", ws, request);
    });
    return;
  }
  if (url.pathname !== "/ws") return rejectUpgrade(socket, 404, "Not Found");
  const origin = request.headers.origin;
  if (origin && !isTrustedOrigin(origin)) return rejectUpgrade(socket, 403, "Forbidden");
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session) return rejectUpgrade(socket, 401, "Unauthorized");
  browserWss.handleUpgrade(request, socket, head, (ws) => {
    browserSessionBySocket.set(ws, session);
    browserWss.emit("connection", ws, request);
  });
}

async function initializeBrowser(ws: WebSocket, session: AuthSession): Promise<void> {
  await ensureFirstUserAdmin(session.user.id);
  if (localMachineEnabled) {
    const localMachine = await ensureLocalMachine(session.user.id);
    if (localMachine && !registry.isOnline(localMachine.id)) registerMachine(localMachine, localTransport);
  }
  const available = await listMachines(session.user.id);
  const defaultMachine = available.find((machine) => registry.isOnline(machine.id)) ?? available[0];
  browserContexts.set(ws, { userId: session.user.id, machineId: defaultMachine?.id });
  send(ws, { type: "ready", version: bridgeVersion, capabilities: bridgeCapabilities, initialized: { user: session.user, machineId: defaultMachine?.id ?? null } });
}

async function handleBrowserMessage(ws: WebSocket, raw: WebSocket.RawData): Promise<void> {
  const context = browserContexts.get(ws);
  if (!context) return;
  let message: BrowserMessage;
  try { message = JSON.parse(String(raw)) as BrowserMessage; } catch { return ws.close(4400, "Invalid JSON"); }
  if (message.type === "rpc") {
    try {
      const result = await handleBrowserRpc(context, message.method, message.params);
      send(ws, { type: "rpcResult", id: message.id, result });
    } catch (error) {
      send(ws, { type: "rpcResult", id: message.id, error: { message: error instanceof Error ? error.message : String(error) } });
    }
    return;
  }
  if (message.type === "serverResponse") {
    const pending = pendingServerRequests.get(String(message.id));
    if (!pending || pending.machineId !== context.machineId) return;
    pendingServerRequests.delete(String(message.id));
    registry.get(pending.machineId)?.respond(pending.requestId, message.result, message.error);
    broadcastToMachine(pending.machineId, { type: "event", method: "bridge/serverRequestResolved", params: { id: message.id } });
  }
}

async function handleBrowserRpc(context: BrowserContext, method: string, params: unknown): Promise<unknown> {
  const input = (params ?? {}) as Record<string, unknown>;
  if (method === "bridge/machine/list") return { data: await machineViews(context.userId) };
  if (method === "bridge/machine/select") {
    if (typeof input.machineId !== "string" || !await machineBelongsToUser(input.machineId, context.userId)) throw new Error("Machine not found");
    context.machineId = input.machineId;
    return { machineId: input.machineId, online: registry.isOnline(input.machineId) };
  }
  if (method === "bridge/machine/enrollment/create") return createMachineEnrollment(context.userId);
  if (method === "bridge/machine/revoke") {
    if (typeof input.machineId !== "string") throw new Error("machineId is required");
    const revoked = await revokeMachine(context.userId, input.machineId);
    if (revoked) registry.unregister(input.machineId);
    if (context.machineId === input.machineId) context.machineId = undefined;
    return { revoked };
  }
  if (method === "bridge/conversation/resolve") {
    if (typeof input.conversationId !== "string") throw new Error("conversationId is required");
    const conversation = await resolveConversation(context.userId, input.conversationId);
    if (!conversation) throw new Error("Conversation not found");
    context.machineId = conversation.machineId;
    const result = await requireMachine(conversation.machineId).request("thread/read", { threadId: conversation.remoteThreadId, includeTurns: false });
    return decorateRpcResult(context.userId, conversation.machineId, "thread/read", result);
  }

  const machineId = typeof input.__machineId === "string" ? input.__machineId : context.machineId;
  if (!machineId || !await machineBelongsToUser(machineId, context.userId)) throw new Error("Select an available machine first");
  context.machineId = machineId;
  const forwardedParams = { ...input };
  delete forwardedParams.__machineId;
  const result = await requireMachine(machineId).request(method, forwardedParams);
  return decorateRpcResult(context.userId, machineId, method, result);
}

async function decorateRpcResult(userId: string, machineId: string, method: string, result: unknown): Promise<unknown> {
  if (!result || typeof result !== "object") return result;
  const record = result as Record<string, unknown>;
  if (method === "thread/list" && Array.isArray(record.data)) return { ...record, data: await Promise.all(record.data.map((thread) => upsertConversation(userId, machineId, thread as Record<string, unknown>))) };
  if (record.thread && typeof record.thread === "object") return { ...record, thread: await upsertConversation(userId, machineId, record.thread as Record<string, unknown>) };
  return result;
}

function registerMachine(machine: MachineRecord, transport: MachineTransport): void {
  registry.register(machine.id, transport);
  machineOwners.set(machine.id, machine.ownerUserId);
  transport.on("notification", (notification: { method: string; params?: unknown }) => {
    broadcastToMachine(machine.id, { type: "event", method: notification.method, params: addMachineId(notification.params, machine.id) });
  });
  transport.on("serverRequest", (request: RpcRequest) => {
    if (request.method === "currentTime/read") return transport.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
    const recipients = browserRecipients(machine.id);
    if (!recipients.length) return transport.respond(request.id, undefined, { message: "No authenticated reviewer is connected" });
    const proxyId = randomUUID();
    pendingServerRequests.set(proxyId, { machineId: machine.id, requestId: request.id });
    for (const ws of recipients) send(ws, { type: "serverRequest", id: proxyId, method: request.method, params: addMachineId(request.params, machine.id) });
  });
  transport.on("exit", (error: Error) => broadcastToMachine(machine.id, { type: "fatal", message: error.message }));
}

function requireMachine(machineId: string): MachineTransport {
  const machine = registry.get(machineId);
  if (!machine) throw new Error("Machine is offline");
  return machine;
}

async function machineViews(userId: string): Promise<Array<MachineRecord & { online: boolean }>> {
  return (await listMachines(userId)).map((machine) => ({ ...machine, online: registry.isOnline(machine.id) }));
}

function browserRecipients(machineId: string): WebSocket[] {
  const owner = machineOwners.get(machineId);
  return [...browserContexts.entries()].filter(([ws, context]) => ws.readyState === WebSocket.OPEN && context.userId === owner && context.machineId === machineId).map(([ws]) => ws);
}

function broadcastToMachine(machineId: string, message: BridgeMessage): void {
  for (const ws of browserRecipients(machineId)) send(ws, message);
}

function send(ws: WebSocket, message: BridgeMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function addMachineId(params: unknown, machineId: string): unknown {
  return params && typeof params === "object" && !Array.isArray(params) ? { ...(params as Record<string, unknown>), machineId } : params;
}

async function requestSession(request: Request): Promise<AuthSession | null> {
  return auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
}

function isTrustedOrigin(origin: string): boolean {
  if (trustedOrigins.has(origin)) return true;
  try {
    const url = new URL(origin);
    return (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1") && Number(url.port || (url.protocol === "https:" ? 443 : 80)) === port;
  } catch { return false; }
}

function parseAgentAuthorization(value?: string): { machineId: string; secret: string } | null {
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice(7);
  const separator = token.indexOf(".");
  if (separator <= 0) return null;
  return { machineId: token.slice(0, separator), secret: token.slice(separator + 1) };
}

function rejectUpgrade(socket: Duplex, status: number, statusText: string): void {
  socket.write(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function consumePairingAttempt(key: string): boolean {
  const now = Date.now();
  const current = pairingAttempts.get(key);
  if (!current || current.resetAt <= now) { pairingAttempts.set(key, { count: 1, resetAt: now + 10 * 60_000 }); return true; }
  if (current.count >= 20) return false;
  current.count += 1;
  return true;
}

async function main(): Promise<void> {
  await migrateDatabase();
  if (localMachineEnabled) await appServer.start();
  server.listen(port, host, () => console.log(`Codex Mesh listening on http://${host}:${port} (${databaseKind})`));
}

async function shutdown(): Promise<void> {
  clearInterval(heartbeat);
  for (const ws of browserContexts.keys()) ws.close(1001, "Server shutting down");
  registry.closeAll();
  server.close();
  appServer.stop();
  await closeDatabase();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
