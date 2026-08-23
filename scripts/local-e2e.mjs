import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { WebSocket } from "ws";

const envFile = readFileSync(resolve(process.cwd(), ".env"), "utf8");
const fileEnv = Object.fromEntries(envFile.split(/\r?\n/).filter((line) => line && !line.startsWith("#")).map((line) => line.split(/=(.*)/s).slice(0, 2)));
const url = process.env.E2E_URL ?? "ws://127.0.0.1:8787/ws";
const serverOrigin = new URL(url);
serverOrigin.protocol = serverOrigin.protocol === "wss:" ? "https:" : "http:";
serverOrigin.pathname = "/";
serverOrigin.search = "";
serverOrigin.hash = "";
const cookie = await sessionCookie();
const projectRoot = resolve(process.cwd());
const runTurn = process.env.E2E_RUN_TURN !== "0";
const marker = `CODEX_MESH_E2E_OK_${Date.now()}`;

const socket = new WebSocket(url, { perMessageDeflate: false, headers: { Cookie: cookie, Origin: serverOrigin.origin } });
let nextId = 0;
const pending = new Map();
const turnWaiters = new Map();
const streamedText = new Map();
const deliveredUserMessages = new Map();

function call(method, params) {
  return new Promise((resolveCall, rejectCall) => {
    const id = String(++nextId);
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectCall(new Error(`RPC timed out: ${method}`));
    }, 90_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolveCall(value); },
      reject: (error) => { clearTimeout(timer); rejectCall(error); },
    });
    socket.send(JSON.stringify({ type: "rpc", id, method, params }));
  });
}

const ready = new Promise((resolveReady, rejectReady) => {
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === "ready") resolveReady(message);
    if (message.type === "event") {
      const threadId = message.params?.threadId;
      if (message.method === "item/started" && threadId && message.params?.item?.type === "userMessage") {
        const text = message.params.item.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
        deliveredUserMessages.set(threadId, text);
      }
      if (message.method === "item/agentMessage/delta" && threadId) streamedText.set(threadId, (streamedText.get(threadId) ?? "") + (message.params.delta ?? ""));
      if (message.method === "turn/completed" && threadId) {
        const turnId = message.params?.turn?.id;
        const waiter = turnWaiters.get(`${threadId}:${turnId}`);
        if (waiter) {
          turnWaiters.delete(`${threadId}:${turnId}`);
          clearTimeout(waiter.timer);
          waiter.resolve({ status: message.params.turn.status, assistant: streamedText.get(threadId) ?? "" });
        }
      }
    }
    if (message.type !== "rpcResult") return;
    const entry = pending.get(String(message.id));
    if (!entry) return;
    pending.delete(String(message.id));
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  socket.once("error", rejectReady);
});

