import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocket } from "ws";

if (process.env.E2E_REAL_CODEX !== "1") {
  throw new Error("Real Codex E2E is opt-in because it incurs model usage. Set E2E_REAL_CODEX=1.");
}

const fileEnv = readEnvFile();
const socketUrl = process.env.E2E_URL ?? fileEnv.E2E_URL ?? "ws://127.0.0.1:8787/ws";
const origin = new URL(socketUrl);
origin.protocol = origin.protocol === "wss:" ? "https:" : "http:";
origin.pathname = "/";
const machineId = required("E2E_SSH_MACHINE_ID");
const model = process.env.E2E_MODEL ?? "gpt-5.6-luna";
const marker = `MESH_OK_${Date.now().toString(36)}`;
const fileMarker = `FILE_${marker}`;
const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XwM9WQAAAABJRU5ErkJggg==";
const cookie = await sessionCookie(origin.origin, fileEnv);
const socket = new WebSocket(socketUrl, { perMessageDeflate: false, headers: { Cookie: cookie, Origin: origin.origin } });
const pending = new Map();
const events = [];
let nextId = 0;
let resolveReady;
const ready = new Promise((resolve) => { resolveReady = resolve; });

socket.on("message", (raw) => {
  const message = JSON.parse(String(raw));
  if (message.type === "ready") resolveReady(message);
  if (message.type === "event") events.push(message);
  if (message.type !== "rpcResult") return;
  const request = pending.get(String(message.id));
  if (!request) return;
  pending.delete(String(message.id));
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
});

await new Promise((resolveOpen, rejectOpen) => { socket.once("open", resolveOpen); socket.once("error", rejectOpen); });
await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("Bridge ready timed out")), 15_000))]);

try {
  const selected = await call("bridge/machine/select", { machineId }, 45_000);
  if (!selected.online) throw new Error("SSH machine did not connect");

  const models = await call("model/list", { includeHidden: false }, 30_000);
  if (!models.data?.some((item) => item.model === model || item.id === model)) {
    throw new Error(`Cheap E2E model is unavailable on the remote Codex account: ${model}`);
  }

  const started = await call("bridge/session/start", { model, approvalPolicy: "never", sandbox: "workspace-write" }, 30_000);
  const threadId = started.thread?.id;
  if (!threadId) throw new Error("thread/start did not return a thread id");

  const goalSet = await call("thread/goal/set", { threadId, objective: `Complete ${marker}`, status: "active", tokenBudget: 20_000 }, 30_000);
  if (goalSet.goal?.objective !== `Complete ${marker}`) throw new Error("Goal set/get E2E failed");

  const uploadedText = await call("bridge/fs/writeFile", { threadId, path: ".codex-mesh-uploads/input.txt", dataBase64: Buffer.from(fileMarker).toString("base64") }, 30_000);
  const uploadedImage = await call("bridge/fs/writeFile", { threadId, path: ".codex-mesh-uploads/pixel.png", dataBase64: tinyPngBase64 }, 30_000);
  const imagePreview = await call("bridge/fs/readFile", { threadId, path: uploadedImage.path }, 30_000);
  if (imagePreview.kind !== "image" || !imagePreview.dataUrl?.startsWith("data:image/png;base64,")) throw new Error("Image upload/preview E2E failed");
  const downloaded = await call("bridge/fs/downloadFile", { threadId, path: uploadedText.path }, 30_000);
  if (Buffer.from(downloaded.dataBase64, "base64").toString() !== fileMarker) throw new Error("File download E2E failed");

  const turn = await call("turn/start", {
    threadId,
    input: [
      { type: "text", text: `Use apply_patch to create e2e-change.txt containing exactly ${fileMarker}, then reply only ${marker}`, text_elements: [] },
      { type: "localImage", path: uploadedImage.absolutePath },
    ],
    model,
    effort: "none",
    approvalPolicy: "never",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  }, 30_000);
  const turnId = turn.turn?.id;
  if (!turnId) throw new Error("turn/start did not return a turn id");
  const completed = await waitForTurn(threadId, turnId, 90_000);
  if (completed.status !== "completed") throw new Error(`Real Codex turn ended as ${completed.status}`);

  const persisted = await call("thread/read", { threadId, includeTurns: true }, 30_000);
  const persistedTurn = persisted.thread?.turns?.find((item) => item.id === turnId);
  const assistantText = persistedTurn?.items?.filter((item) => item.type === "agentMessage").map((item) => item.text ?? "").join("") ?? "";
  if (!assistantText.includes(marker)) throw new Error(`Expected marker was not persisted: ${assistantText.slice(0, 200)}`);
  if (assistantText.length > 240) throw new Error(`E2E response exceeded the token-saving output guard (${assistantText.length} chars)`);

  const changedFile = await call("bridge/fs/readFile", { threadId, path: "e2e-change.txt" }, 30_000);
  if (changedFile.kind !== "text" || changedFile.content.trim() !== fileMarker) throw new Error("Model file-write E2E failed");
  const changeItems = persistedTurn?.items?.filter((item) => item.type === "fileChange") ?? [];
  if (!changeItems.some((item) => item.changes?.some((change) => change.path.endsWith("e2e-change.txt") && change.diff))) throw new Error("File diff E2E failed");

  const forked = await call("thread/fork", { threadId }, 30_000);
  if (!forked.thread?.id || forked.thread.id === threadId) throw new Error("Thread fork E2E failed");
  await call("bridge/conversation/metadata/update", { threadId: forked.thread.id, kind: "fork", parentRemoteThreadId: threadId }, 30_000);
  const side = await call("thread/fork", { threadId, excludeTurns: true }, 30_000);
  if (!side.thread?.id) throw new Error("Side thread fork E2E failed");
  await call("bridge/conversation/metadata/update", { threadId: side.thread.id, kind: "side", parentRemoteThreadId: threadId }, 30_000);
  const listed = await call("thread/list", { limit: 20, sortKey: "updated_at", sortDirection: "desc" }, 30_000);
  const forkView = listed.data?.find((item) => item.id === forked.thread.id);
  const sideView = listed.data?.find((item) => item.id === side.thread.id);
  if (forkView?.conversationKind !== "fork" || sideView?.conversationKind !== "side") throw new Error("Fork/side metadata E2E failed");
  const goalRead = await call("thread/goal/get", { threadId }, 30_000);
  if (goalRead.goal?.objective !== `Complete ${marker}`) throw new Error("Goal persistence E2E failed");
  await call("thread/goal/clear", { threadId }, 30_000);

  let fileCheck = null;
  const remoteCwd = process.env.E2E_REMOTE_CWD ?? fileEnv.E2E_REMOTE_CWD;
  if (remoteCwd) {
    const repositoryThread = await call("thread/start", { cwd: remoteCwd, model, approvalPolicy: "never", sandbox: "read-only" }, 30_000);
    const remoteFile = process.env.E2E_REMOTE_FILE ?? fileEnv.E2E_REMOTE_FILE ?? "README.md";
    const directory = await call("bridge/fs/readDirectory", { threadId: repositoryThread.thread.id, path: "." }, 30_000);
    const file = await call("bridge/fs/readFile", { threadId: repositoryThread.thread.id, path: remoteFile }, 30_000);
    if (!directory.entries?.length || file.kind !== "text") throw new Error("SSH file RPC E2E failed");
    let traversalBlocked = false;
    try { await call("bridge/fs/readFile", { threadId: repositoryThread.thread.id, path: "/etc/hosts" }, 30_000); }
    catch (error) { traversalBlocked = error.message.includes("outside the thread working directory"); }
    if (!traversalBlocked) throw new Error("SSH file traversal guard E2E failed");
    fileCheck = { cwd: remoteCwd, path: remoteFile, entries: directory.entries.length, traversalBlocked };
    await call("thread/archive", { threadId: repositoryThread.thread.id }, 30_000);
  }

  await call("thread/archive", { threadId: side.thread.id }, 30_000);
  await call("thread/archive", { threadId: forked.thread.id }, 30_000);
  await call("thread/archive", { threadId }, 30_000);
  console.log(JSON.stringify({ ok: true, transport: "ssh", machineId, model, effort: "none", threadId, turnId, responseChars: assistantText.length, eventObserved: completed.eventObserved, coverage: { goal: true, fork: true, side: true, diff: true, upload: true, imagePasteInput: true, imagePreview: true, download: true }, files: fileCheck }, null, 2));
} finally {
  socket.close();
}

