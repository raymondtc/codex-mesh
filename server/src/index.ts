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
import ssh2 from "ssh2";
import { auth, type AuthSession } from "./auth.js";
import { AppServerClient } from "./app-server-client.js";
import { closeDatabase, databaseKind, migrateDatabase } from "./db/database.js";
import { createLocalRpcHandler } from "./local-rpc.js";
import { LocalMachineTransport, MachineRegistry, type MachineTransport } from "./machine-registry.js";
import { SshMachineTransport, probeSshHost, type SshCredential } from "./ssh-transport.js";
import { ReverseSshRelay } from "./reverse-ssh-relay.js";
import {
  createSshHost, ensureFirstUserAdmin, ensureLocalMachine, getSshHost, getUserRole, listMachines, listUsers,
  machineBelongsToUser, resolveConversation, revokeMachine, updateMachinePresence,
  updateUserRole, upsertConversation, getUserSettings, updateUserSettings, updateConversationMetadata, deleteConversation,
  enableMachineTunnel, disableMachineTunnel, type MachineRecord, type UserSettings, type ConversationMetadata,
} from "./repository.js";
import type { BridgeMessage, BrowserMessage, RpcRequest } from "./protocol.js";

const { utils: sshUtils } = ssh2;

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);
const codexBin = process.env.CODEX_BIN ?? "codex";
const codexCwd = process.env.CODEX_CWD;
const configuredAppServerUrl = process.env.CODEX_APP_SERVER_URL;
const codexHome = process.env.CODEX_HOME ?? resolve(homedir(), ".codex");
const daemonSocket = resolve(codexHome, "app-server-control/app-server-control.sock");
const appServerUrl = configuredAppServerUrl ?? (existsSync(daemonSocket) ? `unix://${daemonSocket}` : undefined);
const localMachineEnabled = process.env.CODEX_LOCAL_MACHINE !== "off";
const relayEnabled = process.env.RELAY_ENABLED === "1";
const relayHost = process.env.RELAY_HOST ?? "127.0.0.1";
const relayPort = Number(process.env.RELAY_PORT ?? 2222);
const relayPublicHost = process.env.RELAY_PUBLIC_HOST?.trim() || relayHost;
const bridgeVersion = "0.3.0";
const bridgeCapabilities = ["bridge/session/start", "bridge/fs/readDirectory", "bridge/fs/readFile", "bridge/fs/writeFile", "bridge/fs/downloadFile", "bridge/git/worktree/create", "bridge/machine/list", "bridge/machine/select", "bridge/ssh/host/probe", "bridge/ssh/key/generate", "bridge/ssh/host/create", "bridge/ssh/host/test", "bridge/ssh/tunnel/enable", "bridge/ssh/tunnel/disable", "bridge/conversation/resolve", "bridge/conversation/metadata/update"];
const trustedOrigins = new Set((process.env.TRUSTED_ORIGINS ?? process.env.BETTER_AUTH_URL ?? `http://127.0.0.1:${port}`).split(",").map((value) => value.trim()).filter(Boolean));

interface BrowserContext { userId: string; machineId?: string }
interface PendingSshKey { userId: string; credential: SshCredential; publicKey: string; expiresAt: number }

const appServer = new AppServerClient(codexBin, codexCwd, appServerUrl, !configuredAppServerUrl);
const localTransport = new LocalMachineTransport(appServer, createLocalRpcHandler(appServer));
const registry = new MachineRegistry();
const browserContexts = new Map<WebSocket, BrowserContext>();
const machineOwners = new Map<string, string>();
const pendingServerRequests = new Map<string, { machineId: string; requestId: string | number }>();
const browserSessionBySocket = new WeakMap<WebSocket, AuthSession>();
const aliveSockets = new WeakSet<WebSocket>();
const pendingSshKeys = new Map<string, PendingSshKey>();
const machineStartPromises = new Map<string, Promise<MachineTransport>>();
const reverseRelay = relayEnabled ? new ReverseSshRelay({ host: relayHost, port: relayPort, publicHost: relayPublicHost, hostKeyPath: process.env.RELAY_HOST_KEY_PATH }) : undefined;

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

