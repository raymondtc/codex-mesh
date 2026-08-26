import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";

if (process.env.E2E_REAL_CODEX !== "1") throw new Error("Set E2E_REAL_CODEX=1; this test incurs model usage.");

const alias = process.env.E2E_DEVBOX_HOST ?? "devbox";
const controlPort = await availablePort();
const relayPort = await availablePort();
const relayPublicHost = process.env.E2E_RELAY_PUBLIC_HOST ?? lanAddress();
const origin = `http://127.0.0.1:${controlPort}`;
const dataDir = await mkdtemp(join(tmpdir(), "codex-mesh-devbox-e2e-"));
const server = spawn(process.execPath, [resolve("server/dist/index.js")], { cwd: process.cwd(), env: {
  ...process.env, HOST: "127.0.0.1", PORT: String(controlPort), CODEX_LOCAL_MACHINE: "off", CODEX_MESH_DATA_DIR: dataDir,
  BETTER_AUTH_URL: origin, TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "devbox-real-e2e-auth-secret-at-least-thirty-two-characters",
  SSH_KEY_ENCRYPTION_KEY: "devbox-real-e2e-key-secret-at-least-thirty-two-characters",
  RELAY_ENABLED: "1", RELAY_HOST: "0.0.0.0", RELAY_PUBLIC_HOST: relayPublicHost, RELAY_PORT: String(relayPort),
}, stdio: ["ignore", "pipe", "pipe"] });
let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += String(chunk); });
server.stderr.on("data", (chunk) => { serverOutput += String(chunk); });
let socket;
let remoteDirectory;
try {
  await waitForHealth();
  const signup = await requestJson("/api/auth/sign-up/email", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ name: "Devbox E2E", email: "devbox-e2e@mesh.test", password: "correct-horse-battery-staple" }) });
  assert(signup.response.ok, `E2E sign-up failed: ${JSON.stringify(signup.body)}`);
  const cookie = signup.response.headers.get("set-cookie")?.split(";", 1)[0];
  assert(cookie, "E2E sign-up did not return a cookie");
  const bridge = await connectSocket(`ws://127.0.0.1:${controlPort}/ws`, { Cookie: cookie, Origin: origin });
  socket = bridge.ws;
  await bridge.next((message) => message.type === "ready");

  const config = parseSshConfig(await command("ssh", ["-G", alias]));
  const privateKeyPath = process.env.E2E_SSH_PRIVATE_KEY_PATH ?? await firstExisting(config.identityfile.map(expandHome));
  const privateKey = await readFile(privateKeyPath, "utf8");
  const probe = await bridge.call("bridge/ssh/host/probe", { host: config.hostname[0], port: Number(config.port[0]) });
  const machine = await bridge.call("bridge/ssh/host/create", { name: `Real ${alias}`, host: config.hostname[0], port: Number(config.port[0]), username: config.user[0], privateKey, hostKeySha256: probe.hostKeySha256 });
  const tunnel = await bridge.call("bridge/ssh/tunnel/enable", { machineId: machine.id });

  remoteDirectory = `/tmp/codex-mesh-e2e-${Date.now().toString(36)}`;
  await command("ssh", [alias, `umask 077; mkdir -p ${remoteDirectory}`]);
  const localTunnelKey = join(dataDir, "tunnel_ed25519");
  const localKnownHosts = join(dataDir, "relay_known_hosts");
  await writeFile(localTunnelKey, tunnel.privateKey, { mode: 0o600 });
  await writeFile(localKnownHosts, `${tunnel.knownHostsLine}\n`, { mode: 0o600 });
  await command("scp", [localTunnelKey, localKnownHosts, `${alias}:${remoteDirectory}/`]);
  const remoteCommand = `nohup ssh -NT -i ${remoteDirectory}/tunnel_ed25519 -o BatchMode=yes -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${remoteDirectory}/relay_known_hosts -p ${relayPort} -R 127.0.0.1:0:127.0.0.1:22 ${machine.id}@${relayPublicHost} >${remoteDirectory}/tunnel.log 2>&1 </dev/null & echo $! >${remoteDirectory}/tunnel.pid; cat ${remoteDirectory}/tunnel.pid`;
  const tunnelPid = (await command("ssh", [alias, remoteCommand])).trim();
  assert(/^\d+$/.test(tunnelPid), "devbox tunnel did not start");

  await retry(() => bridge.call("bridge/machine/select", { machineId: machine.id }), 15_000);
  await runChild(process.execPath, [resolve("scripts/real-codex-e2e.mjs")], {
    ...process.env, E2E_REAL_CODEX: "1", E2E_URL: `ws://127.0.0.1:${controlPort}/ws`, E2E_COOKIE: cookie,
    E2E_SSH_MACHINE_ID: machine.id, E2E_MODEL: process.env.E2E_MODEL ?? "gpt-5.6-luna",
  });
  console.log(JSON.stringify({ ok: true, client: alias, connection: "reverse-ssh", relayPublicHost, machineId: machine.id }, null, 2));
} catch (error) {
  if (serverOutput) process.stderr.write(serverOutput);
  throw error;
} finally {
  socket?.close();
  if (remoteDirectory) await command("ssh", [alias, `test ! -f ${remoteDirectory}/tunnel.pid || kill $(cat ${remoteDirectory}/tunnel.pid) 2>/dev/null || true; rm -rf ${remoteDirectory}`]).catch(() => {});
  server.kill("SIGTERM");
  await new Promise((resolveExit) => server.once("exit", resolveExit));
  await rm(dataDir, { recursive: true, force: true });
}