function call(method, params, timeoutMs = 90_000) {
  const id = String(++nextId);
  return new Promise((resolveCall, rejectCall) => {
    const timer = setTimeout(() => { pending.delete(id); rejectCall(new Error(`RPC timed out: ${method}`)); }, timeoutMs);
    pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
    socket.send(JSON.stringify({ type: "rpc", id, method, params }));
  });
}

async function waitForTurn(threadId, turnId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const index = events.findIndex((message) => message.method === "turn/completed" && message.params?.threadId === threadId && message.params?.turn?.id === turnId);
    if (index >= 0) {
      const [message] = events.splice(index, 1);
      return { status: message.params.turn.status, eventObserved: true };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("Timed out waiting for the real Codex turn");
}

async function sessionCookie(baseUrl, env) {
  const explicit = process.env.E2E_COOKIE ?? env.E2E_COOKIE;
  if (explicit) return explicit;
  const email = process.env.E2E_EMAIL ?? env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD ?? env.E2E_PASSWORD;
  if (!email || !password) throw new Error("Set E2E_EMAIL and E2E_PASSWORD (or E2E_COOKIE)");
  const response = await fetch(new URL("/api/auth/sign-in/email", baseUrl), { method: "POST", headers: { origin: baseUrl, "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!response.ok) throw new Error(`E2E login failed (${response.status})`);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("E2E login did not return a session cookie");
  return cookie;
}

function readEnvFile() {
  try { return Object.fromEntries(readFileSync(resolve(".env"), "utf8").split(/\r?\n/).filter((line) => line && !line.startsWith("#")).map((line) => line.split(/=(.*)/s).slice(0, 2))); }
  catch { return {}; }
}

function required(name) { const value = process.env[name] ?? fileEnv[name]; if (!value) throw new Error(`Set ${name}`); return value; }
