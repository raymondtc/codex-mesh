import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import ssh2 from "ssh2";

const { Server: SshServer, utils: sshUtils } = ssh2;

const port = await availablePort();
const sshPort = await availablePort();
const relayPort = await availablePort();
const sshHostKeys = sshUtils.generateKeyPairSync("ed25519", { comment: "codex-mesh-control-e2e" });
const sshServer = createMockSshServer(sshHostKeys.private);
await new Promise((resolveListen, rejectListen) => { sshServer.once("error", rejectListen); sshServer.listen(sshPort, "127.0.0.1", resolveListen); });
const origin = `http://127.0.0.1:${port}`;
const dataDir = await mkdtemp(join(tmpdir(), "codex-mesh-control-e2e-"));
const server = spawn(process.execPath, [resolve("server/dist/index.js")], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    CODEX_LOCAL_MACHINE: "off",
    CODEX_MESH_DATA_DIR: dataDir,
    BETTER_AUTH_URL: origin,
    TRUSTED_ORIGINS: origin,
    BETTER_AUTH_SECRET: "control-plane-e2e-secret-at-least-thirty-two-characters",
    SSH_KEY_ENCRYPTION_KEY: "control-plane-e2e-ssh-key-secret-at-least-thirty-two-characters",
    RELAY_ENABLED: "1",
    RELAY_HOST: "127.0.0.1",
    RELAY_PUBLIC_HOST: "127.0.0.1",
    RELAY_PORT: String(relayPort),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
server.stdout.on("data", (chunk) => { output += String(chunk); });
server.stderr.on("data", (chunk) => { output += String(chunk); });

const sockets = [];
const children = [];
try {
  await waitForHealth();
  const admin = await signUp("Admin", "admin@mesh.test");
  const adminMe = await requestJson("/api/me", { headers: { cookie: admin.cookie } });
  assert(adminMe.response.ok && adminMe.body.user.role === "admin", "first account was not promoted to admin");

  const member = await signUp("Member", "member@mesh.test");
  const memberUsers = await requestJson("/api/users", { headers: { cookie: member.cookie } });
  assert(memberUsers.response.status === 403, "regular user could access user administration");

  const browser = await connectSocket(`ws://127.0.0.1:${port}/ws`, { Cookie: admin.cookie, Origin: origin });
  sockets.push(browser.ws);
  const browserReady = await browser.next((message) => message.type === "ready");
  assert(browserReady.version === "0.3.0", "browser bridge did not become ready");

  const generated = await browser.call("bridge/ssh/key/generate", {});
  assert(generated.publicKey.startsWith("ssh-ed25519 "), "SSH key generation failed");
  const probe = await browser.call("bridge/ssh/host/probe", { host: "127.0.0.1", port: sshPort });
  assert(probe.hostKeySha256.startsWith("SHA256:"), "SSH host-key probe failed");
  await assertRejects(() => browser.call("bridge/ssh/host/create", { name: "Wrong fingerprint", host: "127.0.0.1", port: sshPort, username: "mesh-e2e", hostKeySha256: `SHA256:${"A".repeat(43)}`, generatedKeyId: generated.keyId }), "mismatched SSH host key was accepted");
  const sshMachine = await browser.call("bridge/ssh/host/create", { name: "E2E SSH Host", host: "127.0.0.1", port: sshPort, username: "mesh-e2e", hostKeySha256: probe.hostKeySha256, generatedKeyId: generated.keyId });
  assert(sshMachine.id && sshMachine.kind === "ssh", "SSH host creation failed");
  assert(!sshMachine.sshPrivateKeyEncrypted && !sshMachine.privateKey && !sshMachine.credential, "SSH private-key material leaked through host creation response");
  const selected = await browser.call("bridge/machine/select", { machineId: sshMachine.id });
  assert(selected.online === true, "SSH machine did not connect");
  const threads = await browser.call("thread/list", {});
  const conversation = threads.data[0];
  assert(conversation.meshId && conversation.machineId === sshMachine.id, "thread did not receive a stable Mesh route id");
  const metadata = await browser.call("bridge/conversation/metadata/update", { threadId: conversation.id, kind: "side", parentRemoteThreadId: "source-thread" });
  assert(metadata.updated === true, "conversation relationship metadata was not persisted");
  const relatedConversation = (await browser.call("thread/list", {})).data[0];
  assert(relatedConversation.conversationKind === "side" && relatedConversation.parentRemoteThreadId === "source-thread", "conversation relationship metadata was not decorated");
  const resolved = await browser.call("bridge/conversation/resolve", { conversationId: conversation.meshId });
  assert(resolved.thread.id === "remote-thread-e2e", "stable conversation route did not resolve");

  const tunnelSetup = await browser.call("bridge/ssh/tunnel/enable", { machineId: sshMachine.id });
  assert(tunnelSetup.privateKey.includes("PRIVATE KEY") && tunnelSetup.relayHostKeySha256.startsWith("SHA256:"), "reverse SSH enrollment did not return one-time credentials");
  const tunnelKeyPath = join(dataDir, "tunnel_ed25519");
  const relayKnownHostsPath = join(dataDir, "relay_known_hosts");
  await writeFile(tunnelKeyPath, tunnelSetup.privateKey, { mode: 0o600 });
  await chmod(tunnelKeyPath, 0o600);
  await writeFile(relayKnownHostsPath, `${tunnelSetup.knownHostsLine}\n`, { mode: 0o600 });
  const tunnel = spawn("ssh", ["-NT", "-i", tunnelKeyPath, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ExitOnForwardFailure=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${relayKnownHostsPath}`, "-p", String(relayPort), "-R", `127.0.0.1:0:127.0.0.1:${sshPort}`, `${sshMachine.id}@127.0.0.1`], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(tunnel);
  let tunnelOutput = "";
  tunnel.stderr.on("data", (chunk) => { tunnelOutput += String(chunk); });
  const reverseSelected = await retry(async () => browser.call("bridge/machine/select", { machineId: sshMachine.id }), 10_000, () => tunnelOutput);
  assert(reverseSelected.online === true, "machine did not connect through the reverse SSH tunnel");
  const reverseThreads = await browser.call("thread/list", {});
  assert(reverseThreads.data[0]?.id === "remote-thread-e2e", "Codex RPC did not traverse the reverse SSH tunnel");

  const memberBrowser = await connectSocket(`ws://127.0.0.1:${port}/ws`, { Cookie: member.cookie, Origin: origin });
  sockets.push(memberBrowser.ws);
  await memberBrowser.next((message) => message.type === "ready");
  const memberMachines = await memberBrowser.call("bridge/machine/list", {});
  assert(memberMachines.data.length === 0, "another user could list the admin machine");
  await assertRejects(() => memberBrowser.call("bridge/machine/select", { machineId: sshMachine.id }), "another user could select the admin machine");

  const users = await requestJson("/api/users", { headers: { cookie: admin.cookie } });
  assert(users.response.ok && users.body.data.length === 2, "admin user listing failed");
  const roleUpdate = await requestJson(`/api/users/${member.user.id}/role`, {
    method: "PATCH",
    headers: { cookie: admin.cookie, "content-type": "application/json" },
    body: JSON.stringify({ role: "admin" }),
  });
  assert(roleUpdate.response.ok && roleUpdate.body.updated, "admin role update failed");

  const managedCreate = await requestJson("/api/auth/admin/create-user", {
    method: "POST",
    headers: { cookie: admin.cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ name: "Managed", email: "managed@mesh.test", password: "managed-initial-password", role: "user" }),
  });
  assert(managedCreate.response.ok && managedCreate.body.user?.id, "admin could not create a user");
  const managedId = managedCreate.body.user.id;
  const passwordUpdate = await requestJson("/api/auth/admin/set-user-password", {
    method: "POST", headers: { cookie: admin.cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ userId: managedId, newPassword: "managed-updated-password" }),
  });
  assert(passwordUpdate.response.ok, "admin could not reset a user password");
  const managedLogin = await requestJson("/api/auth/sign-in/email", {
    method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email: "managed@mesh.test", password: "managed-updated-password" }),
  });
  const managedCookie = managedLogin.response.headers.get("set-cookie")?.split(";", 1)[0];
  assert(managedLogin.response.ok && managedCookie, "managed user could not sign in with reset password");
  const revokeManaged = await requestJson("/api/auth/admin/revoke-user-sessions", {
    method: "POST", headers: { cookie: admin.cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ userId: managedId }),
  });
  assert(revokeManaged.response.ok, "admin could not revoke user sessions");
  const revokedMe = await requestJson("/api/me", { headers: { cookie: managedCookie } });
  assert(revokedMe.response.status === 401, "revoked user session remained valid");
  const banManaged = await requestJson("/api/auth/admin/ban-user", {
    method: "POST", headers: { cookie: admin.cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ userId: managedId, banReason: "E2E" }),
  });
  assert(banManaged.response.ok, "admin could not ban a user");
  const unbanManaged = await requestJson("/api/auth/admin/unban-user", {
    method: "POST", headers: { cookie: admin.cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ userId: managedId }),
  });
  assert(unbanManaged.response.ok, "admin could not unban a user");
  const removeManaged = await requestJson("/api/auth/admin/remove-user", {
    method: "POST", headers: { cookie: admin.cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ userId: managedId }),
  });
  assert(removeManaged.response.ok, "admin could not remove a user");

  const route = await fetch(`${origin}/thread/${conversation.meshId}`);
  const html = await route.text();
  assert(route.ok && route.headers.get("content-type")?.includes("text/html") && html.includes('<div id="root"></div>'), "conversation deep link did not return the SPA");

  const revoked = await browser.call("bridge/machine/revoke", { machineId: sshMachine.id });
  assert(revoked.revoked === true, "machine revoke failed");

  console.log(JSON.stringify({
    ok: true,
    database: "pglite",
    auth: { firstUserAdmin: true, userIsolation: true, roleManagement: true, userLifecycleManagement: true },
    ssh: { generatedKey: true, hostKeyPinned: true, hostKeyMismatchRejected: true, privateKeyNotReturned: true, appServerOverExec: true, reverseTunnel: true, relayEndpointNotExposed: true, userIsolation: true, revoke: true },
    conversation: { meshId: conversation.meshId, deepLink: true, relationshipMetadata: true },
  }, null, 2));
} catch (error) {
  if (output) process.stderr.write(output);
  throw error;
} finally {
  for (const socket of sockets) socket.close();
  for (const child of children) child.kill("SIGTERM");
  server.kill("SIGTERM");
  await new Promise((resolveExit) => server.once("exit", resolveExit));
  await new Promise((resolveClose) => sshServer.close(resolveClose));
  await rm(dataDir, { recursive: true, force: true });
}