const currentDir = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(currentDir, "../../web/dist");
if (existsSync(staticDir)) {
  app.use(express.static(staticDir, { index: false, maxAge: "1h" }));
  app.get("/{*path}", (_request, response) => response.sendFile(resolve(staticDir, "index.html")));
}

const server = createServer(app);
const browserWss = new WebSocketServer({ noServer: true, maxPayload: 12 * 1024 * 1024 });

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

const heartbeat = setInterval(() => {
  for (const ws of browserContexts.keys()) {
    if (!aliveSockets.has(ws)) { ws.terminate(); continue; }
    aliveSockets.delete(ws);
    ws.ping();
  }
}, 25_000);
heartbeat.unref();

async function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
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
    const startedAt = Date.now();
    try {
      const result = await handleBrowserRpc(context, message.method, message.params);
      if (message.method.startsWith("bridge/fs/")) console.log(`[rpc-timing] ${message.method} ${Date.now() - startedAt}ms`);
      send(ws, { type: "rpcResult", id: message.id, result });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[browser-rpc] ${message.method}: ${detail}`);
      send(ws, { type: "rpcResult", id: message.id, error: { message: detail } });
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
    await requireMachine(context.userId, input.machineId);
    return { machineId: input.machineId, online: true };
  }
  if (method === "bridge/ssh/host/probe") {
    const host = requiredHost(input.host);
    const port = sshPort(input.port);
    return { host, port, hostKeySha256: await probeSshHost(host, port) };
  }
  if (method === "bridge/ssh/key/generate") {
    const keys = sshUtils.generateKeyPairSync("ed25519", { comment: "codex-mesh" });
    const keyId = randomUUID();
    const expiresAt = Date.now() + 15 * 60_000;
    pendingSshKeys.set(keyId, { userId: context.userId, credential: { privateKey: keys.private }, publicKey: keys.public, expiresAt });
    return { keyId, publicKey: keys.public, expiresAt };
  }
  if (method === "bridge/ssh/host/create") return createSshMachine(context, input);
  if (method === "bridge/ssh/host/test") {
    if (typeof input.machineId !== "string") throw new Error("machineId is required");
    const transport = await requireMachine(context.userId, input.machineId);
    const result = await transport.request("model/list", undefined, 30_000);
    return { ok: true, modelCount: Array.isArray((result as { data?: unknown[] })?.data) ? (result as { data: unknown[] }).data.length : null };
  }
  if (method === "bridge/ssh/tunnel/enable") {
    if (typeof input.machineId !== "string" || !await machineBelongsToUser(input.machineId, context.userId)) throw new Error("Machine not found");
    const machine = await getSshHost(context.userId, input.machineId);
    if (!machine) throw new Error("SSH machine not found");
    return createTunnelSetup(context.userId, input.machineId, machine.sshPort ?? 22);
  }
  if (method === "bridge/ssh/tunnel/disable") {
    if (typeof input.machineId !== "string") throw new Error("machineId is required");
    registry.unregister(input.machineId);
    return { disabled: await disableMachineTunnel(context.userId, input.machineId) };
  }
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
    const result = await (await requireMachine(context.userId, conversation.machineId)).request("thread/read", { threadId: conversation.remoteThreadId, includeTurns: false });
    return decorateRpcResult(context.userId, conversation.machineId, "thread/read", result);
  }

  if (method === "bridge/conversation/metadata/update") {
    const machineId = typeof input.__machineId === "string" ? input.__machineId : context.machineId;
    if (!machineId || !await machineBelongsToUser(machineId, context.userId)) throw new Error("Select an available machine first");
    if (typeof input.threadId !== "string") throw new Error("threadId is required");
    if (!["standard", "side", "fork", "worktree"].includes(String(input.kind))) throw new Error("Invalid conversation kind");
    const metadata: ConversationMetadata = {
      kind: input.kind as ConversationMetadata["kind"],
      parentRemoteThreadId: optionalString(input.parentRemoteThreadId),
      mainRoot: optionalString(input.mainRoot),
      worktreePath: optionalString(input.worktreePath),
      branch: optionalString(input.branch),
    };
    return { updated: await updateConversationMetadata(context.userId, machineId, input.threadId, metadata) };
  }

  const machineId = typeof input.__machineId === "string" ? input.__machineId : context.machineId;
  if (!machineId || !await machineBelongsToUser(machineId, context.userId)) throw new Error("Select an available machine first");
  context.machineId = machineId;
  const forwardedParams = { ...input };
  delete forwardedParams.__machineId;
  const result = await (await requireMachine(context.userId, machineId)).request(method, forwardedParams);
  if (method === "thread/delete" && typeof forwardedParams.threadId === "string") await deleteConversation(context.userId, machineId, forwardedParams.threadId);
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

async function requireMachine(userId: string, machineId: string): Promise<MachineTransport> {
  const existing = registry.get(machineId);
  if (existing) return existing;
  const pending = machineStartPromises.get(machineId);
  if (pending) return pending;
  const starting = startMachine(userId, machineId);
  machineStartPromises.set(machineId, starting);
  try { return await starting; }
  finally { if (machineStartPromises.get(machineId) === starting) machineStartPromises.delete(machineId); }
}

async function startMachine(userId: string, machineId: string): Promise<MachineTransport> {
  const host = await getSshHost(userId, machineId);
  if (!host?.sshHost || !host.sshPort || !host.sshUsername || !host.sshHostKeySha256) throw new Error("SSH host not found");
  const transport = new SshMachineTransport({
    host: host.sshHost,
    port: host.sshPort,
    username: host.sshUsername,
    hostKeySha256: host.sshHostKeySha256,
    codexCommand: host.sshCodexCommand ?? "codex app-server --stdio",
    ...(host.connectionMode === "reverse-ssh" ? {
      createSocket: () => {
        if (!reverseRelay) throw new Error("Reverse SSH relay is disabled");
        return reverseRelay.openStream(machineId);
      },
    } : {}),
    ...host.credential,
  });
  transport.on("stderr", (value: string) => process.stderr.write(`[ssh:${machineId}] ${value}`));
  await transport.start();
  registerMachine(host, transport);
  await updateMachinePresence(machineId);
  return transport;
}

async function machineViews(userId: string): Promise<Array<MachineRecord & { online: boolean }>> {
  return (await listMachines(userId)).map((machine) => ({
    ...machine,
    online: registry.isOnline(machine.id) || (machine.connectionMode === "reverse-ssh" && Boolean(reverseRelay?.isOnline(machine.id))),
  }));
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

function rejectUpgrade(socket: Duplex, status: number, statusText: string): void {
  socket.write(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

async function createSshMachine(context: BrowserContext, input: Record<string, unknown>): Promise<MachineRecord & { online: boolean; tunnelSetup?: Awaited<ReturnType<typeof createTunnelSetup>> }> {
  const host = requiredHost(input.host);
  const port = sshPort(input.port);
  const username = requiredSshUsername(input.username);
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 120) : `${username}@${host}`;
  const hostKeySha256 = requiredFingerprint(input.hostKeySha256);
  const connectionMode = input.connectionMode === "reverse-ssh" ? "reverse-ssh" : "direct";
  if (connectionMode === "direct") {
    const probedFingerprint = await probeSshHost(host, port);
    if (probedFingerprint !== hostKeySha256) throw new Error(`SSH host key changed: expected ${hostKeySha256}, received ${probedFingerprint}`);
  } else if (!reverseRelay) {
    throw new Error("Reverse SSH relay is not enabled on this server");
  }

  let credential: SshCredential;
  let publicKey: string | undefined;
  if (typeof input.generatedKeyId === "string") {
    const generated = pendingSshKeys.get(input.generatedKeyId);
    if (!generated || generated.userId !== context.userId || generated.expiresAt < Date.now()) throw new Error("Generated SSH key expired; generate a new key");
    credential = generated.credential;
    publicKey = generated.publicKey;
    pendingSshKeys.delete(input.generatedKeyId);
  } else {
    if (typeof input.privateKey !== "string" || input.privateKey.length < 64 || input.privateKey.length > 128 * 1024) throw new Error("A valid SSH private key is required");
    credential = { privateKey: input.privateKey, ...(typeof input.passphrase === "string" && input.passphrase ? { passphrase: input.passphrase } : {}) };
    publicKey = publicKeyFromPrivate(credential);
  }
  const codexCommand = typeof input.codexCommand === "string" && input.codexCommand.trim() ? input.codexCommand.trim().slice(0, 512) : "codex app-server --stdio";
  if (connectionMode === "direct") {
    const transport = new SshMachineTransport({ host, port, username, hostKeySha256, codexCommand, ...credential });
    try {
      await transport.start();
      await transport.request("model/list", undefined, 30_000);
    } finally {
      transport.close();
    }
  }
  const machine = await createSshHost(context.userId, { name, host, port, username, hostKeySha256, codexCommand, publicKey, ...credential });
  if (connectionMode === "reverse-ssh") return { ...machine, connectionMode, online: false, tunnelSetup: await createTunnelSetup(context.userId, machine.id, port) };
  context.machineId = machine.id;
  return { ...machine, online: false };
}

async function createTunnelSetup(userId: string, machineId: string, targetPort: number) {
  if (!reverseRelay) throw new Error("Reverse SSH relay is not enabled on this server");
  const keys = sshUtils.generateKeyPairSync("ed25519", { comment: `codex-mesh-tunnel-${machineId}` });
  if (!await enableMachineTunnel(userId, machineId, keys.public)) throw new Error("SSH machine not found");
  registry.unregister(machineId);
  const knownHost = relayPort === 22 ? relayPublicHost : `[${relayPublicHost}]:${relayPort}`;
  const installDir = `/etc/codex-mesh/tunnels/${machineId}`;
  return {
    machineId,
    privateKey: keys.private,
    publicKey: keys.public,
    relayHost: relayPublicHost,
    relayPort,
    relayHostKeySha256: reverseRelay.hostKeySha256,
    installDir,
    serviceName: `codex-mesh-tunnel-${machineId}`,
    knownHostsLine: `${knownHost} ${reverseRelay.hostPublicKey}`,
    command: `ssh -NT -i ${installDir}/tunnel_ed25519 -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${installDir}/relay_known_hosts -R 127.0.0.1:0:127.0.0.1:${targetPort} ${machineId}@${relayPublicHost} -p ${relayPort}`,
  };
}

function requiredHost(value: unknown): string {
  if (typeof value !== "string") throw new Error("SSH host is required");
  const host = value.trim();
  if (!host || host.length > 253 || !/^[A-Za-z0-9_.:[\]-]+$/.test(host)) throw new Error("Invalid SSH hostname or IP address");
  return host;
}

function sshPort(value: unknown): number {
  const port = Number(value ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SSH port");
  return port;
}

function requiredSshUsername(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(value)) throw new Error("Invalid SSH username");
  return value;
}

function requiredFingerprint(value: unknown): string {
  const fingerprint = typeof value === "string" ? value.match(/SHA256:[A-Za-z0-9+/]{43}/)?.[0] : undefined;
  if (!fingerprint) throw new Error("Confirm the SSH host-key fingerprint first");
  return fingerprint;
}

function publicKeyFromPrivate(credential: SshCredential): string {
  const parsed = sshUtils.parseKey(credential.privateKey, credential.passphrase);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error(parsed instanceof Error ? `Invalid SSH private key: ${parsed.message}` : "SSH key files containing multiple keys are not supported");
  return `${parsed.type} ${parsed.getPublicSSH().toString("base64")} codex-mesh`;
}

function optionalString(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === "string" && value.length <= 4096 ? value : undefined;
}

async function main(): Promise<void> {
  await migrateDatabase();
  if (localMachineEnabled) await appServer.start();
  if (reverseRelay) await reverseRelay.listen();
  server.listen(port, host, () => console.log(`Codex Mesh listening on http://${host}:${port} (${databaseKind})`));
}

async function shutdown(): Promise<void> {
  clearInterval(heartbeat);
  for (const ws of browserContexts.keys()) ws.close(1001, "Server shutting down");
  registry.closeAll();
  if (reverseRelay) await reverseRelay.close();
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
