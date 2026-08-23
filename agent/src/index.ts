#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { AppServerClient } from "./app-server-client.js";
import { createLocalRpcHandler } from "./local-rpc.js";

const VERSION = "0.1.0";
const execFileAsync = promisify(execFile);
const defaultConfigPath = resolve(process.env.CODEX_MESH_AGENT_CONFIG ?? join(homedir(), ".codex-mesh", "agent.json"));

interface AgentConfig { server: string; machineId: string; credential: string; name: string }

async function main(): Promise<void> {
  const command = process.argv[2] ?? "start";
  if (command === "--version" || command === "version") return void console.log(VERSION);
  if (command === "pair") {
    const server = option("--server");
    const code = option("--code");
    const name = option("--name") ?? hostname();
    if (!server || !code) throw new Error("Usage: codex-mesh pair --server https://mesh.example.com --code XXXX-XXXX");
    const response = await fetch(new URL("/api/agent/pair", server), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name }) });
    const body = await response.json() as { machineId?: string; credential?: string; error?: string };
    if (!response.ok || !body.machineId || !body.credential) throw new Error(body.error ?? `Pairing failed (${response.status})`);
    const config = { server: new URL(server).origin, machineId: body.machineId, credential: body.credential, name };
    await saveConfig(config);
    console.log(`Paired ${name} as ${body.machineId}`);
    if (!process.argv.includes("--no-start")) await runAgent(config);
    return;
  }
  if (command === "start") return runAgent(await loadConfig());
  if (command === "status") { const config = await loadConfig(); console.log(JSON.stringify({ server: config.server, machineId: config.machineId, name: config.name, configured: true }, null, 2)); return; }
  throw new Error(`Unknown command: ${command}`);
}

async function runAgent(config: AgentConfig): Promise<void> {
  const codexHome = process.env.CODEX_HOME ?? resolve(homedir(), ".codex");
  const daemon = resolve(codexHome, "app-server-control/app-server-control.sock");
  const endpoint = process.env.CODEX_APP_SERVER_URL ?? (existsSync(daemon) ? `unix://${daemon}` : undefined);
  const appServer = new AppServerClient(process.env.CODEX_BIN ?? "codex", process.env.CODEX_CWD, endpoint, !process.env.CODEX_APP_SERVER_URL);
  appServer.on("stderr", (value) => process.stderr.write(`[codex] ${value}`));
  await appServer.start();
  const rpc = createLocalRpcHandler(appServer);
  const codexVersion = await execFileAsync(process.env.CODEX_BIN ?? "codex", ["--version"]).then(({ stdout }) => stdout.trim()).catch(() => "unknown");
  let stopped = false;
  let socket: WebSocket | undefined;
  const stop = () => { stopped = true; socket?.close(1000, "Agent stopping"); appServer.stop(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  let attempt = 0;
  while (!stopped) {
    try {
      socket = await connect(config, appServer, rpc, codexVersion);
      attempt = 0;
      await new Promise<void>((resolveClose) => socket?.once("close", () => resolveClose()));
    } catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
    if (!stopped) {
      const delay = Math.min(1000 * 2 ** attempt++, 30_000) + Math.floor(Math.random() * 500);
      console.log(`Reconnecting in ${Math.ceil(delay / 1000)}s…`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    }
  }
}

async function connect(config: AgentConfig, appServer: AppServerClient, rpc: (method: string, params?: unknown) => Promise<unknown>, codexVersion: string): Promise<WebSocket> {
  const url = new URL("/agent/ws", config.server);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${config.machineId}.${config.credential}` }, perMessageDeflate: false });
  await new Promise<void>((resolveOpen, rejectOpen) => { socket.once("open", resolveOpen); socket.once("error", rejectOpen); });
  const send = (message: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
  socket.on("message", (raw) => {
    void (async () => {
      let message: any;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (message.type === "ready") { send({ type: "hello", agentVersion: VERSION, codexVersion, capabilities: ["rpc", "files", "isolated-chat"] }); console.log(`Connected to ${config.server}`); return; }
      if (message.type === "rpc") {
        try { send({ type: "rpcResult", id: message.id, result: await rpc(message.method, message.params) }); }
        catch (error) { send({ type: "rpcResult", id: message.id, error: { message: error instanceof Error ? error.message : String(error) } }); }
      }
      if (message.type === "serverResponse") appServer.respond(message.id, message.result, message.error);
    })();
  });
  appServer.removeAllListeners("notification");
  appServer.removeAllListeners("serverRequest");
  appServer.on("notification", (event: { method: string; params?: unknown }) => send({ type: "event", method: event.method, params: event.params }));
  appServer.on("serverRequest", (request: { id: string | number; method: string; params?: unknown }) => send({ type: "serverRequest", ...request }));
  return socket;
}

async function loadConfig(): Promise<AgentConfig> {
  try { return JSON.parse(await readFile(defaultConfigPath, "utf8")) as AgentConfig; }
  catch { throw new Error(`Agent is not paired. Run: codex-mesh pair --server URL --code CODE`); }
}

async function saveConfig(config: AgentConfig): Promise<void> {
  await mkdir(dirname(defaultConfigPath), { recursive: true, mode: 0o700 });
  await writeFile(defaultConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function option(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