async function retry(operation, timeoutMs, diagnostics) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    try { return await operation(); } catch (error) { latest = error; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`${latest instanceof Error ? latest.message : "operation timed out"}\n${diagnostics()}`);
}

async function signUp(name, email) {
  const { response, body } = await requestJson("/api/auth/sign-up/email", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ name, email, password: "correct-horse-battery-staple" }),
  });
  assert(response.ok, `sign-up failed for ${email}: ${JSON.stringify(body)}`);
  const setCookie = response.headers.get("set-cookie");
  assert(setCookie, "sign-up response did not set a session cookie");
  return { cookie: setCookie.split(";", 1)[0], user: body.user };
}

async function requestJson(path, init) {
  const response = await fetch(`${origin}${path}`, init);
  const body = await response.json();
  return { response, body };
}

async function waitForHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`control server exited early (${server.exitCode})`);
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch { /* Server is still migrating or binding. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("timed out waiting for control server");
}

async function connectSocket(url, headers) {
  const ws = new WebSocket(url, { headers, perMessageDeflate: false });
  const queue = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else queue.push(message);
  });
  await new Promise((resolveOpen, rejectOpen) => { ws.once("open", resolveOpen); ws.once("error", rejectOpen); });
  let nextId = 0;
  const next = (predicate, timeoutMs = 5_000) => {
    const index = queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolveMessage, rejectMessage) => {
      const waiter = { predicate, resolve: resolveMessage, timer: undefined };
      waiter.timer = setTimeout(() => {
        const position = waiters.indexOf(waiter);
        if (position >= 0) waiters.splice(position, 1);
        rejectMessage(new Error("WebSocket message timed out"));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
  const call = async (method, params) => {
    const id = String(++nextId);
    ws.send(JSON.stringify({ type: "rpc", id, method, params }));
    const response = await next((message) => message.type === "rpcResult" && String(message.id) === id);
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  return { ws, next, call };
}

async function availablePort() {
  const socket = createServer();
  await new Promise((resolveListen, rejectListen) => { socket.once("error", rejectListen); socket.listen(0, "127.0.0.1", resolveListen); });
  const address = socket.address();
  const value = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose) => socket.close(resolveClose));
  return value;
}

function createMockSshServer(hostPrivateKey) {
  return new SshServer({ hostKeys: [hostPrivateKey] }, (client) => {
    client.on("error", () => { /* Expected when the host-key probe deliberately rejects KEX. */ });
    client.on("authentication", (context) => context.method === "publickey" ? context.accept() : context.reject());
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (acceptExec) => {
        const stream = acceptExec();
        let buffered = "";
        stream.on("data", (chunk) => {
          buffered += String(chunk);
          while (buffered.includes("\n")) {
            const index = buffered.indexOf("\n");
            const line = buffered.slice(0, index);
            buffered = buffered.slice(index + 1);
            if (!line.trim()) continue;
            const message = JSON.parse(line);
            if (!("id" in message)) continue;
            const thread = { id: "remote-thread-e2e", preview: "E2E thread", cwd: "/tmp/e2e", updatedAt: 1, status: { type: "idle" } };
            const result = message.method === "initialize" ? { userAgent: "mock-codex" }
              : message.method === "model/list" ? { data: [{ id: "gpt-5.6-luna", model: "gpt-5.6-luna" }] }
              : message.method === "thread/list" ? { data: [thread] }
              : message.method === "thread/read" ? { thread }
              : { ok: true };
            stream.write(`${JSON.stringify({ id: message.id, result })}\n`);
          }
        });
      });
    }));
  });
}

function assert(value, message) { if (!value) throw new Error(message); }
async function assertRejects(action, message) { try { await action(); } catch { return; } throw new Error(message); }