async function main() {
  const bridgeInfo = await ready;
  if (!bridgeInfo.capabilities?.includes("bridge/session/start")) {
    throw new Error(`Running bridge at ${url} is stale: ${bridgeInfo.version ?? "unknown"} does not expose bridge/session/start`);
  }
  const listedProjects = await call("project/list", { limit: 100 });
  let project = listedProjects.data.find((item) => item.roots.some((root) => root.path === projectRoot));
  if (!project) {
    project = (await call("project/create", {
      name: "Codex Mesh",
      roots: [{ path: projectRoot }],
      metadata: { source: "local-e2e" },
      idempotencyKey: randomUUID(),
    })).project;
  }

  const listedThreads = await call("thread/list", { limit: 100, sortKey: "updated_at", sortDirection: "desc" });
  const explicitSource = process.env.E2E_THREAD_ID;
  const source = explicitSource
    ? listedThreads.data.find((thread) => thread.id === explicitSource)
    : listedThreads.data.find((thread) => thread.cwd === projectRoot && thread.status?.type !== "active")
      ?? listedThreads.data.find((thread) => thread.projectId === project.id && thread.status?.type !== "active");
  if (!source) throw new Error("No non-active source thread found; set E2E_THREAD_ID to a completed local thread");

  if (!source.meshId) throw new Error("Source thread is missing a stable Mesh conversation id");
  const routeUrl = new URL(`/thread/${encodeURIComponent(source.meshId)}`, url);
  routeUrl.protocol = routeUrl.protocol === "wss:" ? "https:" : "http:";
  const routeResponse = await fetch(routeUrl);
  const routeHtml = await routeResponse.text();
  if (!routeResponse.ok || !routeResponse.headers.get("content-type")?.includes("text/html") || !routeHtml.includes('<div id="root"></div>')) {
    throw new Error("Per-thread deep-link route E2E failed");
  }

  const projectRelativeRoot = relative(source.cwd, projectRoot) || ".";
  const readmePath = projectRelativeRoot === "." ? "README.md" : `${projectRelativeRoot}/README.md`;
  const iconPath = projectRelativeRoot === "." ? "web/public/icon.svg" : `${projectRelativeRoot}/web/public/icon.svg`;
  const directory = await call("bridge/fs/readDirectory", { threadId: source.id, path: projectRelativeRoot });
  const readme = await call("bridge/fs/readFile", { threadId: source.id, path: readmePath });
  const image = await call("bridge/fs/readFile", { threadId: source.id, path: iconPath });
  let traversalBlocked = false;
  try {
    await call("bridge/fs/readFile", { threadId: source.id, path: "/etc/hosts" });
  } catch (error) {
    traversalBlocked = error.message.includes("outside the thread working directory");
  }
  if (!directory.entries.some((entry) => entry.name === "README.md")) throw new Error("Directory E2E did not list README.md");
  if (readme.kind !== "text" || !readme.content.startsWith("# Codex Mesh")) throw new Error("Text preview E2E failed");
  if (image.kind !== "image" || !image.dataUrl.startsWith("data:image/svg+xml;base64,")) throw new Error("Image preview E2E failed");
  if (!traversalBlocked) throw new Error("File traversal guard E2E failed");

  const chatSession = (await call("bridge/session/start", {})).thread;
  const isolatedChat = chatSession.cwd.split(/[\\/]/).some((segment) => segment === "codex-mesh-chat-workspaces" || segment === "codex-remote-chat-workspaces") && !chatSession.projectId;
  if (!isolatedChat) throw new Error("Isolated chat session E2E failed");

  let forkResult = null;
  let goalResult = null;
  if (runTurn) {
    let fork;
    try {
      fork = (await call("thread/fork", { threadId: source.id })).thread;
    } catch (error) {
      if (!error.message.includes("excludeTurns")) throw error;
      fork = (await call("thread/fork", { threadId: source.id, excludeTurns: true })).thread;
    }
    const turn = (await call("turn/start", {
      threadId: fork.id,
      input: [{ type: "text", text: `本机 E2E 测试。不要调用工具，只回复：${marker}`, text_elements: [] }],
    })).turn;
    const completed = await new Promise((resolveTurn, rejectTurn) => {
      const key = `${fork.id}:${turn.id}`;
      const timer = setTimeout(() => { if (turnWaiters.delete(key)) rejectTurn(new Error("Timed out waiting for forked turn")); }, 90_000);
      turnWaiters.set(key, { resolve: resolveTurn, timer });
    });
    if (completed.status !== "completed" || !completed.assistant.includes(marker)) throw new Error("Fork/turn E2E failed");
    if (!deliveredUserMessages.get(fork.id)?.includes(marker)) throw new Error("User-message delivery event E2E failed");
    const persistedThread = (await call("thread/read", { threadId: fork.id, includeTurns: true })).thread;
    const persistedTurn = persistedThread.turns.find((item) => item.id === turn.id);
    const persistedUserText = persistedTurn?.items.filter((item) => item.type === "userMessage").flatMap((item) => item.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
    if (!persistedUserText.includes(marker)) throw new Error("Persisted user-message E2E failed");
    const objective = `E2E goal ${marker}`;
    const goal = (await call("thread/goal/set", { threadId: fork.id, objective, status: "active", tokenBudget: 1000 })).goal;
    const readGoal = (await call("thread/goal/get", { threadId: fork.id })).goal;
    if (goal.objective !== objective || readGoal?.objective !== objective || readGoal?.tokenBudget !== 1000) throw new Error("Goal set/get E2E failed");
    const cleared = await call("thread/goal/clear", { threadId: fork.id });
    if (!cleared.cleared || (await call("thread/goal/get", { threadId: fork.id })).goal !== null) throw new Error("Goal clear E2E failed");
    goalResult = { objective, tokenBudget: goal.tokenBudget, setGetClear: true };
    forkResult = { threadId: fork.id, forkedFromId: fork.forkedFromId, turnId: turn.id, status: completed.status, marker, userMessageDelivered: true, userMessagePersisted: true };
    await call("thread/archive", { threadId: fork.id });
  }

  console.log(JSON.stringify({
    ok: true,
    bridge: { url, version: bridgeInfo.version, capabilities: bridgeInfo.capabilities },
    project: { id: project.id, name: project.name, root: project.roots[0]?.path },
    sourceThreadId: source.id,
    route: { path: routeUrl.pathname, deepLink: true },
    chat: { threadId: chatSession.id, isolated: true },
    files: { entries: directory.entries.length, text: readme.path, image: image.path, traversalBlocked },
    fork: forkResult,
    goal: goalResult,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(() => socket.close());

async function sessionCookie() {
  const explicit = process.env.E2E_COOKIE ?? fileEnv.E2E_COOKIE;
  if (explicit) return explicit;
  const email = process.env.E2E_EMAIL ?? fileEnv.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD ?? fileEnv.E2E_PASSWORD;
  if (!email || !password) throw new Error("Set E2E_EMAIL and E2E_PASSWORD (or E2E_COOKIE) for an authenticated local E2E run");
  const response = await fetch(new URL("/api/auth/sign-in/email", serverOrigin), {
    method: "POST",
    headers: { origin: serverOrigin.origin, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`E2E login failed (${response.status}): ${await response.text()}`);
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("E2E login did not return a session cookie");
  return setCookie.split(";", 1)[0];
}