async function command(program, args) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = []; const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk)); child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("exit", (code) => code === 0 ? resolveCommand(Buffer.concat(out).toString()) : rejectCommand(new Error(`${program} failed (${code}): ${Buffer.concat(err).toString()}`)));
  });
}

async function runChild(program, args, env) {
  await new Promise((resolveChild, rejectChild) => {
    const child = spawn(program, args, { env, stdio: "inherit" });
    child.on("exit", (code) => code === 0 ? resolveChild() : rejectChild(new Error(`Real Codex E2E failed (${code})`)));
  });
}

async function requestJson(path, init) { const response = await fetch(`${origin}${path}`, init); return { response, body: await response.json() }; }
async function waitForHealth() { await retry(async () => { if (server.exitCode !== null) throw new Error(`server exited (${server.exitCode})`); const response = await fetch(`${origin}/api/health`); if (!response.ok) throw new Error("not ready"); }, 15_000); }
async function retry(operation, timeoutMs) { const deadline = Date.now() + timeoutMs; let latest; while (Date.now() < deadline) { try { return await operation(); } catch (error) { latest = error; } await new Promise((resolveWait) => setTimeout(resolveWait, 150)); } throw latest ?? new Error("operation timed out"); }
async function availablePort() { const socket = createServer(); await new Promise((resolveListen, rejectListen) => { socket.once("error", rejectListen); socket.listen(0, "127.0.0.1", resolveListen); }); const address = socket.address(); const port = typeof address === "object" && address ? address.port : 0; await new Promise((resolveClose) => socket.close(resolveClose)); return port; }
function lanAddress() {
  const addresses = Object.values(networkInterfaces()).flatMap((items) => items ?? []).filter((address) => address.family === "IPv4" && !address.internal);
  return addresses.find((address) => address.address.startsWith("100."))?.address ?? addresses[0]?.address ?? (() => { throw new Error("Set E2E_RELAY_PUBLIC_HOST to an address reachable by devbox"); })();
}
function parseSshConfig(text) { const result = {}; for (const line of text.split(/\r?\n/)) { const match = /^(\S+)\s+(.+)$/.exec(line); if (match) (result[match[1]] ??= []).push(match[2]); } return result; }
function expandHome(path) { return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path; }
async function firstExisting(paths) { for (const path of paths) { try { await access(path); return path; } catch {} } throw new Error("No SSH private key found; set E2E_SSH_PRIVATE_KEY_PATH"); }
function assert(condition, message) { if (!condition) throw new Error(message); }

async function connectSocket(url, headers) {
  const ws = new WebSocket(url, { headers, perMessageDeflate: false }); const queue = []; const waiters = [];
  ws.on("message", (raw) => { const message = JSON.parse(String(raw)); const index = waiters.findIndex((waiter) => waiter.predicate(message)); if (index >= 0) { const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(message); } else queue.push(message); });
  await new Promise((resolveOpen, rejectOpen) => { ws.once("open", resolveOpen); ws.once("error", rejectOpen); }); let nextId = 0;
  const next = (predicate, timeoutMs = 30_000) => { const index = queue.findIndex(predicate); if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]); return new Promise((resolveMessage, rejectMessage) => { const waiter = { predicate, resolve: resolveMessage }; waiter.timer = setTimeout(() => rejectMessage(new Error("WebSocket response timed out")), timeoutMs); waiters.push(waiter); }); };
  const call = async (method, params) => { const id = String(++nextId); ws.send(JSON.stringify({ type: "rpc", id, method, params })); const response = await next((message) => message.type === "rpcResult" && String(message.id) === id, 60_000); if (response.error) throw new Error(response.error.message); return response.result; };
  return { ws, next, call };
}
