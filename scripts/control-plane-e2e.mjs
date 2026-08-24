import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";

const port = await availablePort();
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
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
server.stdout.on("data", (chunk) => { output += String(chunk); });
server.stderr.on("data", (chunk) => { output += String(chunk); });

const sockets = [];
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

  const enrollment = await browser.call("bridge/machine/enrollment/create", {});
  const pairResponse = await requestJson("/api/agent/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: enrollment.code, name: "E2E Machine" }),
  });
  assert(pairResponse.response.ok && pairResponse.body.machineId && pairResponse.body.credential, "machine pairing failed");
  const reusedCode = await requestJson("/api/agent/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: enrollment.code, name: "Duplicate" }),
  });
  assert(reusedCode.response.status === 400, "pairing code could be reused");

  const agent = await connectSocket(`ws://127.0.0.1:${port}/agent/ws`, {
    Authorization: `Bearer ${pairResponse.body.machineId}.${pairResponse.body.credential}`,
  });
  sockets.push(agent.ws);
  await agent.next((message) => message.type === "ready");
  agent.ws.send(JSON.stringify({ type: "hello", agentVersion: "e2e", codexVersion: "mock-codex", capabilities: ["rpc"] }));
  agent.ws.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type !== "rpc") return;
    const thread = { id: "remote-thread-e2e", preview: "E2E thread", cwd: "/tmp/e2e", updatedAt: 1, status: { type: "idle" } };
    const result = message.method === "thread/list" ? { data: [thread] } : message.method === "thread/read" ? { thread } : { ok: true };
    agent.ws.send(JSON.stringify({ type: "rpcResult", id: message.id, result }));
  });

  const selected = await browser.call("bridge/machine/select", { machineId: pairResponse.body.machineId });
  assert(selected.online === true, "paired machine was not online");
  const threads = await browser.call("thread/list", {});
  const conversation = threads.data[0];
  assert(conversation.meshId && conversation.machineId === pairResponse.body.machineId, "thread did not receive a stable Mesh route id");
  const metadata = await browser.call("bridge/conversation/metadata/update", { threadId: conversation.id, kind: "side", parentRemoteThreadId: "source-thread" });
  assert(metadata.updated === true, "conversation relationship metadata was not persisted");
  const relatedConversation = (await browser.call("thread/list", {})).data[0];
  assert(relatedConversation.conversationKind === "side" && relatedConversation.parentRemoteThreadId === "source-thread", "conversation relationship metadata was not decorated");
  const resolved = await browser.call("bridge/conversation/resolve", { conversationId: conversation.meshId });
  assert(resolved.thread.id === "remote-thread-e2e", "stable conversation route did not resolve");

  const memberBrowser = await connectSocket(`ws://127.0.0.1:${port}/ws`, { Cookie: member.cookie, Origin: origin });
  sockets.push(memberBrowser.ws);
  await memberBrowser.next((message) => message.type === "ready");
  const memberMachines = await memberBrowser.call("bridge/machine/list", {});
  assert(memberMachines.data.length === 0, "another user could list the admin machine");
  await assertRejects(() => memberBrowser.call("bridge/machine/select", { machineId: pairResponse.body.machineId }), "another user could select the admin machine");

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

  const revoked = await browser.call("bridge/machine/revoke", { machineId: pairResponse.body.machineId });
  assert(revoked.revoked === true, "machine revoke failed");
  await agent.next((_message) => false, 300).catch(() => undefined);
  assert(agent.ws.readyState !== WebSocket.OPEN, "revoked agent remained connected");

  console.log(JSON.stringify({
    ok: true,
    database: "pglite",
    auth: { firstUserAdmin: true, userIsolation: true, roleManagement: true, userLifecycleManagement: true },
    pairing: { oneTimeCode: true, outboundAgent: true, revoke: true },
    conversation: { meshId: conversation.meshId, deepLink: true, relationshipMetadata: true },
  }, null, 2));
} catch (error) {
  if (output) process.stderr.write(output);
  throw error;
} finally {
  for (const socket of sockets) socket.close();
  server.kill("SIGTERM");
  await new Promise((resolveExit) => server.once("exit", resolveExit));
  await rm(dataDir, { recursive: true, force: true });
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

function assert(value, message) { if (!value) throw new Error(message); }
async function assertRejects(action, message) { try { await action(); } catch { return; } throw new Error(message); }
